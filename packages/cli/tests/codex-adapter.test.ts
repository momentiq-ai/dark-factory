// Cycle 322.7 — Phase A unit tests for the Codex SDK adapter.
//
// Mirrors `tests/grok-adapter.test.ts`: SDK-mock paths (success, retry,
// error, abort), plus shape assertions on the adapter contract and the
// generated JSON schema for the `outputSchema` Codex parameter.
//
// The Codex SDK is mocked via the constructor's `createCodex` factory so
// the tests do not require the `@openai/codex-sdk` runtime nor a live
// CODEX_API_KEY or `codex login`. The mock shape stays narrow on purpose:
// the adapter reads ONLY the surface in `CodexClient` / `CodexThread`
// (declared in `src/adapters/codex-sdk.ts`), so an SDK upgrade that
// changes other surfaces won't silently break the adapter.

import { describe, it, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  expect_eq,
  expect_ne,
  expect_deep,
  expect_match,
  expect_no_match,
  expect_truthy,
  expect_throws,
  expect_rejects,
} from "./_assert-shim.js";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CRITIC_RESULT_JSON_SCHEMA } from "../src/adapters/critic-result-schema.js";
import {
  CODEX_API_KEY_ENV,
  CODEX_HOME_ENV,
  CODEX_SANDBOX_MODES,
  CODEX_SDK_ADAPTER_ID,
  CodexSdkAdapter,
  DEFAULT_SANDBOX_MODE,
  SANDBOX_INIT_FAILURE_CODE,
  detectSandboxInitFailure,
  detectSandboxInitFailureInItems,
  resolveCodexSandboxMode,
  type CodexClient,
  type CodexSandboxMode,
  type CodexThread,
  type CodexTurnResult,
} from "../src/adapters/codex-sdk.js";
import {
  buildErrorResult as _buildErrorResult,
} from "../src/adapters/_shared.js";
import type {
  CriticConfig,
  ReviewPacket,
  TelemetryEvent,
} from "@momentiq/dark-factory-schemas";

void _buildErrorResult; // keep import — verifies shared-helper compatibility

const PACKET: ReviewPacket = {
  repoRoot: "/tmp/repo",
  branch: "main",
  commit: {
    sha: "abcdef0123456789abcdef0123456789abcdef01",
    parent: "0000000000000000000000000000000000000000",
    author: "test",
    email: "test@example.com",
    subject: "test commit",
    body: "",
    timestamp: "2026-05-15T00:00:00Z",
  },
  range: "0000..abcd",
  diffHash: "deadbeef",
  stat: "1 file changed",
  diff: "+ added line\n",
  diffTruncated: false,
  changedFiles: [],
  guidanceFiles: [],
  promptFragments: [],
  validation: {
    requiredQualityGates: [],
    optionalQualityGates: [],
    evidence: [],
    missing: [],
    stale: false,
  },
};

const CRITIC: CriticConfig = {
  id: "codex-local-chief",
  name: "Codex Local Critic",
  adapter: "codex-sdk",
  required: false,
  runtime: "local",
  model: {
    id: "gpt-5.5-codex",
    params: [{ id: "reasoning_effort", value: "high" }],
  },
  // Issue #2103 — adapters now require `critic.auth` (no env-presence
  // fallback). The runner sets this via `applyProfileAuth()` from
  // `profile.auth[critic.id]`; tests bypass the runner so they must
  // declare auth directly on the fixture. Default to "api" since most
  // tests below also set `apiKey: "k"` on the adapter constructor;
  // tests covering subscription behavior override to "chatgpt".
  auth: "api",
};

const APPROVED_RESPONSE_JSON = JSON.stringify({
  status: "complete",
  verdict: "APPROVED",
  requiresHumanJudgment: false,
  summary: "ok",
  findings: [],
  validation: { qualityGateResults: [], qualityGatesMissing: [] },
  confidence: "high",
});

function makeTurn(opts: {
  finalResponse?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  items?: unknown[];
} = {}): CodexTurnResult {
  return {
    finalResponse: opts.finalResponse ?? APPROVED_RESPONSE_JSON,
    items: opts.items ?? [],
    usage:
      opts.inputTokens !== undefined ||
      opts.outputTokens !== undefined ||
      opts.cachedInputTokens !== undefined
        ? {
            input_tokens: opts.inputTokens ?? 0,
            cached_input_tokens: opts.cachedInputTokens ?? 0,
            output_tokens: opts.outputTokens ?? 0,
            reasoning_output_tokens: 0,
          }
        : null,
  };
}

