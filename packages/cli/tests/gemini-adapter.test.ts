// Cycle 322.2 — Phase C unit tests for the Gemini SDK adapter.
//
// These cover the SDK-mock path (success, retry, error, abort) AND the
// pure-helper exports (resolveThinkingBudget, extractApiErrorStatus,
// isGeminiPermanentFailure). The SDK is mocked via the constructor's
// `createClient` factory so the tests do not require @google/genai's runtime
// nor a live GEMINI_API_KEY.
//
// We deliberately keep the mocks narrow and shape-compatible with the
// real SDK: a mock client provides only the surface the adapter actually
// touches (`models.generateContentStream`, `models.list`). If the adapter
// starts touching more of the SDK, the boundary is visible at test time
// rather than discoverable in production.


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
import {
  buildErrorResult as _buildErrorResult,
} from "../src/adapters/_shared.js";
import {
  DEFAULT_THINKING_BUDGET,
  GEMINI_PERMANENT_STATUS,
  GeminiSdkAdapter,
  extractApiErrorStatus,
  isGeminiPermanentFailure,
  resolveThinkingBudget,
  type GeminiClient,
  type GeminiStreamChunk,
} from "../src/adapters/gemini-sdk.js";
import type {
  CriticConfig,
  ReviewPacket,
  TelemetryEvent,
} from "@momentiq/dark-factory-schemas";

void _buildErrorResult; // keep import to verify shared-helper compatibility

const PACKET: ReviewPacket = {
  repoRoot: "/tmp/repo",
  branch: "main",
  commit: {
    sha: "1234567890abcdef1234567890abcdef12345678",
    parent: "0000000000000000000000000000000000000000",
    author: "test",
    email: "test@example.com",
    subject: "test commit",
    body: "",
    timestamp: "2026-05-14T00:00:00Z",
  },
  range: "0000..1234",
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
  id: "gemini-local-chief",
  name: "Gemini Local Critic",
  adapter: "gemini-sdk",
  required: false,
  runtime: "local",
  model: { id: "gemini-3.1-pro", params: [] },
};

function makeStream(chunks: GeminiStreamChunk[]): AsyncIterable<GeminiStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

const APPROVED_RESPONSE_JSON = JSON.stringify({
  status: "complete",
  verdict: "APPROVED",
  requiresHumanJudgment: false,
  summary: "ok",
  findings: [],
  validation: { qualityGateResults: [], qualityGatesMissing: [] },
  confidence: "high",
});

// ---------------------------------------------------------------------------
// Pure helpers

test("resolveThinkingBudget: defaults to 32_768 when no thinkingBudget param is set", () => {
  expect_eq(resolveThinkingBudget(CRITIC), DEFAULT_THINKING_BUDGET);
});

test("resolveThinkingBudget: reads thinkingBudget from critic.model.params", () => {
  const c: CriticConfig = {
    ...CRITIC,
    model: { id: "gemini-3.1-pro", params: [{ id: "thinkingBudget", value: 8192 }] },
  };
  expect_eq(resolveThinkingBudget(c), 8192);
});

test("resolveThinkingBudget: coerces string to integer", () => {
  const c: CriticConfig = {
    ...CRITIC,
    model: { id: "gemini-3.1-pro", params: [{ id: "thinkingBudget", value: "16384" }] },
  };
  expect_eq(resolveThinkingBudget(c), 16384);
});

test("resolveThinkingBudget: preserves Gemini sentinels (0 = disabled, -1 = automatic)", () => {
  const disabled: CriticConfig = {
    ...CRITIC,
    model: { id: "gemini-3.1-pro", params: [{ id: "thinkingBudget", value: 0 }] },
  };
  expect_eq(resolveThinkingBudget(disabled), 0);
  const auto: CriticConfig = {
    ...CRITIC,
    model: { id: "gemini-3.1-pro", params: [{ id: "thinkingBudget", value: -1 }] },
  };
  expect_eq(resolveThinkingBudget(auto), -1);
});

test("resolveThinkingBudget: invalid values fall back to default (operator typo guard)", () => {
  const cases: CriticConfig[] = [
    { ...CRITIC, model: { id: "x", params: [{ id: "thinkingBudget", value: "not-a-number" }] } },
    { ...CRITIC, model: { id: "x", params: [{ id: "thinkingBudget", value: -5 }] } },
    { ...CRITIC, model: { id: "x", params: [{ id: "thinkingBudget", value: true }] } },
  ];
  for (const c of cases) {
    expect_eq(resolveThinkingBudget(c), DEFAULT_THINKING_BUDGET);
  }
});

