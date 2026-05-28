// Issue #28 — Cursor CLI subscription adapter unit tests.
//
// Mirrors `tests/codex-adapter.test.ts`: runner-mock paths (success,
// retry, error, abort), plus shape assertions on the adapter contract.
//
// The cursor-agent CLI is mocked via the constructor's
// `runCursorAgentCli` factory so the tests do not require the binary
// installed or `cursor-agent login`. The mock shape stays narrow on
// purpose: the adapter reads ONLY the `CursorCliRunOutcome` surface
// (declared in `src/adapters/cursor-cli.ts`).

import { test } from "vitest";
import {
  expect_eq,
  expect_deep,
  expect_match,
  expect_truthy,
} from "./_assert-shim.js";

import {
  CURSOR_API_KEY_ENV,
  CURSOR_CLI_ADAPTER_ID,
  CURSOR_CLI_AUTH_CHATGPT,
  CURSOR_CLI_PERMANENT_SUBTYPES,
  CursorCliAdapter,
  buildCursorCliArgs,
  buildSubscriptionEnv,
  extractAssistantText,
  extractInitEvent,
  extractResultEnvelope,
  isPermanentResultSubtype,
  resolveAuthOrFail,
  resolveCursorCliModelId,
  type CursorCliRunOutcome,
} from "../src/adapters/cursor-cli.js";
import type {
  CriticConfig,
  ReviewPacket,
  TelemetryEvent,
} from "@momentiq/dark-factory-schemas";

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
  id: "cursor-cli-chief",
  name: "Cursor CLI Critic",
  adapter: "cursor-cli",
  required: false,
  runtime: "local",
  model: {
    id: "composer-2.5",
    params: [{ id: "fast", value: "false" }],
  },
  // Default to subscription auth; tests covering missing-auth behavior
  // override by stripping the field.
  auth: "chatgpt",
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

/**
 * Build a synthetic NDJSON event stream that mirrors what the real
 * cursor-agent CLI emits in --output-format stream-json mode. The shape
 * comes from the empirical capture pinned in the implementation file's
 * docstring (verified against cursor-agent 2026.04.17-787b533).
 */
function buildSuccessEvents(opts: {
  apiKeySource?: string;
  modelId?: string;
  sessionId?: string;
  resultText?: string;
  inputTokens?: number;
  outputTokens?: number;
} = {}): unknown[] {
  const sessionId = opts.sessionId ?? "session-test-1";
  const modelId = opts.modelId ?? "Composer 2.5";
  return [
    {
      type: "system",
      subtype: "init",
      apiKeySource: opts.apiKeySource ?? "login",
      cwd: "/tmp/repo",
      session_id: sessionId,
      model: modelId,
      permissionMode: "default",
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "prompt body" }] },
      session_id: sessionId,
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: opts.resultText ?? APPROVED_RESPONSE_JSON }],
      },
      session_id: sessionId,
    },
    {
      type: "result",
      subtype: "success",
      duration_ms: 8400,
      duration_api_ms: 8400,
      is_error: false,
      result: opts.resultText ?? APPROVED_RESPONSE_JSON,
      session_id: sessionId,
      request_id: "req-test-1",
      usage: {
        inputTokens: opts.inputTokens ?? 13000,
        outputTokens: opts.outputTokens ?? 200,
      },
    },
  ];
}

function makeRunner(impl: {
  outcome?: Partial<CursorCliRunOutcome>;
  outcomes?: Array<Partial<CursorCliRunOutcome>>;
  capture?: (args: {
    binaryPath: string;
    cliArgs: readonly string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    prompt: string;
  }) => void;
}): { runner: NonNullable<ConstructorParameters<typeof CursorCliAdapter>[0]>["runCursorAgentCli"]; calls: number } {
  let calls = 0;
  const outcomes = impl.outcomes ?? [impl.outcome ?? {}];
  const runner: NonNullable<ConstructorParameters<typeof CursorCliAdapter>[0]>["runCursorAgentCli"] =
    async (args) => {
      impl.capture?.({
        binaryPath: args.binaryPath,
        cliArgs: args.cliArgs,
        env: args.env,
        cwd: args.cwd,
        prompt: args.prompt,
      });
      const idx = Math.min(calls, outcomes.length - 1);
      calls++;
      const partial = outcomes[idx] ?? {};
      return {
        events: partial.events ?? buildSuccessEvents(),
        exitCode: partial.exitCode ?? 0,
        stderr: partial.stderr ?? "",
        spawnError: partial.spawnError ?? null,
      };
    };
  return {
    runner,
    get calls() {
      return calls;
    },
  } as { runner: NonNullable<ConstructorParameters<typeof CursorCliAdapter>[0]>["runCursorAgentCli"]; calls: number };
}