function makeMockClient(impl: {
  run?: (prompt: string, opts: unknown) => Promise<CodexTurnResult>;
  threadId?: string;
  thread?: Partial<CodexThread>;
}): CodexClient {
  let thread: CodexThread;
  return {
    startThread: (_options) => {
      thread = {
        get id() {
          return impl.threadId ?? "thread_test_1";
        },
        run: impl.run ?? (async () => makeTurn()),
        ...impl.thread,
      } as CodexThread;
      return thread;
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter declaration

test("CodexSdkAdapter id is 'codex-sdk'", () => {
  const adapter = new CodexSdkAdapter();
  expect_eq(adapter.id, CODEX_SDK_ADAPTER_ID);
  expect_eq(adapter.id, "codex-sdk");
});

test("CodexSdkAdapter declares requiredEnvVars = [] (auth flexes between subscription + API key)", () => {
  // The Codex SDK supports BOTH auth modes — declaring CODEX_API_KEY as
  // required would force Doppler re-exec even when subscription auth
  // (~/.codex/auth.json) is the intended path. The doctor check validates
  // at least ONE auth source is configured.
  const adapter = new CodexSdkAdapter();
  expect_deep([...adapter.requiredEnvVars], []);
});

// ---------------------------------------------------------------------------
// CRITIC_RESULT_JSON_SCHEMA shape

test("CRITIC_RESULT_JSON_SCHEMA is a valid object with the documented top-level shape", () => {
  // The schema feeds Codex's `outputSchema` parameter. Codex passes it
  // through to the model; the model produces schema-validated JSON in
  // `Turn.finalResponse`. The schema must be (a) a plain object, (b) of
  // type "object", (c) declare additionalProperties: false (OpenAI
  // strict-mode requirement), (d) declare the model-owned fields as
  // required.
  expect_truthy(CRITIC_RESULT_JSON_SCHEMA !== null);
  expect_eq(typeof CRITIC_RESULT_JSON_SCHEMA, "object");
  const schema = CRITIC_RESULT_JSON_SCHEMA as Record<string, unknown>;
  expect_eq(schema["type"], "object");
  expect_eq(schema["additionalProperties"], false);
  const required = schema["required"];
  expect_truthy(Array.isArray(required), "required is an array");
  const requiredFields = required as string[];
  // Under OpenAI strict mode, EVERY property must be in `required`. The
  // Codex adapter only invokes the model on live critic runs and the
  // model is expected to emit `verdict` on completion — listing it as
  // required pushes that validation up to the SDK layer. Adapter-error
  // paths (auth_failed, transport_error) skip the model and use
  // `buildErrorResult` directly, so the strict-required `verdict` does
  // NOT apply on error paths.
  for (const field of [
    "status",
    "verdict",
    "requiresHumanJudgment",
    "summary",
    "findings",
    "validation",
    "confidence",
  ]) {
    expect_truthy(
      requiredFields.includes(field),
      `expected '${field}' in required; got ${JSON.stringify(requiredFields)}`,
    );
  }
  // verdict's type is the non-null ReviewVerdict enum (we want the
  // model to actually pick APPROVED or CHANGES_REQUESTED — not emit null).
  const props = schema["properties"] as Record<string, Record<string, unknown>>;
  const verdictType = props["verdict"]?.["type"];
  expect_eq(
    verdictType,
    "string",
    `verdict.type should be a plain non-nullable string (Zod 'required' field); got ${JSON.stringify(verdictType)}`,
  );
});

test("CRITIC_RESULT_JSON_SCHEMA: status uses the canonical critic-status enum", () => {
  const schema = CRITIC_RESULT_JSON_SCHEMA as Record<string, unknown>;
  const props = schema["properties"] as Record<string, unknown>;
  const status = props["status"] as Record<string, unknown>;
  expect_eq(status["type"], "string");
  expect_deep(status["enum"], ["pending", "running", "complete", "error"]);
});

// ---------------------------------------------------------------------------
// review() — happy path

test("review: schema-valid JSON in turn.finalResponse → success result", async () => {
  const events: TelemetryEvent[] = [];
  let observedPrompt = "";
  let observedOutputSchema: unknown = null;
  let observedThreadOptions: unknown = null;
  let observedCodexConfig: unknown = null;
  const mockClient = makeMockClient({
    run: async (prompt, opts) => {
      observedPrompt = prompt;
      observedOutputSchema = (opts as { outputSchema?: unknown }).outputSchema;
      return makeTurn({
        finalResponse: APPROVED_RESPONSE_JSON,
        inputTokens: 1500,
        outputTokens: 280,
      });
    },
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "test-key",
    createCodex: (opts) => {
      observedCodexConfig = opts.config;
      return {
        startThread: (threadOpts) => {
          observedThreadOptions = threadOpts;
          return mockClient.startThread(threadOpts);
        },
      };
    },
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
    emit: (e) => events.push(e),
  });

  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.criticId, "codex-local-chief");

  // outputSchema was threaded through to the SDK
  expect_eq(
    observedOutputSchema,
    CRITIC_RESULT_JSON_SCHEMA,
    "adapter MUST pass CRITIC_RESULT_JSON_SCHEMA to thread.run({ outputSchema })",
  );

  // Codex constructor config carried the model + reasoning effort + safety knobs
  const codexConfig = observedCodexConfig as Record<string, unknown>;
  expect_eq(codexConfig["model"], "gpt-5.5-codex");
  expect_eq(codexConfig["model_reasoning_effort"], "high");
  expect_eq(codexConfig["show_raw_agent_reasoning"], false);

  // Thread options carry the runtime safety knobs
  const threadOpts = observedThreadOptions as Record<string, unknown>;
  expect_eq(threadOpts["sandboxMode"], "read-only");
  expect_eq(threadOpts["approvalPolicy"], "never");
  expect_eq(threadOpts["networkAccessEnabled"], false);
  expect_eq(threadOpts["workingDirectory"], PACKET.repoRoot);

  // Prompt was compiled via compileCriticPrompt — should mention the critic id
  expect_truthy(observedPrompt.includes("codex-local-chief"));

  // Telemetry — critic_run_started + critic_run_finished, tagged with criticId + adapter
  const started = events.find((e) => e.event === "critic_run_started");
  const finished = events.find((e) => e.event === "critic_run_finished");
  expect_truthy(started, "expected critic_run_started");
  expect_eq(started!.criticId, "codex-local-chief");
  expect_eq(started!.adapter, "codex-sdk");
  expect_eq(started!.model, "gpt-5.5-codex");
  expect_truthy(finished, "expected critic_run_finished");
  expect_eq(finished!.criticId, "codex-local-chief");
  expect_eq(finished!.tokensIn, 1500);
  expect_eq(finished!.tokensOut, 280);
  expect_eq(finished!.retryCount, 0);
});

// Issue #2103 — auth resolution is now strict and profile-driven. The
// adapter honors `critic.auth` ("chatgpt" | "api") with NO fallback to
// the other source. The block below replaces the prior
// "respects CODEX_API_KEY env" test (which encoded the old
// env-presence inference that silently routed local critics to API
// billing). Five distinct behaviors warrant explicit coverage:
//
//   1. auth="api" pins forced_login_method="api" + passes the apiKey
//   2. auth="chatgpt" pins forced_login_method="chatgpt" + WITHHOLDS
//      apiKey from the SDK constructor even when env is set (the
//      whole point of the strict pin: stray CODEX_API_KEY in env
//      must not leak into the SDK call)
//   3. auth=undefined → permanent_failure with the config-fix message
//   4. auth="bogus" (unknown value) → permanent_failure naming the
//      valid set
//   5. auth="api" but no apiKey (env unset + no constructor override)
//      → permanent_failure naming the api mode (not generic "no key")
test("review: auth='api' pins forced_login_method='api' and passes apiKey to SDK", async () => {
  const observedConfigs: Array<Record<string, unknown>> = [];
  const observedApiKeys: Array<string | undefined> = [];
  const mockClient = makeMockClient({});
  const adapter = new CodexSdkAdapter({
    apiKey: "test-api-key-constructor",
    createCodex: (opts) => {
      observedConfigs.push(opts.config as Record<string, unknown>);
      observedApiKeys.push(opts.apiKey);
      return mockClient;
    },
  });
  await adapter.review(PACKET, CRITIC, { blockingSeverities: ["blocker"] });
  expect_eq(observedConfigs[0]?.["forced_login_method"], "api");
  expect_eq(observedApiKeys[0], "test-api-key-constructor");
});

test("review: auth='chatgpt' pins forced_login_method='chatgpt' AND withholds apiKey even when env is set", async () => {
  const observedConfigs: Array<Record<string, unknown>> = [];
  const observedApiKeys: Array<string | undefined> = [];
  const mockClient = makeMockClient({});
  const original = process.env[CODEX_API_KEY_ENV];
  // The safety-net assertion: a stray CODEX_API_KEY (Doppler leaking
  // the CI key into the local shell — exactly what triggered issue
  // #2103) MUST NOT be passed to the SDK constructor when auth is
  // pinned to "chatgpt". The SDK then falls through to
  // ~/.codex/auth.json and bills against the ChatGPT subscription.
  process.env[CODEX_API_KEY_ENV] = "stray-env-key-must-not-leak";
  try {
    const adapter = new CodexSdkAdapter({
      // No `apiKey` constructor override — would have come from env
      // pre-#2103, but strict mode withholds it.
      createCodex: (opts) => {
        observedConfigs.push(opts.config as Record<string, unknown>);
        observedApiKeys.push(opts.apiKey);
        return mockClient;
      },
    });
    const critic: CriticConfig = { ...CRITIC, auth: "chatgpt" };
    await adapter.review(PACKET, critic, { blockingSeverities: ["blocker"] });
    expect_eq(
      observedConfigs[0]?.["forced_login_method"],
      "chatgpt",
      "auth='chatgpt' should pin forced_login_method='chatgpt'",
    );
    expect_eq(
      observedApiKeys[0],
      undefined,
      "auth='chatgpt' MUST NOT pass apiKey to SDK even when env var is set (issue #2103)",
    );
  } finally {
    if (original !== undefined) process.env[CODEX_API_KEY_ENV] = original;
    else delete process.env[CODEX_API_KEY_ENV];
  }
});

test("review: auth=undefined → permanent_failure with config-fix message", async () => {
  const mockClient = makeMockClient({});
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  // Strip auth from the fixture to simulate a runner that never
  // applied `applyProfileAuth` (no profile, no auth pin on this
  // critic). Adapter must surface the config error so the operator
  // fixes the profile instead of being silently routed to either
  // source.
  const critic: CriticConfig = { ...CRITIC };
  delete (critic as { auth?: string }).auth;
  const result = await adapter.review(PACKET, critic, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.retryable, false);
  expect_match(
    result.error?.message ?? "",
    /no auth source pinned/,
    `expected config-fix message; got: ${result.error?.message}`,
  );
  expect_match(
    result.error?.message ?? "",
    /profiles\.<name>\.auth/,
    "message must direct operator to the config path that needs editing",
  );
});

test("review: auth='bogus' (unknown value) → permanent_failure enumerating valid set", async () => {
  const mockClient = makeMockClient({});
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  const critic: CriticConfig = { ...CRITIC, auth: "bogus-value" };
  const result = await adapter.review(PACKET, critic, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.retryable, false);
  expect_match(result.error?.message ?? "", /unsupported auth value "bogus-value"/);
  expect_match(
    result.error?.message ?? "",
    /chatgpt.*api|api.*chatgpt/,
    "error must enumerate the valid auth modes",
  );
});

test("review: auth='api' but CODEX_API_KEY unset → permanent_failure naming the api mode", async () => {
  const mockClient = makeMockClient({});
  const original = process.env[CODEX_API_KEY_ENV];
  delete process.env[CODEX_API_KEY_ENV];
  try {
    const adapter = new CodexSdkAdapter({
      // No `apiKey` constructor override either.
      createCodex: () => mockClient,
    });
    const result = await adapter.review(PACKET, CRITIC, {
      blockingSeverities: ["blocker"],
    });
    expect_eq(result.status, "error");
    expect_eq(result.error?.retryable, false);
    expect_match(
      result.error?.message ?? "",
      /pinned to auth="api"/,
      "message must name the api mode so operator doesn't try `codex login`",
    );
    expect_match(result.error?.message ?? "", new RegExp(CODEX_API_KEY_ENV));
  } finally {
    if (original !== undefined) process.env[CODEX_API_KEY_ENV] = original;
  }
});

test("review: reasoning_effort param threads through (default high, override via critic.model.params)", async () => {
  const observed: string[] = [];
  const mockClient = makeMockClient({});
  for (const effort of ["minimal", "low", "medium", "high", "xhigh"]) {
    const c: CriticConfig = {
      ...CRITIC,
      model: {
        id: "gpt-5.5-codex",
        params: [{ id: "reasoning_effort", value: effort }],
      },
    };
    const adapter = new CodexSdkAdapter({
      apiKey: "k",
      createCodex: (opts) => {
        observed.push(opts.config?.["model_reasoning_effort"] as string);
        return mockClient;
      },
    });
    await adapter.review(PACKET, c, { blockingSeverities: ["blocker"] });
  }
  expect_deep(observed, ["minimal", "low", "medium", "high", "xhigh"]);
});

test("review: default reasoning_effort is 'high' when not specified in critic.model.params", async () => {
  let observed: string | undefined;
  const mockClient = makeMockClient({});
  const c: CriticConfig = {
    ...CRITIC,
    model: { id: "gpt-5.5-codex", params: [] },
  };
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: (opts) => {
      observed = opts.config?.["model_reasoning_effort"] as string;
      return mockClient;
    },
  });
  await adapter.review(PACKET, c, { blockingSeverities: ["blocker"] });
  expect_eq(observed, "high");
});