test("extractApiErrorStatus: reads status off ApiError-like errors", () => {
  expect_eq(extractApiErrorStatus({ status: 404 }), 404);
  expect_eq(extractApiErrorStatus({ error: { code: 429 } }), 429);
  expect_eq(extractApiErrorStatus(new Error("transport blip")), null);
  expect_eq(extractApiErrorStatus(null), null);
  expect_eq(extractApiErrorStatus("nope"), null);
});

test("isGeminiPermanentFailure: classifies HTTP statuses correctly", () => {
  for (const s of GEMINI_PERMANENT_STATUS) {
    expect_eq(isGeminiPermanentFailure(s), true, `status ${s} should be permanent`);
  }
  // 5xx + transient → retryable
  expect_eq(isGeminiPermanentFailure(500), false);
  expect_eq(isGeminiPermanentFailure(503), false);
  expect_eq(isGeminiPermanentFailure(504), false);
  // No status → retryable (transport-level error)
  expect_eq(isGeminiPermanentFailure(null), false);
});

// ---------------------------------------------------------------------------
// Adapter declaration

test("GeminiSdkAdapter declares requiredEnvVars = ['GEMINI_API_KEY']", () => {
  const adapter = new GeminiSdkAdapter();
  expect_deep([...adapter.requiredEnvVars], ["GEMINI_API_KEY"]);
});

test("GeminiSdkAdapter id is 'gemini-sdk'", () => {
  const adapter = new GeminiSdkAdapter();
  expect_eq(adapter.id, "gemini-sdk");
});

// ---------------------------------------------------------------------------
// review() — happy path

test("review: streams chunks, parses JSON, returns success result", async () => {
  const events: TelemetryEvent[] = [];
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async (params) => {
        // Verify the adapter sent a JSON-only request with thinking config
        expect_eq(params.config?.responseMimeType, "application/json");
        expect_eq(params.config?.thinkingConfig?.thinkingBudget, DEFAULT_THINKING_BUDGET);
        expect_eq(params.config?.temperature, 0);
        expect_eq(params.model, "gemini-3.1-pro");
        return makeStream([
          { text: APPROVED_RESPONSE_JSON.slice(0, 30), usageMetadata: { promptTokenCount: 100 } },
          {
            text: APPROVED_RESPONSE_JSON.slice(30),
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25 },
          },
        ]);
      },
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "test-key", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
    emit: (e) => events.push(e),
  });
  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.criticId, "gemini-local-chief");

  // Telemetry: critic_run_started + critic_run_finished, both tagged
  // with criticId AND adapter (Phase F requirement)
  const started = events.find((e) => e.event === "critic_run_started");
  const finished = events.find((e) => e.event === "critic_run_finished");
  expect_truthy(started, "expected critic_run_started");
  expect_eq(started!.criticId, "gemini-local-chief");
  expect_eq(started!.adapter, "gemini-sdk");
  expect_truthy(finished, "expected critic_run_finished");
  expect_eq(finished!.criticId, "gemini-local-chief");
  expect_eq(finished!.tokensIn, 100);
  expect_eq(finished!.tokensOut, 25);
  expect_eq(finished!.retryCount, 0); // first-attempt success
});

test("review: structured candidates path also yields text (defensive fallback)", async () => {
  // Some SDK responses provide text only via the candidates → content →
  // parts → text chain. The adapter must accept both paths so a
  // safety-filtered partial response (where .text getter throws) still
  // surfaces the structured payload.
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () => {
        return makeStream([
          {
            candidates: [{ content: { parts: [{ text: APPROVED_RESPONSE_JSON }] } }],
          },
        ]);
      },
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "test-key", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "APPROVED");
});

test("review: throwing .text getter is swallowed (Gemini stream-chunk getter regression)", async () => {
  // The throwing chunk stands in for a Gemini safety-blocked or empty chunk
  // where .text is a getter that throws. The structured candidates path
  // for the next chunk supplies the actual payload.
  const throwingChunk: GeminiStreamChunk = {
    get text(): string {
      throw new Error("safety block — text not available");
    },
  };
  const goodChunk: GeminiStreamChunk = {
    candidates: [{ content: { parts: [{ text: APPROVED_RESPONSE_JSON }] } }],
  };
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () => makeStream([throwingChunk, goodChunk]),
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "test-key", createClient: () => mockClient });
  // Must not throw — the throwing getter is caught inside the adapter.
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "complete");
});