// ---------------------------------------------------------------------------
// Adapter declaration

test("CursorCliAdapter id is 'cursor-cli'", () => {
  const adapter = new CursorCliAdapter();
  expect_eq(adapter.id, CURSOR_CLI_ADAPTER_ID);
  expect_eq(adapter.id, "cursor-cli");
});

test("CursorCliAdapter declares requiredEnvVars = [] (subscription auth lives in Keychain, not env)", () => {
  const adapter = new CursorCliAdapter();
  expect_deep([...adapter.requiredEnvVars], []);
});

// ---------------------------------------------------------------------------
// Pure helpers

test("resolveCursorCliModelId: bare id when fast=false", () => {
  expect_eq(
    resolveCursorCliModelId({
      ...CRITIC,
      model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
    }),
    "composer-2.5",
  );
});

test("resolveCursorCliModelId: bare id when fast param absent", () => {
  expect_eq(
    resolveCursorCliModelId({
      ...CRITIC,
      model: { id: "composer-2.5", params: [] },
    }),
    "composer-2.5",
  );
});

test("resolveCursorCliModelId: appends -fast when fast=true", () => {
  expect_eq(
    resolveCursorCliModelId({
      ...CRITIC,
      model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
    }),
    "composer-2.5-fast",
  );
});

test("resolveCursorCliModelId: does not double the -fast suffix", () => {
  expect_eq(
    resolveCursorCliModelId({
      ...CRITIC,
      model: { id: "composer-2.5-fast", params: [{ id: "fast", value: "true" }] },
    }),
    "composer-2.5-fast",
  );
});

test("buildCursorCliArgs: order is fixed and includes --trust + --sandbox enabled", () => {
  expect_deep(buildCursorCliArgs("composer-2.5"), [
    "--print",
    "--output-format",
    "stream-json",
    "--trust",
    "--sandbox",
    "enabled",
    "--model",
    "composer-2.5",
  ]);
});

test("buildSubscriptionEnv: strips CURSOR_API_KEY from base env", () => {
  const env = buildSubscriptionEnv({
    CURSOR_API_KEY: "leaked-key",
    OTHER: "kept",
    PATH: "/usr/bin",
  });
  expect_eq(env[CURSOR_API_KEY_ENV], undefined);
  expect_eq(env["OTHER"], "kept");
  expect_eq(env["PATH"], "/usr/bin");
});

test("extractInitEvent: returns null for non-system events", () => {
  expect_eq(extractInitEvent({ type: "assistant" }), null);
  expect_eq(extractInitEvent({ type: "system", subtype: "other" }), null);
  expect_eq(extractInitEvent(null), null);
  expect_eq(extractInitEvent("string"), null);
});

test("extractInitEvent: extracts apiKeySource, session_id, model on system.init", () => {
  const init = extractInitEvent({
    type: "system",
    subtype: "init",
    apiKeySource: "login",
    cwd: "/tmp",
    session_id: "sess-123",
    model: "Composer 2.5",
    permissionMode: "default",
  });
  expect_truthy(init !== null);
  expect_eq(init!.apiKeySource, "login");
  expect_eq(init!.sessionId, "sess-123");
  expect_eq(init!.model, "Composer 2.5");
  expect_eq(init!.permissionMode, "default");
});

test("extractAssistantText: concatenates text blocks from message.content[]", () => {
  expect_eq(
    extractAssistantText({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
      },
    }),
    "hello world",
  );
});