// ---------------------------------------------------------------------------
// review() — failure paths

test("review: invalid JSON in finalResponse → permanent failure with rawSamplePath written", async () => {
  const mockClient = makeMockClient({
    run: async () => makeTurn({ finalResponse: "not valid json at all" }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  const dir = mkdtempSync(join(tmpdir(), "codex-test-"));
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    diagnosticsDir: dir,
  });
  expect_eq(result.status, "error");
  expect_match(result.error?.message ?? "", /invalid JSON/i);
  expect_truthy(
    result.error?.rawSamplePath,
    "expected rawSamplePath when diagnosticsDir is set",
  );
  expect_truthy(result.error!.rawSamplePath!.startsWith(dir));
});

test("review: SDK throws transient error → retried; succeeds on 3rd attempt", async () => {
  let attemptCount = 0;
  const sleepCalls: number[] = [];
  const mockClient = makeMockClient({
    run: async () => {
      attemptCount++;
      if (attemptCount < 3) {
        throw new Error("transient codex upstream error");
      }
      return makeTurn({ finalResponse: APPROVED_RESPONSE_JSON });
    },
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
    sleep: async (idx) => {
      sleepCalls.push(idx);
    },
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "complete");
  expect_eq(attemptCount, 3, "expected 3 attempts (2 failures + 1 success)");
  expect_deep(sleepCalls, [0, 1]);
});

test("review: SDK throws auth_failed error → permanent failure (no retry)", async () => {
  let attemptCount = 0;
  const events: TelemetryEvent[] = [];
  const mockClient = makeMockClient({
    run: async () => {
      attemptCount++;
      const e = new Error("auth_failed: invalid credentials") as Error & {
        code?: string;
      };
      e.code = "auth_failed";
      throw e;
    },
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
    sleep: async () => {},
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.code, "auth_failed");
  expect_eq(result.error?.retryable, false);
  expect_eq(attemptCount, 1, "auth_failed must NOT retry");
  const errEvent = events.find((e) => e.event === "critic_run_error");
  expect_eq(errEvent?.errorCode, "auth_failed");
});

test("review: SDK throws exhausting all retries → exhausted error result with retryCount=2", async () => {
  let attemptCount = 0;
  const mockClient = makeMockClient({
    run: async () => {
      attemptCount++;
      throw new Error("upstream still broken");
    },
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
    sleep: async () => {},
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  expect_eq(attemptCount, 3);
  expect_eq(result.error?.retryCount, 2);
});

test("review: thrown Error without SDK 'code' field → transient (retried) — transport_error code in telemetry", async () => {
  // The Codex SDK surfaces transport-level errors as plain `Error`
  // instances (no `code` field). `extractCodexErrorCode` returns `null`
  // for these; the adapter classifies them as retryable and tags
  // telemetry with `errorCode: "transport_error"`. After exhausting
  // retries the adapter returns an error result.
  //
  // (For "turn.failed" events SPECIFICALLY: thread.run() flattens the
  // stream and only re-throws on terminal failure — there is no
  // stream-event surface the adapter walks. CodexThreadEvent is
  // exported for future event-aware adapters and tests but is not
  // load-bearing for the current Phase A adapter.)
  let attemptCount = 0;
  const events: TelemetryEvent[] = [];
  const mockClient = makeMockClient({
    run: async () => {
      attemptCount++;
      throw new Error("transient upstream blip");
    },
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
    sleep: async () => {},
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
  });
  // No permanent code → 3 attempts then exhausted error
  expect_eq(result.status, "error");
  expect_eq(attemptCount, 3);
  // Telemetry: every critic_run_error event tagged with transport_error code
  const errEvents = events.filter((e) => e.event === "critic_run_error");
  expect_truthy(errEvents.length >= 1, "expected at least one critic_run_error");
  for (const e of errEvents) {
    expect_eq(
      e.errorCode,
      "transport_error",
      `every transient error should tag transport_error; got ${e.errorCode}`,
    );
    expect_eq(e.status, "run_failure", "transient errors use run_failure status");
  }
});

test("review: AbortSignal aborted before any attempt → result is error with aborted summary", async () => {
  const controller = new AbortController();
  controller.abort();
  const mockClient = makeMockClient({
    run: async () => {
      throw new Error("should not be reached — outer retry loop short-circuits");
    },
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    signal: controller.signal,
  });
  expect_eq(result.status, "error");
  expect_match(result.error?.message ?? "", /aborted/);
});

test("review: thread.id captured and round-tripped to reviewer.runId", async () => {
  const mockClient = makeMockClient({
    threadId: "thread_codex_abc",
    run: async () => makeTurn({ finalResponse: APPROVED_RESPONSE_JSON }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "complete");
  expect_eq(
    result.reviewer.runId,
    "thread_codex_abc",
    "thread.id is the Codex equivalent of a runId — should appear on reviewer.runId",
  );
});

// ---------------------------------------------------------------------------
// doctor()

test("doctor: codex_auth_present passes when ~/.codex/auth.json exists (auth='chatgpt' subscription path)", async () => {
  // Stage a fake CODEX_HOME via env override so the doctor sees a
  // fabricated auth.json without touching the operator's real ~/.codex.
  const dir = mkdtempSync(join(tmpdir(), "codex-doctor-"));
  const authPath = join(dir, "auth.json");
  const fakeAuth = '{"auth_mode": "chatgpt", "tokens": {}}';
  const { writeFileSync } = await import("node:fs");
  writeFileSync(authPath, fakeAuth, "utf8");

  const originalHome = process.env[CODEX_HOME_ENV];
  const originalKey = process.env[CODEX_API_KEY_ENV];
  process.env[CODEX_HOME_ENV] = dir;
  delete process.env[CODEX_API_KEY_ENV];

  try {
    const adapter = new CodexSdkAdapter();
    // Issue #2103 — explicit auth pin so doctor runs the subscription
    // branch (not the legacy any-source path).
    const critic: CriticConfig = { ...CRITIC, auth: "chatgpt" };
    const checks = await adapter.doctor(critic);
    const authCheck = checks.find((c) => c.name === "codex_auth_present");
    expect_truthy(authCheck);
    expect_eq(authCheck!.passed, true);
    expect_match(authCheck!.detail, /subscription auth/);
  } finally {
    if (originalHome !== undefined) process.env[CODEX_HOME_ENV] = originalHome;
    else delete process.env[CODEX_HOME_ENV];
    if (originalKey !== undefined) process.env[CODEX_API_KEY_ENV] = originalKey;
  }
});

test("doctor: auth='chatgpt' but ONLY CODEX_API_KEY set (no subscription) → FAIL even though env has a key (issue #2103)", async () => {
  // This is the regression test for the bug that drove #2103: an
  // environment with CODEX_API_KEY exported (e.g., Doppler leaking the
  // CI key into a local shell) MUST NOT be reported as healthy when
  // the profile pins auth to subscription. Pre-#2103 doctor accepted
  // any of three sources, so the operator was misled into thinking
  // subscription auth was configured when only the API key was.
  const dir = mkdtempSync(join(tmpdir(), "codex-doctor-chatgpt-but-env-"));
  // Do NOT write auth.json (no subscription file)
  const originalHome = process.env[CODEX_HOME_ENV];
  const originalKey = process.env[CODEX_API_KEY_ENV];
  process.env[CODEX_HOME_ENV] = dir;
  process.env[CODEX_API_KEY_ENV] = "stray-env-key-from-doppler";

  try {
    const adapter = new CodexSdkAdapter({
      codexAuthProbe: async () => ({ loggedIn: false, detail: "Not logged in" }),
    });
    const critic: CriticConfig = { ...CRITIC, auth: "chatgpt" };
    const checks = await adapter.doctor(critic);
    const authCheck = checks.find((c) => c.name === "codex_auth_present");
    expect_truthy(authCheck);
    expect_eq(
      authCheck!.passed,
      false,
      "auth='chatgpt' with only env key set MUST fail — subscription is not configured",
    );
    expect_match(authCheck!.detail, /pinned to auth="chatgpt"/);
    expect_match(authCheck!.remediation ?? "", /codex login/);
  } finally {
    if (originalHome !== undefined) process.env[CODEX_HOME_ENV] = originalHome;
    else delete process.env[CODEX_HOME_ENV];
    if (originalKey !== undefined) process.env[CODEX_API_KEY_ENV] = originalKey;
    else delete process.env[CODEX_API_KEY_ENV];
  }
});

test("doctor: codex_auth_present passes when CODEX_API_KEY is set (auth='api' CI path)", async () => {
  // Point CODEX_HOME at a non-existent dir so auth.json check fails;
  // CODEX_API_KEY env should carry the auth-present check.
  const dir = mkdtempSync(join(tmpdir(), "codex-doctor-noauth-"));
  // do NOT write an auth.json into dir
  const originalHome = process.env[CODEX_HOME_ENV];
  const originalKey = process.env[CODEX_API_KEY_ENV];
  process.env[CODEX_HOME_ENV] = dir;
  process.env[CODEX_API_KEY_ENV] = "test-api-key";

  try {
    const adapter = new CodexSdkAdapter();
    // CRITIC already has auth: "api" — exercises the API branch.
    const checks = await adapter.doctor(CRITIC);
    const authCheck = checks.find((c) => c.name === "codex_auth_present");
    expect_truthy(authCheck);
    expect_eq(authCheck!.passed, true);
    expect_match(authCheck!.detail, /API-key auth/);
  } finally {
    if (originalHome !== undefined) process.env[CODEX_HOME_ENV] = originalHome;
    else delete process.env[CODEX_HOME_ENV];
    if (originalKey !== undefined) process.env[CODEX_API_KEY_ENV] = originalKey;
    else delete process.env[CODEX_API_KEY_ENV];
  }
});

test("doctor: codex_auth_present fails with API-specific remediation when auth='api' but CODEX_API_KEY missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-doctor-api-bare-"));
  const originalHome = process.env[CODEX_HOME_ENV];
  const originalKey = process.env[CODEX_API_KEY_ENV];
  process.env[CODEX_HOME_ENV] = dir;
  delete process.env[CODEX_API_KEY_ENV];

  try {
    const adapter = new CodexSdkAdapter({
      codexAuthProbe: async () => ({ loggedIn: false, detail: "Not logged in" }),
    });
    // CRITIC default auth is "api" — exercises the API failure branch.
    const checks = await adapter.doctor(CRITIC);
    const authCheck = checks.find((c) => c.name === "codex_auth_present");
    expect_truthy(authCheck);
    expect_eq(authCheck!.passed, false);
    expect_match(authCheck!.detail, /pinned to auth="api"/);
    // API-specific remediation: do NOT suggest `codex login` (that
    // would mislead operator into wasting time on the wrong auth
    // source). The fix is to provision the env var.
    expect_match(authCheck!.remediation ?? "", new RegExp(CODEX_API_KEY_ENV));
    expect_no_match(
      authCheck!.remediation ?? "",
      /codex login/,
      "api-mode remediation should not suggest codex login",
    );
  } finally {
    if (originalHome !== undefined) process.env[CODEX_HOME_ENV] = originalHome;
    else delete process.env[CODEX_HOME_ENV];
    if (originalKey !== undefined) process.env[CODEX_API_KEY_ENV] = originalKey;
  }
});

test("doctor: auth=undefined (no profile pin) → legacy any-source path preserved (back-compat)", async () => {
  // When no profile context applies `applyProfileAuth` (direct adapter
  // usage, tests, or a config without a `profiles.<name>.auth` map),
  // doctor falls back to the legacy "any of three sources passes"
  // behavior. This preserves the 322.7 contract for non-profile call
  // sites while the strict path applies when auth IS pinned.
  const dir = mkdtempSync(join(tmpdir(), "codex-doctor-legacy-bare-"));
  const originalHome = process.env[CODEX_HOME_ENV];
  const originalKey = process.env[CODEX_API_KEY_ENV];
  process.env[CODEX_HOME_ENV] = dir;
  delete process.env[CODEX_API_KEY_ENV];

  try {
    const adapter = new CodexSdkAdapter({
      codexAuthProbe: async () => ({ loggedIn: false, detail: "Not logged in" }),
    });
    const critic: CriticConfig = { ...CRITIC };
    delete (critic as { auth?: string }).auth;
    const checks = await adapter.doctor(critic);
    const authCheck = checks.find((c) => c.name === "codex_auth_present");
    expect_truthy(authCheck);
    expect_eq(authCheck!.passed, false);
    // Legacy remediation mentions BOTH paths (and the new
    // profile-pinning step).
    expect_match(authCheck!.remediation ?? "", /codex login/);
    expect_match(authCheck!.remediation ?? "", new RegExp(CODEX_API_KEY_ENV));
    expect_match(
      authCheck!.remediation ?? "",
      /profiles\.<name>\.auth/,
      "back-compat remediation must direct operator to pin auth at the profile level",
    );
  } finally {
    if (originalHome !== undefined) process.env[CODEX_HOME_ENV] = originalHome;
    else delete process.env[CODEX_HOME_ENV];
    if (originalKey !== undefined) process.env[CODEX_API_KEY_ENV] = originalKey;
  }
});

test("doctor: codex_sdk_loaded passes when @openai/codex-sdk import succeeds", async () => {
  // The package IS installed in this worktree per Phase A.1 — should succeed.
  const adapter = new CodexSdkAdapter();
  const checks = await adapter.doctor(CRITIC);
  const sdkCheck = checks.find((c) => c.name === "codex_sdk_loaded");
  expect_truthy(sdkCheck);
  expect_eq(sdkCheck!.passed, true);
  expect_match(sdkCheck!.detail, /@openai\/codex-sdk imported/);
});

test("doctor: includes a codex_cli_on_path check", async () => {
  // The check is expected to run a `codex --version` probe via a fixed
  // arg array (no shell). On a workstation with the CLI installed, the
  // check passes; on an environment without it, the check fails with a
  // remediation pointing at the install path.
  const adapter = new CodexSdkAdapter();
  const checks = await adapter.doctor(CRITIC);
  const cliCheck = checks.find((c) => c.name === "codex_cli_on_path");
  expect_truthy(
    cliCheck,
    "doctor must include a codex_cli_on_path check (the SDK spawns the codex CLI)",
  );
  // We don't assert pass/fail here — environment-dependent. We just
  // assert the check has a detail string.
  expect_eq(typeof cliCheck!.detail, "string");
});

// Cycle 322.7 follow-up — #1492 (FAIL semantics) + #1471 P2 #2 (bundled-binary probe)

test("doctor: codex_cli_on_path FAILs with npm-install remediation when neither bundled nor PATH binary works", async () => {
  // #1492 — when the codex CLI binary is missing from PATH AND the
  // bundled SDK binary cannot be resolved, the doctor MUST fail with
  // `npm install -g @openai/codex` as the canonical remediation. Prior
  // to #1492, this check returned INFO regardless of binary presence,
  // which let CI's first real codex invocation fail mid-review instead
  // of at doctor time.
  const adapter = new CodexSdkAdapter({
    codexCliPathResolver: () => null, // bundled binary absent
    execCodex: async () => {
      // PATH probe fails (no codex binary on PATH)
      throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    },
  });
  const checks = await adapter.doctor(CRITIC);
  const cliCheck = checks.find((c) => c.name === "codex_cli_on_path");
  expect_truthy(cliCheck);
  expect_eq(cliCheck!.passed, false);
  expect_match(
    cliCheck!.remediation ?? "",
    /npm install -g @openai\/codex/,
    "remediation must point at npm-global install (per #1489)",
  );
});

test("doctor: codex_cli_on_path probes BUNDLED binary first (resolves via @openai/codex/package.json) — #1471 P2 #2", async () => {
  // #1471 P2 #2 — the SDK bundles its own platform binary in
  // node_modules/@openai/codex-{platform}-{arch}/vendor/.../codex via
  // an optionalDependency. A standard `npm ci` puts it on disk; the SDK
  // resolves it internally via `findCodexPath()`. The doctor should
  // mirror this: try the bundled binary BEFORE falling back to PATH so
  // an `npm ci`-only install satisfies the doctor.
  const fakeBundledPath = "/fake/path/to/codex";
  let probedPath: string | null = null;
  const adapter = new CodexSdkAdapter({
    codexCliPathResolver: () => fakeBundledPath,
    execCodex: async (binPath, _args) => {
      probedPath = binPath;
      return { stdout: "codex-cli 0.130.0\n" };
    },
  });
  const checks = await adapter.doctor(CRITIC);
  const cliCheck = checks.find((c) => c.name === "codex_cli_on_path");
  expect_truthy(cliCheck);
  expect_eq(cliCheck!.passed, true);
  expect_eq(
    probedPath,
    fakeBundledPath,
    "doctor must probe the bundled binary, not the literal 'codex' name on PATH",
  );
  // The detail should disclose which binary was probed (bundled vs PATH)
  // so an operator can debug "doctor says OK but my codex login is wrong path".
  expect_match(cliCheck!.detail, /bundled|@openai\/codex/i);
});

test("doctor: codex_cli_on_path falls back to PATH binary when bundled resolution returns null — #1471 P2 #2", async () => {
  // Fallback path: if the bundled binary cannot be resolved (e.g., a
  // platform-mismatched install, or `npm ci --no-optional`), the doctor
  // should fall back to probing the literal `codex` on PATH.
  let probedPath: string | null = null;
  const adapter = new CodexSdkAdapter({
    codexCliPathResolver: () => null, // bundled absent
    execCodex: async (binPath, _args) => {
      probedPath = binPath;
      return { stdout: "codex-cli 0.125.0\n" }; // workstation Homebrew codex
    },
  });
  const checks = await adapter.doctor(CRITIC);
  const cliCheck = checks.find((c) => c.name === "codex_cli_on_path");
  expect_truthy(cliCheck);
  expect_eq(cliCheck!.passed, true);
  expect_eq(probedPath, "codex", "fallback must probe PATH `codex`");
  expect_match(cliCheck!.detail, /PATH/i);
});

// Cycle 322.7 follow-up — #1471 P2 #1: accept keyring auth via codex login status

test("doctor: codex_auth_present passes when `codex login status` exits 0 (auth='chatgpt', keyring source)", async () => {
  // #1471 P2 #1 — modern Codex CLI uses `cli_auth_credentials_store: auto`
  // which prefers the OS keyring before falling back to ~/.codex/auth.json.
  // A workstation with keyring auth should not fail the doctor check;
  // probing `codex login status` (exits 0 when authenticated regardless
  // of storage backend) is the canonical detector.
  const dir = mkdtempSync(join(tmpdir(), "codex-doctor-keyring-"));
  // do NOT write auth.json into dir
  const originalHome = process.env[CODEX_HOME_ENV];
  const originalKey = process.env[CODEX_API_KEY_ENV];
  process.env[CODEX_HOME_ENV] = dir;
  delete process.env[CODEX_API_KEY_ENV];

  try {
    const adapter = new CodexSdkAdapter({
      // codex login status probe: simulate keyring-backed auth (exits 0
      // with "Logged in using ChatGPT" stdout)
      codexAuthProbe: async () => ({
        loggedIn: true,
        detail: "Logged in using ChatGPT (keyring)",
      }),
    });
    // Issue #2103 — keyring auth is one of two subscription paths,
    // exercised under `auth: "chatgpt"`.
    const critic: CriticConfig = { ...CRITIC, auth: "chatgpt" };
    const checks = await adapter.doctor(critic);
    const authCheck = checks.find((c) => c.name === "codex_auth_present");
    expect_truthy(authCheck);
    expect_eq(
      authCheck!.passed,
      true,
      "keyring-stored auth should be accepted",
    );
    expect_match(
      authCheck!.detail,
      /keyring|login status/i,
      "detail should disclose the keyring/login-status source",
    );
  } finally {
    if (originalHome !== undefined) process.env[CODEX_HOME_ENV] = originalHome;
    else delete process.env[CODEX_HOME_ENV];
    if (originalKey !== undefined) process.env[CODEX_API_KEY_ENV] = originalKey;
  }
});

test("doctor: codex_auth_present fails (with remediation) when auth='chatgpt' and keyring probe says NOT logged in AND no auth.json", async () => {
  // Negative path for #1471 P2 #1 — when subscription sources are
  // exhausted (no ~/.codex/auth.json AND `codex login status` reports
  // not logged in), the check MUST fail under auth="chatgpt". The
  // remediation must direct the operator to `codex login` (not the
  // API-key path).
  const dir = mkdtempSync(join(tmpdir(), "codex-doctor-noauth-all-"));
  const originalHome = process.env[CODEX_HOME_ENV];
  const originalKey = process.env[CODEX_API_KEY_ENV];
  process.env[CODEX_HOME_ENV] = dir;
  delete process.env[CODEX_API_KEY_ENV];

  try {
    const adapter = new CodexSdkAdapter({
      codexAuthProbe: async () => ({ loggedIn: false, detail: "Not logged in" }),
    });
    const critic: CriticConfig = { ...CRITIC, auth: "chatgpt" };
    const checks = await adapter.doctor(critic);
    const authCheck = checks.find((c) => c.name === "codex_auth_present");
    expect_truthy(authCheck);
    expect_eq(authCheck!.passed, false);
    expect_match(authCheck!.remediation ?? "", /codex login/);
  } finally {
    if (originalHome !== undefined) process.env[CODEX_HOME_ENV] = originalHome;
    else delete process.env[CODEX_HOME_ENV];
    if (originalKey !== undefined) process.env[CODEX_API_KEY_ENV] = originalKey;
  }
});

// ---------------------------------------------------------------------------
// Diagnostic write boundary

test("review: invalid JSON respects diagnosticsDir → exactly one file written under the dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-diag-"));
  const mockClient = makeMockClient({
    run: async () => makeTurn({ finalResponse: "garbage" }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    diagnosticsDir: dir,
  });
  // The diagnostic write is via _shared.ts writeRedactedDiagnostic
  // (security-critical boundary). Adapter must NOT call writeFileSync
  // directly — this is enforced by tests/shared-boundary.test.ts.
  // Read the dir; expect at least one *.txt file containing the raw
  // text (redacted).
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(dir);
  expect_truthy(
    files.length >= 1,
    `expected at least one diagnostic file under ${dir}; got ${files.join(", ")}`,
  );
  const txt = readFileSync(join(dir, files[0]!), "utf8");
  expect_match(txt, /garbage/);
});

test("review: rejected output (model returns CHANGES_REQUESTED with findings) parses successfully", async () => {
  const blockerJson = JSON.stringify({
    status: "complete",
    verdict: "CHANGES_REQUESTED",
    requiresHumanJudgment: false,
    summary: "found a blocker",
    findings: [
      {
        severity: "blocker",
        category: "test-coverage",
        file: "src/foo.ts",
        line: 42,
        evidence: "no test exists for src/foo.ts",
        impact: "regression risk",
        requiredFix: "add a unit test under tests/foo.test.ts",
      },
    ],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
  });
  const mockClient = makeMockClient({
    run: async () => makeTurn({ finalResponse: blockerJson }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  expect_eq(result.findings.length, 1);
  expect_eq(result.findings[0]!.severity, "blocker");
});

test("shared-boundary: codex-sdk.ts does not directly call writeFileSync (uses _shared.writeRedactedDiagnostic)", () => {
  // Sanity-check that mirrors tests/shared-boundary.test.ts: confirm the
  // codex adapter delegates diagnostic writes through the shared helper.
  // The boundary test scans every file under src/adapters/; this just
  // adds an inline assertion for clarity / defense-in-depth.
  const __filename = new URL(import.meta.url).pathname;
  // tests/codex-adapter.test.ts → climb one level to packages/cli/
  const root = join(__filename, "..", "..");
  const adapterPath = join(root, "src", "adapters", "codex-sdk.ts");
  const source = readFileSync(adapterPath, "utf8");
  expect_eq(
    /\bwriteFileSync\s*\(/.test(source),
    false,
    "codex-sdk.ts MUST NOT call writeFileSync directly — route through _shared.writeRedactedDiagnostic",
  );
  // Belt-and-suspenders: confirm the adapter imports the shared helper
  expect_match(source, /writeRedactedDiagnostic/);
});

// Sentinel guard: the fixture from Phase A.2 must exist + be valid JSON.
test("fixture: spike-codex-2026-05.json exists and is valid JSON", () => {
  const __filename = new URL(import.meta.url).pathname;
  // tests/codex-adapter.test.ts → climb one level to packages/cli/tests/
  const root = join(__filename, "..");
  const fixturePath = join(root, "fixtures", "spike-codex-2026-05.json");
  expect_truthy(
    existsSync(fixturePath),
    `expected fixture at ${fixturePath} (Phase A.2 spike artifact)`,
  );
  const parsed = JSON.parse(readFileSync(fixturePath, "utf8"));
  // Sanity: this is the SDK shape capture, not arbitrary JSON
  expect_truthy(parsed.sdkVersion);
  expect_truthy(parsed.streamed);
  expect_truthy(parsed.run);
});

// ---------------------------------------------------------------------------
// Issue #1484 — `gate`-field misshape on validation.qualityGateResults
//
// Real-world observation: non-Cursor critics frequently echo the validation
// evidence using a `gate` key instead of the schema-required `command` key.
// Pre-fix, this tripped parseCriticResult inside the adapter and forced a
// permanent_failure even though the validation block is informational and
// is overwritten with deterministic packet evidence after parsing. The fix
// is to route the parsed model JSON through the shared normalizer
// (originally Cursor-only) so the bad entry is dropped at the adapter
// boundary rather than failing the entire run.

const MISSHAPEN_CODEX_GATE_ENTRY = {
  gate: "make sage-quality-gates",
  exitCode: 0,
  durationMs: 1234,
  startedAt: "2026-05-15T00:00:00Z",
  finishedAt: "2026-05-15T00:00:02Z",
  logExcerpt: "ok",
};

const MISSHAPEN_CODEX_RESPONSE_JSON = JSON.stringify({
  status: "complete",
  verdict: "APPROVED",
  requiresHumanJudgment: false,
  summary: "ok with misshapen echo",
  findings: [
    {
      severity: "low",
      category: "other",
      evidence: "soft nit",
      impact: "no functional break",
      requiredFix: "consider polishing later",
    },
  ],
  validation: {
    qualityGateResults: [MISSHAPEN_CODEX_GATE_ENTRY],
    qualityGatesMissing: [],
  },
  confidence: "high",
});

test("review: model emits `gate` instead of `command` in qualityGateResults — adapter drops misshape and result is complete (issue #1484)", async () => {
  const mockClient = makeMockClient({
    run: async () => makeTurn({ finalResponse: MISSHAPEN_CODEX_RESPONSE_JSON }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "test-key",
    createCodex: () => ({ startThread: mockClient.startThread }),
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  // Pre-fix this was `error` with `codex critic JSON failed schema validation`.
  expect_eq(result.status, "complete", "result must NOT be permanent_failure");
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.findings.length, 1);
  // The validation block gets overwritten with packet evidence (empty in
  // this test packet) — ends up empty AND schema-valid.
  expect_eq(result.validation.qualityGateResults.length, 0);
});

// ---------------------------------------------------------------------------
// Cycle 6.3 — per-critic telemetry on the returned CriticResult
// (the EMIT-event payload was previously the only place tokens
// surfaced — this lifts them onto the artifact-shaped result too,
// so the hosted runtime persists + prices them).

test("review: CriticResult carries tokensInput/Output/Cached + retries from turn.usage (success path)", async () => {
  const mockClient = makeMockClient({
    run: async () =>
      makeTurn({
        finalResponse: APPROVED_RESPONSE_JSON,
        inputTokens: 1500,
        outputTokens: 280,
        cachedInputTokens: 4200,
      }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "test-key",
    createCodex: () => ({ startThread: mockClient.startThread }),
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "complete");
  expect_eq(result.tokensInput, 1500);
  expect_eq(result.tokensOutput, 280);
  expect_eq(result.tokensCached, 4200);
  expect_eq(result.retries, 0);
});

test("review: CriticResult omits token fields when turn.usage is null (vendor didn't report)", async () => {
  const mockClient = makeMockClient({
    run: async () => makeTurn({ finalResponse: APPROVED_RESPONSE_JSON }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "test-key",
    createCodex: () => ({ startThread: mockClient.startThread }),
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "complete");
  expect_eq(result.tokensInput, undefined);
  expect_eq(result.tokensOutput, undefined);
  expect_eq(result.tokensCached, undefined);
  // retries is still stamped on the success path (zero retries = first
  // attempt succeeded). It's the canonical "this critic ran cleanly"
  // counter, independent of vendor usage reporting.
  expect_eq(result.retries, 0);
});

test("review: CriticResult populates tokensInput/Output but not tokensCached when vendor omits cached_input_tokens", async () => {
  // Vendors that report input/output but no separate cached count
  // (e.g., gemini's usageMetadata, grok-direct's response.usage).
  // The codex SDK always reports a `cached_input_tokens` number, so
  // this test exercises the field-presence guard semantics: only
  // numbers populate; absence stays absent.
  const mockClient = makeMockClient({
    run: async () => ({
      finalResponse: APPROVED_RESPONSE_JSON,
      items: [],
      usage: {
        input_tokens: 800,
        // cached_input_tokens intentionally omitted to simulate
        // vendor that doesn't break it out
        output_tokens: 120,
        reasoning_output_tokens: 0,
      } as unknown as CodexTurnResult["usage"],
    }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "test-key",
    createCodex: () => ({ startThread: mockClient.startThread }),
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.tokensInput, 800);
  expect_eq(result.tokensOutput, 120);
  expect_eq(result.tokensCached, undefined);
});

// ---------------------------------------------------------------------------
// Issue #68 — sandbox_mode opt-in for hosted/trusted-container contexts
//
// The codex CLI's bwrap-based read-only sandbox fails at startup on GKE
// Autopilot (no SYS_ADMIN cap, so `clone(CLONE_NEWUSER)` is rejected). The
// hosted W3 worker pod is the security boundary (read-only rootfs, non-root,
// dropped caps, per-job emptyDir workspace, egress via Cloud NAT) — strictly
// stronger isolation than bwrap could provide inside the container. The
// adapter must expose `sandboxMode` (matching `@openai/codex-sdk`'s
// SandboxMode enum: "read-only" | "workspace-write" | "danger-full-access")
// so operators opt into a relaxed host-level sandbox when the container
// IS the security boundary. Default unchanged — `read-only` keeps
// defense-in-depth on developer workstations.

test("CODEX_SANDBOX_MODES enumerates the @openai/codex-sdk SandboxMode union", () => {
  expect_deep([...CODEX_SANDBOX_MODES], ["read-only", "workspace-write", "danger-full-access"]);
});

test("DEFAULT_SANDBOX_MODE is 'read-only' (unchanged default for local-workstation usage)", () => {
  expect_eq(DEFAULT_SANDBOX_MODE, "read-only");
});

test("resolveCodexSandboxMode returns 'read-only' when sandbox_mode param is absent", () => {
  const c: CriticConfig = {
    ...CRITIC,
    model: { id: "gpt-5.5-codex", params: [] },
  };
  expect_eq(resolveCodexSandboxMode(c), "read-only");
});

test("resolveCodexSandboxMode returns the param value when set to a valid SandboxMode", () => {
  for (const mode of ["read-only", "workspace-write", "danger-full-access"] as const) {
    const c: CriticConfig = {
      ...CRITIC,
      model: { id: "gpt-5.5-codex", params: [{ id: "sandbox_mode", value: mode }] },
    };
    expect_eq(resolveCodexSandboxMode(c), mode);
  }
});

test("resolveCodexSandboxMode falls back to 'read-only' when sandbox_mode value is invalid (typo guard)", () => {
  // An unrecognized value (typo) MUST fall back to the safe default rather
  // than corrupting the SDK call. Mirrors resolveCodexReasoningEffort's
  // typo-tolerance posture.
  const c: CriticConfig = {
    ...CRITIC,
    model: { id: "gpt-5.5-codex", params: [{ id: "sandbox_mode", value: "danger-mode-bogus" }] },
  };
  expect_eq(resolveCodexSandboxMode(c), "read-only");
});

test("resolveCodexSandboxMode falls back to 'read-only' when sandbox_mode value is a non-string (number/boolean)", () => {
  for (const value of [1 as number, true as boolean] as const) {
    const c: CriticConfig = {
      ...CRITIC,
      model: { id: "gpt-5.5-codex", params: [{ id: "sandbox_mode", value }] },
    };
    expect_eq(resolveCodexSandboxMode(c), "read-only");
  }
});

test("review: default behavior unchanged — when sandbox_mode is absent, adapter passes sandboxMode: 'read-only'", async () => {
  let observedThreadOptions: unknown = null;
  const mockClient = makeMockClient({});
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => ({
      startThread: (threadOpts) => {
        observedThreadOptions = threadOpts;
        return mockClient.startThread(threadOpts);
      },
    }),
  });
  await adapter.review(PACKET, CRITIC, { blockingSeverities: ["blocker"] });
  const opts = observedThreadOptions as Record<string, unknown>;
  expect_eq(
    opts["sandboxMode"],
    "read-only",
    "default sandbox mode MUST remain 'read-only' for back-compat with existing configs",
  );
});

test("review: sandbox_mode='danger-full-access' is threaded into codex.startThread({sandboxMode}) — issue #68", async () => {
  let observedThreadOptions: unknown = null;
  const mockClient = makeMockClient({});
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => ({
      startThread: (threadOpts) => {
        observedThreadOptions = threadOpts;
        return mockClient.startThread(threadOpts);
      },
    }),
  });
  const c: CriticConfig = {
    ...CRITIC,
    model: {
      id: "gpt-5.5-codex",
      params: [{ id: "sandbox_mode", value: "danger-full-access" }],
    },
  };
  await adapter.review(PACKET, c, { blockingSeverities: ["blocker"] });
  const opts = observedThreadOptions as Record<string, unknown>;
  expect_eq(
    opts["sandboxMode"],
    "danger-full-access",
    "adapter MUST pass configured sandbox_mode through to codex.startThread() — closes #68",
  );
});

test("review: sandbox_mode='workspace-write' is threaded through (covers the third SandboxMode variant)", async () => {
  let observedThreadOptions: unknown = null;
  const mockClient = makeMockClient({});
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => ({
      startThread: (threadOpts) => {
        observedThreadOptions = threadOpts;
        return mockClient.startThread(threadOpts);
      },
    }),
  });
  const c: CriticConfig = {
    ...CRITIC,
    model: {
      id: "gpt-5.5-codex",
      params: [{ id: "sandbox_mode", value: "workspace-write" }],
    },
  };
  await adapter.review(PACKET, c, { blockingSeverities: ["blocker"] });
  const opts = observedThreadOptions as Record<string, unknown>;
  expect_eq(opts["sandboxMode"], "workspace-write");
});

test("review: emits sandbox_mode_overridden telemetry when sandbox_mode differs from default", async () => {
  const events: TelemetryEvent[] = [];
  const mockClient = makeMockClient({});
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  const c: CriticConfig = {
    ...CRITIC,
    model: {
      id: "gpt-5.5-codex",
      params: [{ id: "sandbox_mode", value: "danger-full-access" }],
    },
  };
  await adapter.review(PACKET, c, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
  });
  const overrideEvent = events.find((e) => e.event === "sandbox_mode_overridden");
  expect_truthy(
    overrideEvent,
    "expected sandbox_mode_overridden event when value differs from read-only",
  );
  expect_eq(overrideEvent!.criticId, "codex-local-chief");
  expect_eq(overrideEvent!.adapter, "codex-sdk");
  expect_eq(overrideEvent!.commit, PACKET.commit.sha);
  expect_eq(
    overrideEvent!.sandboxMode,
    "danger-full-access",
    "telemetry must carry the resolved sandbox mode for audit",
  );
});

test("review: does NOT emit sandbox_mode_overridden when sandbox_mode is absent (default path)", async () => {
  const events: TelemetryEvent[] = [];
  const mockClient = makeMockClient({});
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
  });
  const overrideEvent = events.find((e) => e.event === "sandbox_mode_overridden");
  expect_eq(
    overrideEvent,
    undefined,
    "the override event MUST NOT fire on the default path (no operator opt-in)",
  );
});

test("review: does NOT emit sandbox_mode_overridden when sandbox_mode is explicitly 'read-only' (matches default)", async () => {
  const events: TelemetryEvent[] = [];
  const mockClient = makeMockClient({});
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  const c: CriticConfig = {
    ...CRITIC,
    model: {
      id: "gpt-5.5-codex",
      params: [{ id: "sandbox_mode", value: "read-only" }],
    },
  };
  await adapter.review(PACKET, c, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
  });
  const overrideEvent = events.find((e) => e.event === "sandbox_mode_overridden");
  expect_eq(
    overrideEvent,
    undefined,
    "explicit read-only is functionally equivalent to default — no override event",
  );
});

test("review: emits sandbox_mode_overridden ONCE per critic run even when retries occur", async () => {
  // Operators correlate the override against critic_run_started; firing it
  // per attempt would inflate the audit log and obscure retry behavior.
  const events: TelemetryEvent[] = [];
  let attemptCount = 0;
  const mockClient = makeMockClient({
    run: async () => {
      attemptCount++;
      if (attemptCount < 3) {
        throw new Error("transient codex upstream error");
      }
      return makeTurn({ finalResponse: APPROVED_RESPONSE_JSON });
    },
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
    sleep: async () => {},
  });
  const c: CriticConfig = {
    ...CRITIC,
    model: {
      id: "gpt-5.5-codex",
      params: [{ id: "sandbox_mode", value: "danger-full-access" }],
    },
  };
  await adapter.review(PACKET, c, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
  });
  const overrideEvents = events.filter((e) => e.event === "sandbox_mode_overridden");
  expect_eq(overrideEvents.length, 1, "override event MUST be emitted exactly once per run");
});

test("CodexSandboxMode type alias matches the runtime enum (compile-time pact)", () => {
  // Just exercise the type to ensure import surfaces compile — runtime
  // assertion redundantly checks the list shape.
  const m: CodexSandboxMode = "read-only";
  expect_truthy((CODEX_SANDBOX_MODES as readonly string[]).includes(m));
});

// ---------------------------------------------------------------------------
// Issue #109 — sandbox-init failure detection + degrade to status:error
//
// When the codex CLI's underlying sandbox primitive (bwrap, landlock)
// cannot initialize (e.g., GKE Autopilot without SYS_ADMIN, container
// OOM, etc.), every shell command the model executes returns with the
// environmental error citation in its `aggregated_output`. The model,
// unable to actually read the diff, fabricates a `[blocker] contracts`
// CHANGES_REQUESTED finding citing the failure. Other critics in the
// same quorum APPROVED — but veto-quorum semantics fail-closed on the
// codex's bogus verdict.
//
// Fix: detect environmental sandbox-init failures and emit
// `status: error` (with the failure detail) instead of `status: complete`
// with the fake finding. Under `min-complete-quorum` with
// `required: false` on codex, `error` is non-blocking; fake
// CHANGES_REQUESTED blocks the merge queue.
//
// Detection is CONSERVATIVE — only KNOWN environmental error signatures
// match (see SANDBOX_INIT_FAILURE_PATTERNS in src/adapters/codex-sdk.ts).
// Arbitrary stderr does NOT classify as environmental — that would
// silently swallow real findings.

const BWRAP_NAMESPACE_FAILURE = "bwrap: No permissions to create a new namespace";
const BWRAP_SECCOMP_FAILURE = "bwrap: Setting up seccomp failed";
const BWRAP_UID_FAILURE = "bwrap: setting up uid map: Permission denied";
const LANDLOCK_FAILURE = "landlock_create_ruleset: Operation not permitted";

test("detectSandboxInitFailure matches the canonical bwrap namespace citation", () => {
  expect_eq(
    detectSandboxInitFailure(BWRAP_NAMESPACE_FAILURE),
    BWRAP_NAMESPACE_FAILURE,
    "the bwrap namespace failure from issue #109 must trigger detection",
  );
});

test("detectSandboxInitFailure matches all four canonical environmental signatures", () => {
  for (const citation of [
    BWRAP_NAMESPACE_FAILURE,
    BWRAP_SECCOMP_FAILURE,
    BWRAP_UID_FAILURE,
    LANDLOCK_FAILURE,
  ]) {
    expect_truthy(
      detectSandboxInitFailure(citation),
      `expected detection for: ${citation}`,
    );
  }
});

test("detectSandboxInitFailure returns the matched line trimmed from surrounding noise", () => {
  // The model frequently embeds the bwrap line inside a multi-line
  // finding annotation; the detector should return just the matched
  // line so the error envelope's detail message stays focused.
  const wrapped =
    "The attempted read commands failed with the following output:\n" +
    `   ${BWRAP_NAMESPACE_FAILURE}\n` +
    "I therefore cannot verify the contracts surface and must reject.\n";
  expect_eq(
    detectSandboxInitFailure(wrapped),
    BWRAP_NAMESPACE_FAILURE,
    "detector must return the trimmed matched LINE, not the entire blob",
  );
});

test("detectSandboxInitFailure returns null on benign text that mentions 'bwrap' or 'namespace' incidentally", () => {
  // Anchored regexes — arbitrary diff content that happens to mention
  // 'namespace' or 'bwrap' in passing must NOT trip detection. Real
  // findings citing K8s namespaces, TypeScript namespaces, bwrap config
  // discussions, etc. must pass through as legitimate findings.
  for (const benign of [
    "The K8s namespace `prod-1` does not exist.",
    "Consider extracting this into a TypeScript namespace.",
    "The new bwrap config requires CAP_SYS_ADMIN.",
    "ENOENT spawn bwrap — install bubblewrap first.",
    "Operation not permitted on /etc/shadow",
    "Permission denied reading /var/log/secure",
    "",
    "ok",
  ]) {
    expect_eq(
      detectSandboxInitFailure(benign),
      null,
      `benign text should NOT match: ${benign}`,
    );
  }
});

test("detectSandboxInitFailureInItems scans command_execution.aggregated_output across items", () => {
  // The bwrap failure surfaces in the `aggregated_output` of every
  // command_execution item the model issues. The detector walks the
  // turn's items[] and returns the first matching citation found.
  const items = [
    { id: "item_0", type: "agent_message", text: "let me read the diff" },
    {
      id: "item_1",
      type: "command_execution",
      command: "/bin/zsh -lc 'git diff HEAD~1'",
      aggregated_output: BWRAP_NAMESPACE_FAILURE,
      exit_code: 1,
      status: "completed",
    },
    {
      id: "item_2",
      type: "command_execution",
      command: "/bin/zsh -lc 'cat README.md'",
      aggregated_output: BWRAP_NAMESPACE_FAILURE,
      exit_code: 1,
      status: "completed",
    },
  ];
  expect_eq(detectSandboxInitFailureInItems(items), BWRAP_NAMESPACE_FAILURE);
});

test("detectSandboxInitFailureInItems returns null when no command_execution item cites a failure", () => {
  const items = [
    { id: "item_0", type: "agent_message", text: "approved" },
    {
      id: "item_1",
      type: "command_execution",
      command: "/bin/zsh -lc 'git diff HEAD~1'",
      aggregated_output: "+ added line\n- removed line\n",
      exit_code: 0,
      status: "completed",
    },
  ];
  expect_eq(detectSandboxInitFailureInItems(items), null);
});

test("detectSandboxInitFailureInItems skips malformed items (defense in depth)", () => {
  // Items with unexpected shapes (null, missing fields, non-string
  // aggregated_output) must not crash the detector.
  const items = [
    null,
    "stringy",
    { type: "command_execution" }, // missing aggregated_output
    { type: "command_execution", aggregated_output: 42 }, // wrong type
    { type: "other_type", aggregated_output: BWRAP_NAMESPACE_FAILURE }, // wrong type
  ];
  expect_eq(detectSandboxInitFailureInItems(items as unknown[]), null);
});

test("review: model fabricates CHANGES_REQUESTED citing bwrap in finalResponse → adapter degrades to status:error (issue #109)", async () => {
  // This is the canonical issue #109 scenario: a hosted W3 worker's
  // bwrap sandbox fails at startup, every diff-read attempt returns the
  // bwrap citation, and the model fabricates a "blocker" finding citing
  // the unread diff. The adapter MUST detect the environmental failure
  // and emit status:error so the quorum aggregator can degrade per
  // policy instead of admitting the fabricated CHANGES_REQUESTED.
  const fabricatedFindingJson = JSON.stringify({
    status: "complete",
    verdict: "CHANGES_REQUESTED",
    requiresHumanJudgment: false,
    summary: "Cannot verify contracts — diff is unreadable.",
    findings: [
      {
        severity: "blocker",
        category: "contracts",
        file: "README.md",
        line: 138,
        evidence:
          `the attempted read commands failed with \`${BWRAP_NAMESPACE_FAILURE}\``,
        impact: "cannot verify the contracts surface",
        requiredFix: "rerun in an environment with a working sandbox",
      },
    ],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
  });
  const events: TelemetryEvent[] = [];
  const mockClient = makeMockClient({
    run: async () => makeTurn({ finalResponse: fabricatedFindingJson }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
    sleep: async () => {},
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
    emit: (e) => events.push(e),
  });
  expect_eq(
    result.status,
    "error",
    "MUST degrade to status:error instead of admitting the fabricated CHANGES_REQUESTED",
  );
  expect_eq(result.verdict, undefined, "no verdict on error path");
  expect_eq(result.findings.length, 0, "no findings on error path");
  expect_eq(
    result.error?.code,
    SANDBOX_INIT_FAILURE_CODE,
    "error envelope MUST carry the sandbox_init_failure code so operators can grep _runs.ndjson",
  );
  expect_eq(
    result.error?.retryable,
    false,
    "sandbox init failure is environmental — retrying inside the same broken container wastes budget",
  );
  expect_match(
    result.error?.message ?? "",
    /bwrap: No permissions to create a new namespace/,
    "error detail MUST cite the literal environmental error so operators can debug the container",
  );
  const errEvent = events.find(
    (e) => e.event === "critic_run_error" && e.errorCode === SANDBOX_INIT_FAILURE_CODE,
  );
  expect_truthy(
    errEvent,
    "telemetry MUST emit a critic_run_error tagged sandbox_init_failure for runbook grep",
  );
});

test("review: bwrap citation in command_execution.aggregated_output → adapter degrades to status:error even if finalResponse looks clean", async () => {
  // Stronger variant of the issue #109 scenario: the model might emit
  // a syntactically-clean JSON envelope (e.g., approved-looking final
  // response after partial recovery) while the underlying tool calls
  // returned bwrap citations in their outputs. The item scan is the
  // primary detection point — if any command the model issued failed
  // with a sandbox-init citation, the entire run cannot be trusted.
  const mockClient = makeMockClient({
    run: async () =>
      makeTurn({
        finalResponse: APPROVED_RESPONSE_JSON,
        items: [
          {
            id: "item_0",
            type: "command_execution",
            command: "/bin/zsh -lc 'git diff'",
            aggregated_output: BWRAP_NAMESPACE_FAILURE,
            exit_code: 1,
            status: "completed",
          },
        ],
      }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
    sleep: async () => {},
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.code, SANDBOX_INIT_FAILURE_CODE);
  expect_match(result.error?.message ?? "", /command_execution/);
});

test("review: SDK throws Error whose message cites bwrap → adapter classifies as permanent sandbox_init_failure (no retries)", async () => {
  // Alternative failure shape: the SDK itself raises an Error with the
  // bwrap citation in `.message` (e.g., subprocess startup detects the
  // bwrap failure before any command_execution stream is emitted). The
  // adapter must classify as permanent + non-retryable + tag the
  // sandbox_init_failure code — NOT retry into the same broken
  // container 3x and waste 20s of budget.
  let attemptCount = 0;
  const events: TelemetryEvent[] = [];
  const mockClient = makeMockClient({
    run: async () => {
      attemptCount++;
      throw new Error(
        `codex CLI subprocess died: ${BWRAP_NAMESPACE_FAILURE}\n  at codex_sandbox::init`,
      );
    },
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
    sleep: async () => {},
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
    emit: (e) => events.push(e),
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.code, SANDBOX_INIT_FAILURE_CODE);
  expect_eq(result.error?.retryable, false);
  expect_eq(
    attemptCount,
    1,
    "sandbox_init_failure is permanent — no retries against the same broken container",
  );
  const errEvent = events.find(
    (e) => e.event === "critic_run_error" && e.errorCode === SANDBOX_INIT_FAILURE_CODE,
  );
  expect_truthy(errEvent, "telemetry must tag the sandbox_init_failure code");
});

test("review: real CHANGES_REQUESTED with normal output → status:complete + verdict preserved (negative test — no false positives)", async () => {
  // The conservatism guarantee: a real CHANGES_REQUESTED with a real
  // finding that happens to mention environmental words (namespace,
  // permission, etc.) MUST flow through to status:complete with the
  // verdict intact. Misclassifying a real finding as a sandbox-init
  // failure would let real bugs through — strictly worse than the
  // pre-fix behavior.
  const realFindingJson = JSON.stringify({
    status: "complete",
    verdict: "CHANGES_REQUESTED",
    requiresHumanJudgment: false,
    summary: "Real finding: undefined namespace prefix in K8s config.",
    findings: [
      {
        severity: "blocker",
        category: "config",
        file: "deploy/prod.yaml",
        line: 42,
        evidence:
          "namespace `prod-1` referenced but not declared; container will be denied permission",
        impact: "deploy will fail",
        requiredFix: "add the namespace declaration",
      },
    ],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
  });
  const mockClient = makeMockClient({
    run: async () =>
      makeTurn({
        finalResponse: realFindingJson,
        items: [
          {
            id: "item_0",
            type: "command_execution",
            command: "/bin/zsh -lc 'cat deploy/prod.yaml'",
            aggregated_output: "namespace: prod-1\n",
            exit_code: 0,
            status: "completed",
          },
        ],
      }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(
    result.status,
    "complete",
    "real CHANGES_REQUESTED must NOT be misclassified as environmental",
  );
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  expect_eq(result.findings.length, 1);
  expect_eq(result.findings[0]?.severity, "blocker");
});

test("review: APPROVED with clean output → status:complete (negative test — happy path unaffected)", async () => {
  // Sanity baseline: an APPROVED response with no bwrap citations
  // anywhere must remain status:complete with the verdict intact. This
  // protects against regressions where the detector accidentally
  // triggers on benign input.
  const mockClient = makeMockClient({
    run: async () =>
      makeTurn({
        finalResponse: APPROVED_RESPONSE_JSON,
        items: [
          {
            id: "item_0",
            type: "command_execution",
            command: "/bin/zsh -lc 'git diff'",
            aggregated_output: "+ added line\n",
            exit_code: 0,
            status: "completed",
          },
        ],
      }),
  });
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => mockClient,
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "APPROVED");
});

test("SANDBOX_INIT_FAILURE_CODE is the literal 'sandbox_init_failure' (operator-facing contract)", () => {
  // Operators grep _runs.ndjson for `errorCode=sandbox_init_failure`
  // to distinguish container/sandbox failures from upstream OpenAI
  // outages. The literal value is part of the operator contract —
  // changing it requires a coordinated rename in any runbook that
  // greps for it.
  expect_eq(SANDBOX_INIT_FAILURE_CODE, "sandbox_init_failure");
});