// ---------------------------------------------------------------------------
// review() — failure paths

test("review: missing GEMINI_API_KEY → permanent failure (no retry)", async () => {
  const calls: number[] = [];
  const adapter = new GeminiSdkAdapter({
    apiKey: "", // empty string falsy
    createClient: () => {
      calls.push(1);
      return { models: { generateContentStream: async () => makeStream([]) } };
    },
  });
  // process.env.GEMINI_API_KEY is also unset — the empty-string apiKey
  // option falls through to env resolution which is also empty.
  const result = await adapter.review(PACKET, CRITIC, { blockingSeverities: ["blocker"] });
  expect_eq(result.status, "error");
  expect_match(result.error?.message ?? "", /GEMINI_API_KEY/);
  expect_eq(result.error?.retryable, false);
  // The createClient factory was NEVER invoked — we returned before
  // touching the SDK at all.
  expect_eq(calls.length, 0);
});

test("review: HTTP 429 quota error → permanent failure (no retry)", async () => {
  const events: TelemetryEvent[] = [];
  let attemptCount = 0;
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () => {
        attemptCount++;
        const e = new Error("Quota exceeded for project");
        (e as Error & { status?: number }).status = 429;
        throw e;
      },
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.code, "http_429");
  expect_eq(result.error?.retryable, false);
  expect_eq(attemptCount, 1, "must NOT retry on permanent quota error");
  const errEvent = events.find((e) => e.event === "critic_run_error");
  expect_eq(errEvent?.errorCode, "http_429");
  expect_eq(errEvent?.status, "run_failure_permanent");
});

test("review: HTTP 500 transient error → retried (uses retry budget) — succeeds on 3rd attempt", async () => {
  let attemptCount = 0;
  const sleepCalls: number[] = [];
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () => {
        attemptCount++;
        if (attemptCount < 3) {
          const e = new Error("internal server error");
          (e as Error & { status?: number }).status = 500;
          throw e;
        }
        return makeStream([{ text: APPROVED_RESPONSE_JSON }]);
      },
    },
  };
  // Inject a no-op sleep so the retry budget exercises the loop without
  // wall-clock waits. The real RETRY_BACKOFF_MS schedule is exercised
  // by cursor-retry-loop tests that target the loop in isolation.
  const adapter = new GeminiSdkAdapter({
    apiKey: "k",
    createClient: () => mockClient,
    sleep: async (idx) => {
      sleepCalls.push(idx);
    },
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "complete");
  expect_eq(attemptCount, 3, "expected 3 attempts (2 failures + 1 success)");
  // Two retries → two sleep calls at idx 0 and 1
  expect_deep(sleepCalls, [0, 1]);
});

test("review: HTTP 500 exhausting all retries → exhausted error result with retryCount=2", async () => {
  let attemptCount = 0;
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () => {
        attemptCount++;
        const e = new Error("server still broken");
        (e as Error & { status?: number }).status = 500;
        throw e;
      },
    },
  };
  const adapter = new GeminiSdkAdapter({
    apiKey: "k",
    createClient: () => mockClient,
    sleep: async () => {},
  });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
  });
  expect_eq(result.status, "error");
  // Three attempts (initial + 2 retries) — retryCount stops at 2
  expect_eq(attemptCount, 3);
  expect_eq(result.error?.retryCount, 2);
  expect_eq(result.error?.code, "http_500");
});

test("review: invalid JSON → permanent failure with rawSamplePath written", async () => {
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () => makeStream([{ text: "not valid json at all" }]),
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  // Use a tmp diagnostics dir so the rawSamplePath actually writes
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "gemini-test-"));
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    diagnosticsDir: dir,
  });
  expect_eq(result.status, "error");
  expect_match(result.error?.message ?? "", /invalid JSON/i);
  expect_truthy(result.error?.rawSamplePath, "expected rawSamplePath when diagnosticsDir is set");
  expect_truthy(result.error!.rawSamplePath!.startsWith(dir));
});

test("review: safety-block (promptFeedback.blockReason) → permanent failure with safety_blocked code", async () => {
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () =>
        makeStream([{ promptFeedback: { blockReason: "SAFETY" } }]),
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, { blockingSeverities: ["blocker"] });
  expect_eq(result.status, "error");
  expect_eq(result.error?.code, "safety_blocked");
  expect_eq(result.error?.retryable, false);
});