test("extractAssistantText: returns empty for non-assistant events", () => {
  expect_eq(extractAssistantText({ type: "user" }), "");
  expect_eq(extractAssistantText({ type: "result" }), "");
  expect_eq(extractAssistantText(null), "");
});

test("extractResultEnvelope: extracts is_error, subtype, result, usage on result event", () => {
  const env = extractResultEnvelope({
    type: "result",
    subtype: "success",
    duration_ms: 1000,
    is_error: false,
    result: "OK",
    session_id: "s1",
    request_id: "r1",
    usage: { inputTokens: 100, outputTokens: 50 },
  });
  expect_truthy(env !== null);
  expect_eq(env!.isError, false);
  expect_eq(env!.subtype, "success");
  expect_eq(env!.resultText, "OK");
  expect_eq(env!.sessionId, "s1");
  expect_eq(env!.requestId, "r1");
  expect_eq(env!.durationMs, 1000);
  expect_eq(env!.usageInputTokens, 100);
  expect_eq(env!.usageOutputTokens, 50);
});

test("isPermanentResultSubtype: known permanent subtypes return true", () => {
  expect_eq(isPermanentResultSubtype("error_auth_failed"), true);
  expect_eq(isPermanentResultSubtype("error_quota_exceeded"), true);
  expect_eq(isPermanentResultSubtype("error_invalid_request"), true);
});

test("isPermanentResultSubtype: unknown subtypes default to retryable (false)", () => {
  expect_eq(isPermanentResultSubtype("error_transient_blip"), false);
  expect_eq(isPermanentResultSubtype("success"), false);
  expect_eq(isPermanentResultSubtype(null), false);
});

test("CURSOR_CLI_PERMANENT_SUBTYPES is non-empty and the set api works", () => {
  expect_truthy(CURSOR_CLI_PERMANENT_SUBTYPES.size > 0);
  expect_eq(CURSOR_CLI_PERMANENT_SUBTYPES.has("error_auth_failed"), true);
});

// ---------------------------------------------------------------------------
// Auth resolution

test("resolveAuthOrFail: auth=chatgpt → ok", () => {
  const out = resolveAuthOrFail(
    { ...CRITIC, auth: "chatgpt" },
    0,
  );
  expect_eq(out.kind, "ok");
});

test("resolveAuthOrFail: auth=undefined → permanent_failure with config-fix message", () => {
  const critic: CriticConfig = { ...CRITIC };
  delete (critic as { auth?: string }).auth;
  const out = resolveAuthOrFail(critic, 0);
  expect_eq(out.kind, "permanent_failure");
  if (out.kind === "permanent_failure") {
    expect_match(out.result.error!.message, /no auth source pinned/);
    expect_match(out.result.error!.message, /profiles\.<name>\.auth/);
  }
});

test("resolveAuthOrFail: auth=api → permanent_failure redirecting to cursor-sdk", () => {
  const out = resolveAuthOrFail({ ...CRITIC, auth: "api" }, 0);
  expect_eq(out.kind, "permanent_failure");
  if (out.kind === "permanent_failure") {
    expect_match(out.result.error!.message, /only supports auth="chatgpt"/);
    expect_match(out.result.error!.message, /cursor-sdk adapter/);
  }
});

// ---------------------------------------------------------------------------
// review() — happy path

