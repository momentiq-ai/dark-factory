// Cycle 322.3 — Phase B unit tests for the xAI Grok-direct SDK adapter.
//
// These cover the SDK-mock path (success, retry, error, refusal,
// abort) AND the pure-helper exports (resolveReasoningEffort,
// extractXaiApiErrorStatus, isGrokPermanentFailure). The SDK is
// mocked via the constructor's `createClient` factory so the tests
// do not require the `openai` runtime nor a live XAI_API_KEY.
//
// The mocks intentionally stay narrow and shape-compatible with the
// real openai SDK Responses-API stream: each mock event is the
// minimal shape needed to exercise one code path, so an adapter
// regression that depends on a wider field surface (e.g., starts
// reading a new event subtype) becomes visible at test time rather
// than discoverable in production.


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
  DEFAULT_REASONING_EFFORT,
  GROK_PERMANENT_STATUS,
  GrokDirectSdkAdapter,
  extractXaiApiErrorStatus,
  isGrokPermanentFailure,
  resolveReasoningEffort,
  type GrokClient,
  type GrokStreamEvent,
} from "../src/adapters/grok-direct-sdk.js";
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
  id: "grok-local-chief",
  name: "Grok Local Critic",
  adapter: "grok-direct-sdk",
  required: false,
  runtime: "local",
  model: { id: "grok-4.3", params: [] },
};

function makeStream(events: GrokStreamEvent[]): AsyncIterable<GrokStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
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

function deltaEvent(delta: string): GrokStreamEvent {
  return { type: "response.output_text.delta", delta };
}

function completedEvent(
  options: {
    inputTokens?: number;
    outputTokens?: number;
    fallbackOutput?: string;
  } = {},
): GrokStreamEvent {
  const response: GrokStreamEvent["response"] = {
    id: "resp_test_1",
  };
  if (options.inputTokens !== undefined || options.outputTokens !== undefined) {
    response.usage = {
      ...(options.inputTokens !== undefined ? { input_tokens: options.inputTokens } : {}),
      ...(options.outputTokens !== undefined ? { output_tokens: options.outputTokens } : {}),
    };
  }
  if (options.fallbackOutput !== undefined) {
    response.output = [
      {
        content: [{ type: "output_text", text: options.fallbackOutput }],
      },
    ];
  }
  return { type: "response.completed", response };
}

// ---------------------------------------------------------------------------
// Pure helpers

test("resolveReasoningEffort: defaults to 'high' when no reasoning_effort param is set", () => {
  expect_eq(resolveReasoningEffort(CRITIC), DEFAULT_REASONING_EFFORT);
  expect_eq(DEFAULT_REASONING_EFFORT, "high");
});

test("resolveReasoningEffort: reads reasoning_effort from critic.model.params", () => {
  for (const effort of ["low", "medium", "high", "none"] as const) {
    const c: CriticConfig = {
      ...CRITIC,
      model: { id: "grok-4.3", params: [{ id: "reasoning_effort", value: effort }] },
    };
    expect_eq(resolveReasoningEffort(c), effort);
  }
});

test("resolveReasoningEffort: 'none' resolves to 'none' (documented xAI escape hatch)", () => {
  // Codex PR-1429 P2 feedback: previously 'none' fell back to the
  // 'high' default because the allowlist excluded it. xAI's Grok 4.3
  // docs list 'none' alongside low/medium/high; the adapter must
  // honor an operator's intent to disable reasoning.
  const c: CriticConfig = {
    ...CRITIC,
    model: { id: "grok-4.3", params: [{ id: "reasoning_effort", value: "none" }] },
  };
  expect_eq(resolveReasoningEffort(c), "none");
});

test("resolveReasoningEffort: case-insensitive value normalization", () => {
  const c: CriticConfig = {
    ...CRITIC,
    model: { id: "grok-4.3", params: [{ id: "reasoning_effort", value: "HIGH" }] },
  };
  expect_eq(resolveReasoningEffort(c), "high");
});