test("review: AbortSignal aborted before stream completes → result is error with aborted summary", async () => {
  const controller = new AbortController();
  // Abort BEFORE invoking review so the runRetryLoop short-circuits at
  // the top.
  controller.abort();
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () => {
        // Should not be reached
        return makeStream([{ text: APPROVED_RESPONSE_JSON }]);
      },
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    signal: controller.signal,
  });
  expect_eq(result.status, "error");
  expect_match(result.error?.message ?? "", /aborted/);
});

// ---------------------------------------------------------------------------
// doctor()

test("doctor: missing GEMINI_API_KEY surfaces actionable remediation", async () => {
  // Stub env so the test is deterministic regardless of caller env.
  const original = process.env["GEMINI_API_KEY"];
  delete process.env["GEMINI_API_KEY"];
  try {
    const adapter = new GeminiSdkAdapter({ apiKey: "" });
    const checks = await adapter.doctor(CRITIC);
    const keyCheck = checks.find((c) => c.name === "gemini_api_key");
    expect_truthy(keyCheck);
    expect_eq(keyCheck!.passed, false);
    expect_match(keyCheck!.remediation ?? "", /GEMINI_API_KEY/);
  } finally {
    if (original !== undefined) process.env["GEMINI_API_KEY"] = original;
  }
});

test("doctor: with API key + mock client, verifies model id resolves via models.list", async () => {
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () => makeStream([]),
      list: async () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { name: "models/gemini-3.1-pro" };
            yield { name: "models/gemini-3.1-flash-lite" };
          },
        } as AsyncIterable<{ name?: string }>),
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const checks = await adapter.doctor(CRITIC);
  const idCheck = checks.find((c) => c.name === "gemini_model_id");
  expect_truthy(idCheck);
  expect_eq(idCheck!.passed, true);
  expect_match(idCheck!.detail, /gemini-3\.1-pro available/);
});

test("doctor: model id NOT in models.list surfaces remediation pointing at the spike artifact", async () => {
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () => makeStream([]),
      list: async () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { name: "models/gemini-3.0-pro-preview" };
          },
        } as AsyncIterable<{ name?: string }>),
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const checks = await adapter.doctor(CRITIC);
  const idCheck = checks.find((c) => c.name === "gemini_model_id");
  expect_truthy(idCheck);
  expect_eq(idCheck!.passed, false);
  expect_match(idCheck!.remediation ?? "", /spike-gemini-models-2026-05/);
});

// ---------------------------------------------------------------------------
// Issue #1484 — `gate`-field misshape on validation.qualityGateResults
//
// Real-world observation: Gemini frequently echoes the validation evidence
// using a `gate` key instead of the schema-required `command` key. Pre-fix,
// this tripped parseCriticResult inside the adapter and forced a
// permanent_failure even though the validation block is informational and
// is overwritten with deterministic packet evidence after parsing. The fix
// is to route the parsed model JSON through the shared normalizer
// (originally Cursor-only) so the bad entry is dropped at the adapter
// boundary rather than failing the entire run.

const MISSHAPEN_GATE_ENTRY = {
  // `gate` instead of `command` — issue #1484 fixture
  gate: "make sage-quality-gates",
  exitCode: 0,
  durationMs: 1234,
  startedAt: "2026-05-15T00:00:00Z",
  finishedAt: "2026-05-15T00:00:02Z",
  logExcerpt: "ok",
};

const MISSHAPEN_RESPONSE_JSON = JSON.stringify({
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
    qualityGateResults: [MISSHAPEN_GATE_ENTRY],
    qualityGatesMissing: [],
  },
  confidence: "high",
});

test("review: model emits `gate` instead of `command` in qualityGateResults — adapter drops misshape and result is complete (issue #1484)", async () => {
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () =>
        makeStream([{ text: MISSHAPEN_RESPONSE_JSON }]),
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  // Pre-fix this was `error` with `gemini critic JSON failed schema validation`.
  expect_eq(result.status, "complete", "result must NOT be permanent_failure");
  expect_eq(result.verdict, "APPROVED");
  // Findings (the high-value payload) must be preserved.
  expect_eq(result.findings.length, 1);
  // The validation block is overwritten with the packet's deterministic
  // evidence (empty in this test packet), so it ends up empty AND
  // schema-valid — `command` is required, never `gate`.
  expect_eq(result.validation.qualityGateResults.length, 0);
  for (const entry of result.validation.qualityGateResults) {
    expect_truthy((entry as { command?: unknown }).command, "must use command, never gate");
  }
});