test("review: stream-json with success result → CriticResult APPROVED", async () => {
  const events: TelemetryEvent[] = [];
  let observedPrompt = "";
  let observedCliArgs: readonly string[] = [];
  let observedEnv: NodeJS.ProcessEnv = {};
  let observedCwd = "";
  const { runner } = makeRunner({
    outcome: { events: buildSuccessEvents({ inputTokens: 1500, outputTokens: 280 }) },
    capture: (a) => {
      observedPrompt = a.prompt;
      observedCliArgs = a.cliArgs;
      observedEnv = a.env;
      observedCwd = a.cwd;
    },
  });
  const adapter = new CursorCliAdapter({
    runCursorAgentCli: runner,
    baseEnv: { CURSOR_API_KEY: "leaked", PATH: "/usr/bin" },
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
    emit: (e) => events.push(e),
  });

  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.criticId, "cursor-cli-chief");

  // Env strip: CURSOR_API_KEY must NOT appear in the subprocess env.
  expect_eq(observedEnv[CURSOR_API_KEY_ENV], undefined);
  expect_eq(observedEnv["PATH"], "/usr/bin");

  // CLI args carry the documented headless+trust shape.
  expect_truthy(observedCliArgs.includes("--print"));
  expect_truthy(observedCliArgs.includes("--trust"));
  expect_truthy(observedCliArgs.includes("stream-json"));
  expect_truthy(observedCliArgs.includes("enabled"));
  expect_truthy(observedCliArgs.includes("composer-2.5"));

  // cwd is the repo root from the packet.
  expect_eq(observedCwd, "/tmp/repo");

  // Prompt was compiled via compileCriticPrompt — should mention the critic id.
  expect_truthy(observedPrompt.includes("cursor-cli-chief"));

  // Telemetry — critic_run_started + critic_run_finished, tagged with adapter=cursor-cli.
  const started = events.find((e) => e.event === "critic_run_started");
  const finished = events.find((e) => e.event === "critic_run_finished");
  expect_truthy(started !== undefined);
  expect_eq(started!.adapter, "cursor-cli");
  expect_eq(started!.criticId, "cursor-cli-chief");
  expect_truthy(finished !== undefined);
  expect_eq(finished!.adapter, "cursor-cli");
  expect_eq(finished!.tokensIn, 1500);
  expect_eq(finished!.tokensOut, 280);
  expect_eq(finished!.retryCount, 0);
});

test("review: fast=true critic → --model arg gets -fast suffix", async () => {
  let observedCliArgs: readonly string[] = [];
  const { runner } = makeRunner({
    capture: (a) => {
      observedCliArgs = a.cliArgs;
    },
  });
  const adapter = new CursorCliAdapter({ runCursorAgentCli: runner });
  const fastCritic: CriticConfig = {
    ...CRITIC,
    model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
  };
  await adapter.review(PACKET, fastCritic, { blockingSeverities: ["blocker"] });
  const modelIdx = observedCliArgs.indexOf("--model");
  expect_truthy(modelIdx >= 0);
  expect_eq(observedCliArgs[modelIdx + 1], "composer-2.5-fast");
});

// ---------------------------------------------------------------------------
// Defense in depth: apiKeySource MUST be "login" when auth=chatgpt

test("review: apiKeySource='env' when auth='chatgpt' → permanent_failure (defense in depth)", async () => {
  const { runner } = makeRunner({
    outcome: {
      events: buildSuccessEvents({ apiKeySource: "env" }),
    },
  });
  const adapter = new CursorCliAdapter({ runCursorAgentCli: runner });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.retryable, false);
  expect_eq(result.error?.code, "auth_routing_failure");
  expect_match(result.error!.message, /apiKeySource="env"/);
  expect_match(result.error!.message, /CURSOR_API_KEY/);
});

test("review: apiKeySource='login' when auth='chatgpt' → success (the expected path)", async () => {
  const { runner } = makeRunner({
    outcome: { events: buildSuccessEvents({ apiKeySource: "login" }) },
  });
  const adapter = new CursorCliAdapter({ runCursorAgentCli: runner });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "complete");
});

// ---------------------------------------------------------------------------
// Auth pin enforcement

test("review: auth=undefined → permanent_failure with config-fix message", async () => {
  const { runner } = makeRunner({});
  const adapter = new CursorCliAdapter({ runCursorAgentCli: runner });
  const critic: CriticConfig = { ...CRITIC };
  delete (critic as { auth?: string }).auth;
  const result = await adapter.review(PACKET, critic, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.retryable, false);
  expect_match(result.error!.message, /no auth source pinned/);
});