test("resolveReasoningEffort: invalid values fall back to default (operator typo guard)", () => {
  const cases: CriticConfig[] = [
    { ...CRITIC, model: { id: "x", params: [{ id: "reasoning_effort", value: "extra-high" }] } },
    { ...CRITIC, model: { id: "x", params: [{ id: "reasoning_effort", value: "max" }] } },
    { ...CRITIC, model: { id: "x", params: [{ id: "reasoning_effort", value: 42 }] } },
    { ...CRITIC, model: { id: "x", params: [{ id: "reasoning_effort", value: true }] } },
  ];
  for (const c of cases) {
    expect_eq(resolveReasoningEffort(c), DEFAULT_REASONING_EFFORT);
  }
});

test("extractXaiApiErrorStatus: reads status off APIError-like errors", () => {
  expect_eq(extractXaiApiErrorStatus({ status: 404 }), 404);
  expect_eq(extractXaiApiErrorStatus({ response: { status: 429 } }), 429);
  expect_eq(extractXaiApiErrorStatus(new Error("transport blip")), null);
  expect_eq(extractXaiApiErrorStatus(null), null);
  expect_eq(extractXaiApiErrorStatus("nope"), null);
});

test("isGrokPermanentFailure: classifies HTTP statuses correctly", () => {
  for (const s of GROK_PERMANENT_STATUS) {
    expect_eq(isGrokPermanentFailure(s), true, `status ${s} should be permanent`);
  }
  // 5xx + transient → retryable
  expect_eq(isGrokPermanentFailure(500), false);
  expect_eq(isGrokPermanentFailure(503), false);
  expect_eq(isGrokPermanentFailure(504), false);
  // No status → retryable (transport-level error)
  expect_eq(isGrokPermanentFailure(null), false);
});

// ---------------------------------------------------------------------------
// Adapter declaration

test("GrokDirectSdkAdapter declares requiredEnvVars = ['XAI_API_KEY']", () => {
  const adapter = new GrokDirectSdkAdapter();
  expect_deep([...adapter.requiredEnvVars], ["XAI_API_KEY"]);
});

test("GrokDirectSdkAdapter id is 'grok-direct-sdk'", () => {
  const adapter = new GrokDirectSdkAdapter();
  expect_eq(adapter.id, "grok-direct-sdk");
});

// ---------------------------------------------------------------------------
// review() — happy path

test("review: streams output_text.delta events, parses JSON, returns success", async () => {
  const events: TelemetryEvent[] = [];
  const mockClient: GrokClient = {
    responses: {
      create: async (params) => {
        // Verify the adapter sent a JSON-only Responses-API request
        // with reasoning.effort defaulted to "high"
        expect_eq(params.model, "grok-4.3");
        expect_eq(params.reasoning?.effort, "high");
        expect_eq(params.text?.format?.type, "json_object");
        expect_eq(params.store, false);
        expect_eq(params.stream, true);
        expect_eq(params.input.length, 1);
        expect_eq(params.input[0]?.role, "user");
        return makeStream([
          deltaEvent(APPROVED_RESPONSE_JSON.slice(0, 30)),
          deltaEvent(APPROVED_RESPONSE_JSON.slice(30)),
          completedEvent({ inputTokens: 1500, outputTokens: 280 }),
        ]);
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "test-key", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
    emit: (e) => events.push(e),
  });
  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.criticId, "grok-local-chief");

  // Telemetry: critic_run_started + critic_run_finished, both tagged
  // with criticId AND adapter (Phase F requirement carried over from 322.2)
  const started = events.find((e) => e.event === "critic_run_started");
  const finished = events.find((e) => e.event === "critic_run_finished");
  expect_truthy(started, "expected critic_run_started");
  expect_eq(started!.criticId, "grok-local-chief");
  expect_eq(started!.adapter, "grok-direct-sdk");
  expect_truthy(finished, "expected critic_run_finished");
  expect_eq(finished!.criticId, "grok-local-chief");
  expect_eq(finished!.tokensIn, 1500);
  expect_eq(finished!.tokensOut, 280);
  expect_eq(finished!.retryCount, 0); // first-attempt success
});