test("review: auth='api' → permanent_failure redirecting to cursor-sdk", async () => {
  const { runner } = makeRunner({});
  const adapter = new CursorCliAdapter({ runCursorAgentCli: runner });
  const result = await adapter.review(PACKET, { ...CRITIC, auth: "api" }, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.retryable, false);
  expect_match(result.error!.message, /cursor-sdk adapter/);
});

// ---------------------------------------------------------------------------
// Failure paths

test("review: spawnError (ENOENT) → permanent_failure with install remediation", async () => {
  const enoentError = Object.assign(new Error("spawn cursor-agent ENOENT"), {
    code: "ENOENT",
  });
  const { runner } = makeRunner({
    outcome: { spawnError: enoentError, exitCode: null },
  });
  const adapter = new CursorCliAdapter({ runCursorAgentCli: runner });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.retryable, false);
  expect_match(result.error!.message, /failed to spawn/);
  expect_match(result.error!.message, /cursor-agent login/);
});

test("review: no result envelope (CLI exited early) → permanent_failure with stderr", async () => {
  const { runner } = makeRunner({
    outcome: {
      events: [], // No events emitted before exit.
      exitCode: 1,
      stderr: "Error: invalid argument\n",
    },
  });
  const adapter = new CursorCliAdapter({ runCursorAgentCli: runner });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.retryable, false);
  expect_eq(result.error?.code, "no_terminal_result");
  expect_match(result.error!.message, /no terminal result event/);
  expect_match(result.error!.message, /Error: invalid argument/);
});

test("review: result.is_error=true with permanent subtype → permanent_failure", async () => {
  const events = buildSuccessEvents();
  // Replace the terminal result event with an error envelope.
  events[events.length - 1] = {
    type: "result",
    subtype: "error_quota_exceeded",
    duration_ms: 100,
    is_error: true,
    result: "",
    session_id: "s1",
    request_id: "r1",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const { runner } = makeRunner({ outcome: { events } });
  const adapter = new CursorCliAdapter({ runCursorAgentCli: runner });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.retryable, false);
  expect_eq(result.error?.code, "error_quota_exceeded");
});