test("review: reasoning_effort param threads through to the SDK request body", async () => {
  const seenEfforts: string[] = [];
  const c: CriticConfig = {
    ...CRITIC,
    model: { id: "grok-4.3", params: [{ id: "reasoning_effort", value: "medium" }] },
  };
  const mockClient: GrokClient = {
    responses: {
      create: async (params) => {
        seenEfforts.push(params.reasoning?.effort ?? "(unset)");
        return makeStream([deltaEvent(APPROVED_RESPONSE_JSON), completedEvent()]);
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  await adapter.review(PACKET, c, { blockingSeverities: ["blocker"] });
  expect_deep(seenEfforts, ["medium"]);
});

test("review: reasoning_effort='none' sends explicit none reasoning effort", async () => {
  // Codex PR-1429 P2 feedback: when the operator configures
  // `reasoning_effort: "none"` (an escape hatch documented in xAI's
  // Grok 4.3 docs alongside low/medium/high), the adapter must NOT
  // send `reasoning: { effort: "high" }` — that would defeat the
  // operator's cost/latency intent. It must also avoid omitting the
  // field entirely, because xAI can default an unspecified effort to
  // low reasoning.
  let observedEffort: string | undefined;
  const c: CriticConfig = {
    ...CRITIC,
    model: { id: "grok-4.3", params: [{ id: "reasoning_effort", value: "none" }] },
  };
  const mockClient: GrokClient = {
    responses: {
      create: async (params) => {
        observedEffort = params.reasoning?.effort;
        return makeStream([deltaEvent(APPROVED_RESPONSE_JSON), completedEvent()]);
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  await adapter.review(PACKET, c, { blockingSeverities: ["blocker"] });
  expect_eq(observedEffort, "none");
});

test("review: response.completed fallback output[].content[].text yields text when deltas absent", async () => {
  // Some streaming-backpressure failures deliver only the terminal event
  // with the full response in `output[]`; the adapter must accept that path
  // so a degraded stream still surfaces the payload.
  const mockClient: GrokClient = {
    responses: {
      create: async () =>
        makeStream([completedEvent({ fallbackOutput: APPROVED_RESPONSE_JSON })]),
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "APPROVED");
});

// ---------------------------------------------------------------------------
// review() — failure paths

test("review: missing XAI_API_KEY → permanent failure (no SDK call)", async () => {
  const calls: number[] = [];
  const adapter = new GrokDirectSdkAdapter({
    apiKey: "", // empty string falsy
    createClient: () => {
      calls.push(1);
      return {
        responses: { create: async () => makeStream([]) },
        models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
      };
    },
  });
  // Stub env so this is deterministic regardless of caller env.
  const original = process.env["XAI_API_KEY"];
  delete process.env["XAI_API_KEY"];
  try {
    const result = await adapter.review(PACKET, CRITIC, { blockingSeverities: ["blocker"] });
    expect_eq(result.status, "error");
    expect_match(result.error?.message ?? "", /XAI_API_KEY/);
    expect_eq(result.error?.retryable, false);
    // The createClient factory was NEVER invoked.
    expect_eq(calls.length, 0);
  } finally {
    if (original !== undefined) process.env["XAI_API_KEY"] = original;
  }
});

test("review: HTTP 429 rate-limit error → permanent failure (no retry)", async () => {
  const events: TelemetryEvent[] = [];
  let attemptCount = 0;
  const mockClient: GrokClient = {
    responses: {
      create: async () => {
        attemptCount++;
        const e = new Error("rate limit exceeded") as Error & { status?: number };
        e.status = 429;
        throw e;
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.code, "http_429");
  expect_eq(result.error?.retryable, false);
  expect_eq(attemptCount, 1, "must NOT retry on permanent rate-limit error");
  const errEvent = events.find((e) => e.event === "critic_run_error");
  expect_eq(errEvent?.errorCode, "http_429");
  expect_eq(errEvent?.status, "run_failure_permanent");
});

test("review: HTTP 500 transient error → retried; succeeds on 3rd attempt", async () => {
  let attemptCount = 0;
  const sleepCalls: number[] = [];
  const mockClient: GrokClient = {
    responses: {
      create: async () => {
        attemptCount++;
        if (attemptCount < 3) {
          const e = new Error("upstream timeout") as Error & { status?: number };
          e.status = 500;
          throw e;
        }
        return makeStream([deltaEvent(APPROVED_RESPONSE_JSON), completedEvent()]);
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  // Inject a no-op sleep so the retry budget exercises the loop without
  // wall-clock waits. The real RETRY_BACKOFF_MS schedule is exercised
  // by cursor-retry-loop tests that target the loop in isolation.
  const adapter = new GrokDirectSdkAdapter({
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
  expect_deep(sleepCalls, [0, 1]);
});

test("review: HTTP 500 exhausting all retries → exhausted error result with retryCount=2", async () => {
  let attemptCount = 0;
  const mockClient: GrokClient = {
    responses: {
      create: async () => {
        attemptCount++;
        const e = new Error("server still broken") as Error & { status?: number };
        e.status = 500;
        throw e;
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({
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

test("review: response.incomplete (truncation) → permanent failure with 'incomplete' code + preserved partial text", async () => {
  // Cycle 322.3 Cursor critic feedback (367476d3 finding #4): the
  // xAI/OpenAI Responses API emits response.incomplete when output
  // was truncated (max_output_tokens, content_filter). The adapter
  // must classify as permanent (retrying the same prompt re-trips
  // the same truncation), use a distinct errorCode (`incomplete`
  // vs `transport_error`), and preserve the partial text for
  // operator inspection.
  let attemptCount = 0;
  const events: TelemetryEvent[] = [];
  const partialText = '{"status":"complete","verd';
  const mockClient: GrokClient = {
    responses: {
      create: async () => {
        attemptCount++;
        return makeStream([
          deltaEvent(partialText),
          {
            type: "response.incomplete",
            response: {
              id: "resp_truncated_1",
              usage: { input_tokens: 1500, output_tokens: 256 },
              incomplete_details: { reason: "max_output_tokens" },
            },
          },
        ]);
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "grok-test-incomplete-"));
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
    diagnosticsDir: dir,
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.code, "incomplete");
  expect_eq(result.error?.retryable, false);
  expect_eq(attemptCount, 1, "must NOT retry on truncation");
  expect_match(result.error?.message ?? "", /max_output_tokens/);
  // Diagnostic preserved with the partial text
  expect_truthy(result.error?.rawSamplePath, "expected rawSamplePath when diagnosticsDir is set");
  expect_truthy(result.error!.rawSamplePath!.startsWith(dir));
  // Telemetry event tagged correctly
  const errEvent = events.find((e) => e.event === "critic_run_error");
  expect_eq(errEvent?.errorCode, "incomplete");
  expect_eq(errEvent?.status, "incomplete");
});

test("review: refusal event → permanent failure with 'refused' code (retry would re-trip)", async () => {
  let attemptCount = 0;
  const events: TelemetryEvent[] = [];
  const mockClient: GrokClient = {
    responses: {
      create: async () => {
        attemptCount++;
        return makeStream([
          { type: "response.refusal.delta", refusal: "I cannot help with that " },
          { type: "response.refusal.done", refusal: "request." },
          completedEvent(),
        ]);
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.code, "refused");
  expect_eq(result.error?.retryable, false);
  expect_eq(attemptCount, 1, "must NOT retry on policy refusal");
  const errEvent = events.find((e) => e.event === "critic_run_error");
  expect_eq(errEvent?.errorCode, "refused");
});

test("review: invalid JSON terminal text → permanent failure with rawSamplePath written", async () => {
  const mockClient: GrokClient = {
    responses: {
      create: async () =>
        makeStream([deltaEvent("not valid json at all"), completedEvent()]),
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "grok-test-"));
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    diagnosticsDir: dir,
  });
  expect_eq(result.status, "error");
  expect_match(result.error?.message ?? "", /invalid JSON/i);
  expect_truthy(result.error?.rawSamplePath, "expected rawSamplePath when diagnosticsDir is set");
  expect_truthy(result.error!.rawSamplePath!.startsWith(dir));
});

test("review: response.failed terminal event → retryable_failure (transport-style; outer loop handles)", async () => {
  let attemptCount = 0;
  const mockClient: GrokClient = {
    responses: {
      create: async () => {
        attemptCount++;
        return makeStream([
          { type: "response.failed" },
        ]);
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({
    apiKey: "k",
    createClient: () => mockClient,
    sleep: async () => {},
  });
  const result = await adapter.review(PACKET, CRITIC, { blockingSeverities: ["blocker"] });
  // response.failed throws inside the adapter and gets caught — no HTTP
  // status, so it's classified as retryable. After 3 attempts the loop
  // exhausts and produces an error result.
  expect_eq(result.status, "error");
  expect_eq(attemptCount, 3);
  expect_eq(result.error?.code, "transport_error");
});

test("review: AbortSignal aborted before stream starts → result is error with aborted summary", async () => {
  const controller = new AbortController();
  controller.abort();
  const mockClient: GrokClient = {
    responses: {
      create: async () => {
        // Should not be reached — runRetryLoop short-circuits at the top
        return makeStream([deltaEvent(APPROVED_RESPONSE_JSON), completedEvent()]);
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    signal: controller.signal,
  });
  expect_eq(result.status, "error");
  expect_match(result.error?.message ?? "", /aborted/);
});

// ---------------------------------------------------------------------------
// doctor()

test("doctor: missing XAI_API_KEY on optional shadow critic does not fail doctor", async () => {
  const original = process.env["XAI_API_KEY"];
  delete process.env["XAI_API_KEY"];
  try {
    const adapter = new GrokDirectSdkAdapter({ apiKey: "" });
    const checks = await adapter.doctor(CRITIC);
    const keyCheck = checks.find((c) => c.name === "xai_api_key");
    expect_truthy(keyCheck);
    expect_eq(keyCheck!.passed, true);
    expect_match(keyCheck!.detail, /optional shadow critic/);
    expect_eq(keyCheck!.remediation, undefined);
  } finally {
    if (original !== undefined) process.env["XAI_API_KEY"] = original;
  }
});

test("doctor: missing XAI_API_KEY on required critic surfaces actionable remediation pointing at the spike artifact", async () => {
  const original = process.env["XAI_API_KEY"];
  delete process.env["XAI_API_KEY"];
  try {
    const adapter = new GrokDirectSdkAdapter({ apiKey: "" });
    const checks = await adapter.doctor({ ...CRITIC, required: true });
    const keyCheck = checks.find((c) => c.name === "xai_api_key");
    expect_truthy(keyCheck);
    expect_eq(keyCheck!.passed, false);
    expect_match(keyCheck!.remediation ?? "", /XAI_API_KEY/);
    expect_match(keyCheck!.remediation ?? "", /spike-grok-models-2026-05/);
  } finally {
    if (original !== undefined) process.env["XAI_API_KEY"] = original;
  }
});

test("doctor: with API key + mock client, verifies model id resolves via models.list", async () => {
  const mockClient: GrokClient = {
    responses: { create: async () => makeStream([]) },
    models: {
      list: () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { id: "grok-4.3" };
            yield { id: "grok-4.20-0309-reasoning" };
          },
        } as AsyncIterable<{ id?: string }>),
    },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const checks = await adapter.doctor(CRITIC);
  const idCheck = checks.find((c) => c.name === "grok_model_id");
  expect_truthy(idCheck);
  expect_eq(idCheck!.passed, true);
  expect_match(idCheck!.detail, /grok-4\.3 available/);
});

test("doctor: model id NOT in models.list surfaces remediation pointing at the spike artifact", async () => {
  const mockClient: GrokClient = {
    responses: { create: async () => makeStream([]) },
    models: {
      list: () =>
        ({
          async *[Symbol.asyncIterator]() {
            // Simulate xAI catalog WITHOUT the configured id — e.g.,
            // post-2026-05-15 when grok-4 is retired and the operator
            // hasn't updated the config.
            yield { id: "grok-5" };
            yield { id: "grok-4.20-0309-reasoning" };
          },
        } as AsyncIterable<{ id?: string }>),
    },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const checks = await adapter.doctor(CRITIC);
  const idCheck = checks.find((c) => c.name === "grok_model_id");
  expect_truthy(idCheck);
  expect_eq(idCheck!.passed, false);
  expect_match(idCheck!.remediation ?? "", /spike-grok-models-2026-05/);
});

test("doctor: non-grok-* model id family is flagged by family-prefix check before live models.list call", async () => {
  const c: CriticConfig = {
    ...CRITIC,
    model: { id: "gpt-5.5", params: [] }, // operator typo: pointing at an OpenAI id
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "" });
  const checks = await adapter.doctor(c);
  const familyCheck = checks.find((c) => c.name === "grok_model_id_family");
  expect_truthy(familyCheck);
  expect_eq(familyCheck!.passed, false);
  expect_match(familyCheck!.remediation ?? "", /grok-/);
});

test("doctor: models.list throwing surfaces the error in the model_id check (not a hard crash)", async () => {
  const mockClient: GrokClient = {
    responses: { create: async () => makeStream([]) },
    models: {
      list: () => {
        throw new Error("network unavailable");
      },
    },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const checks = await adapter.doctor(CRITIC);
  const idCheck = checks.find((c) => c.name === "grok_model_id");
  expect_truthy(idCheck);
  expect_eq(idCheck!.passed, false);
  expect_match(idCheck!.detail, /network unavailable/);
});

// ---------------------------------------------------------------------------
// Issue #1484 — `gate`-field misshape on validation.qualityGateResults
//
// Real-world observation: Grok frequently echoes the validation evidence
// using a `gate` key instead of the schema-required `command` key. Pre-fix,
// this tripped parseCriticResult inside the adapter and forced a
// permanent_failure even though the validation block is informational and
// is overwritten with deterministic packet evidence after parsing. The fix
// is to route the parsed model JSON through the shared normalizer
// (originally Cursor-only) so the bad entry is dropped at the adapter
// boundary rather than failing the entire run.

const MISSHAPEN_GROK_GATE_ENTRY = {
  gate: "make sage-quality-gates",
  exitCode: 0,
  durationMs: 1234,
  startedAt: "2026-05-15T00:00:00Z",
  finishedAt: "2026-05-15T00:00:02Z",
  logExcerpt: "ok",
};

const MISSHAPEN_GROK_RESPONSE_JSON = JSON.stringify({
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
    qualityGateResults: [MISSHAPEN_GROK_GATE_ENTRY],
    qualityGatesMissing: [],
  },
  confidence: "high",
});

test("review: model emits `gate` instead of `command` in qualityGateResults — adapter drops misshape and result is complete (issue #1484)", async () => {
  const mockClient: GrokClient = {
    responses: {
      create: async () =>
        makeStream([
          deltaEvent(MISSHAPEN_GROK_RESPONSE_JSON),
          completedEvent(),
        ]),
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  // Pre-fix this was `error` with `grok critic JSON failed schema validation`.
  expect_eq(result.status, "complete", "result must NOT be permanent_failure");
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.findings.length, 1);
  // The validation block gets overwritten with packet evidence (empty in
  // this test packet) — ends up empty AND schema-valid.
  expect_eq(result.validation.qualityGateResults.length, 0);
});

// ---------------------------------------------------------------------------
// Cycle 6.3 — per-critic telemetry on the returned CriticResult.
// Grok exposes input/output via response.usage on the completed event
// (latest non-null wins, captured in lastUsage). Cached-prefix tokens
// are not exposed on the current GrokUsage interface.

test("review: CriticResult carries tokensInput/Output + retries from response.usage (success path)", async () => {
  const mockClient: GrokClient = {
    responses: {
      create: async () =>
        makeStream([
          deltaEvent(APPROVED_RESPONSE_JSON.slice(0, 30)),
          deltaEvent(APPROVED_RESPONSE_JSON.slice(30)),
          completedEvent({ inputTokens: 1200, outputTokens: 240 }),
        ]),
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "test-key", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "complete");
  expect_eq(result.tokensInput, 1200);
  expect_eq(result.tokensOutput, 240);
  // GrokUsage today does not break out cached input tokens.
  expect_eq(result.tokensCached, undefined);
  expect_eq(result.retries, 0);
});

test("review: CriticResult omits token fields when response.usage absent", async () => {
  const mockClient: GrokClient = {
    responses: {
      create: async () =>
        makeStream([
          deltaEvent(APPROVED_RESPONSE_JSON.slice(0, 30)),
          deltaEvent(APPROVED_RESPONSE_JSON.slice(30)),
          completedEvent(), // no inputTokens / outputTokens
        ]),
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "test-key", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "complete");
  expect_eq(result.tokensInput, undefined);
  expect_eq(result.tokensOutput, undefined);
  expect_eq(result.retries, 0);
});