test("review: result.is_error=true with unknown subtype → retryable_failure → exhausts retry budget", async () => {
  // The runner returns the same retryable error 3 times (initial + 2
  // retries). The outer retry loop should exhaust and return an error
  // result with retryable=true (the bias when retries are exhausted on
  // genuinely transient failures).
  const buildRetryableEvents = () => {
    const events = buildSuccessEvents();
    events[events.length - 1] = {
      type: "result",
      subtype: "error_upstream_blip",
      duration_ms: 100,
      is_error: true,
      result: "",
      session_id: "s1",
      request_id: "r1",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    return events;
  };
  const { runner } = makeRunner({
    outcomes: [
      { events: buildRetryableEvents() },
      { events: buildRetryableEvents() },
      { events: buildRetryableEvents() },
    ],
  });
  const adapter = new CursorCliAdapter({
    runCursorAgentCli: runner,
    // Skip the real backoff so the test doesn't wait 20s.
    sleep: async () => {},
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.retryable, true);
  expect_match(result.error!.message, /failed after 2 retries/);
});

test("review: invalid JSON in result.result text → permanent_failure", async () => {
  const events = buildSuccessEvents({ resultText: "not valid json at all" });
  const { runner } = makeRunner({ outcome: { events } });
  const adapter = new CursorCliAdapter({ runCursorAgentCli: runner });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.retryable, false);
  expect_match(result.error!.message, /invalid JSON/);
});

// ---------------------------------------------------------------------------
// doctor()

test("doctor: binary missing → fail with install remediation", async () => {
  const exec = async (_path: string, args: readonly string[]) => {
    if (args[0] === "--version") {
      throw Object.assign(new Error("spawn cursor-agent ENOENT"), { code: "ENOENT" });
    }
    return { stdout: "", stderr: "" };
  };
  const adapter = new CursorCliAdapter({ execCursorAgent: exec });
  const checks = await adapter.doctor(CRITIC);
  const versionCheck = checks.find((c) => c.name === "cursor_cli_on_path");
  expect_truthy(versionCheck !== undefined);
  expect_eq(versionCheck!.passed, false);
  expect_match(versionCheck!.remediation ?? "", /install the Cursor CLI/);
});

test("doctor: --trust supported + status logged in + model present → all pass", async () => {
  const exec = async (_path: string, args: readonly string[]) => {
    if (args[0] === "--version") return { stdout: "2026.04.17-787b533", stderr: "" };
    if (args[0] === "--help") {
      return {
        stdout:
          "Usage: agent [options] [command] [prompt...]\n  --trust   Trust the workspace without prompting (only works with --print/headless mode)\n",
        stderr: "",
      };
    }
    if (args[0] === "status") return { stdout: "✓ Logged in as test@example.com", stderr: "" };
    if (args[0] === "models") return { stdout: "composer-2.5\nclaude-opus-4-7\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const adapter = new CursorCliAdapter({ execCursorAgent: exec });
  const checks = await adapter.doctor(CRITIC);
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  expect_eq(byName["cursor_cli_on_path"]?.passed, true);
  expect_eq(byName["cursor_cli_trust_flag"]?.passed, true);
  expect_eq(byName["cursor_cli_subscription_auth"]?.passed, true);
  expect_eq(byName["cursor_cli_auth_pin"]?.passed, true);
  expect_eq(byName["cursor_cli_model_available"]?.passed, true);
});

test("doctor: status not logged in → cursor_cli_subscription_auth fails with login remediation", async () => {
  const exec = async (_path: string, args: readonly string[]) => {
    if (args[0] === "--version") return { stdout: "2026.04.17-787b533", stderr: "" };
    if (args[0] === "--help") return { stdout: "--trust   trust\n", stderr: "" };
    if (args[0] === "status") {
      throw Object.assign(new Error("Not authenticated"), { code: 1 });
    }
    if (args[0] === "models") return { stdout: "composer-2.5\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const adapter = new CursorCliAdapter({ execCursorAgent: exec });
  const checks = await adapter.doctor(CRITIC);
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  expect_eq(byName["cursor_cli_subscription_auth"]?.passed, false);
  expect_match(byName["cursor_cli_subscription_auth"]?.remediation ?? "", /cursor-agent login/);
});

test("doctor: critic.auth='api' → cursor_cli_auth_pin fails directing to cursor-sdk", async () => {
  const exec = async (_path: string, args: readonly string[]) => {
    if (args[0] === "--version") return { stdout: "v", stderr: "" };
    if (args[0] === "--help") return { stdout: "--trust\n", stderr: "" };
    if (args[0] === "status") return { stdout: "Logged in", stderr: "" };
    if (args[0] === "models") return { stdout: "composer-2.5\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const adapter = new CursorCliAdapter({ execCursorAgent: exec });
  const checks = await adapter.doctor({ ...CRITIC, auth: "api" });
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  expect_eq(byName["cursor_cli_auth_pin"]?.passed, false);
  expect_match(byName["cursor_cli_auth_pin"]?.remediation ?? "", /cursor-sdk adapter/);
});

test("doctor: model not in cursor-agent models output → fail with config-edit remediation", async () => {
  const exec = async (_path: string, args: readonly string[]) => {
    if (args[0] === "--version") return { stdout: "v", stderr: "" };
    if (args[0] === "--help") return { stdout: "--trust\n", stderr: "" };
    if (args[0] === "status") return { stdout: "Logged in", stderr: "" };
    if (args[0] === "models") return { stdout: "other-model-1\nother-model-2\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const adapter = new CursorCliAdapter({ execCursorAgent: exec });
  const checks = await adapter.doctor(CRITIC);
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  expect_eq(byName["cursor_cli_model_available"]?.passed, false);
  expect_match(byName["cursor_cli_model_available"]?.remediation ?? "", /config\.json/);
});

// CURSOR_CLI_AUTH_CHATGPT exported value sanity (catches accidental string drift).
test("CURSOR_CLI_AUTH_CHATGPT === 'chatgpt'", () => {
  expect_eq(CURSOR_CLI_AUTH_CHATGPT, "chatgpt");
});
