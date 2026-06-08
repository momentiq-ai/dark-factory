// Cycle 20 — Phase B unit tests for the MiniMax-direct SDK adapter
// (OpenRouter's OpenAI-compatible Chat Completions endpoint).
//
// These cover the SDK-mock path (success, retry, error, truncation,
// abort) AND the pure-helper exports (extractOpenRouterApiErrorStatus,
// isMinimaxPermanentFailure). The SDK is mocked via the constructor's
// `createClient` factory so the tests do not require the `openai`
// runtime nor a live OPEN_ROUTER_API_KEY.
//
// The mocks intentionally stay narrow and shape-compatible with the
// real openai SDK Chat-Completions stream: each mock chunk is the
// minimal shape needed to exercise one code path, so an adapter
// regression that depends on a wider field surface (e.g., starts
// reading a new field) becomes visible at test time rather than
// discoverable in production.

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
  MINIMAX_PERMANENT_STATUS,
  MinimaxDirectSdkAdapter,
  extractOpenRouterApiErrorStatus,
  isMinimaxPermanentFailure,
  OPENROUTER_BASE_URL,
  type MinimaxClient,
  type MinimaxStreamChunk,
} from "../src/adapters/minimax-direct-sdk.js";
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
    timestamp: "2026-06-06T00:00:00Z",
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
  id: "minimax-local-chief",
  name: "MiniMax Local Critic",
  adapter: "minimax-direct-sdk",
  required: false,
  runtime: "local",
  model: { id: "minimax-m3", params: [] },
};

function makeStream(chunks: MinimaxStreamChunk[]): AsyncIterable<MinimaxStreamChunk> {
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

function deltaChunk(content: string): MinimaxStreamChunk {
  return { choices: [{ delta: { content }, finish_reason: null, index: 0 }] };
}

function finishChunk(finishReason: "stop" | "length" | "content_filter"): MinimaxStreamChunk {
  return { choices: [{ delta: {}, finish_reason: finishReason, index: 0 }] };
}

function usageChunk(
  options: { promptTokens?: number; completionTokens?: number; cachedTokens?: number } = {},
): MinimaxStreamChunk {
  // OpenAI streaming contract: terminal chunk for usage has `choices: []`
  // and the `usage` block populated when `stream_options.include_usage`
  // was set. OpenRouter additionally surfaces the cached-prefix portion
  // under `prompt_tokens_details.cached_tokens`.
  return {
    choices: [],
    usage: {
      ...(options.promptTokens !== undefined ? { prompt_tokens: options.promptTokens } : {}),
      ...(options.completionTokens !== undefined
        ? { completion_tokens: options.completionTokens }
        : {}),
      ...(options.cachedTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: options.cachedTokens } }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers

test("extractOpenRouterApiErrorStatus: reads status off APIError-like errors", () => {
  expect_eq(extractOpenRouterApiErrorStatus({ status: 404 }), 404);
  expect_eq(extractOpenRouterApiErrorStatus({ response: { status: 429 } }), 429);
  expect_eq(extractOpenRouterApiErrorStatus(new Error("transport blip")), null);
  expect_eq(extractOpenRouterApiErrorStatus(null), null);
  expect_eq(extractOpenRouterApiErrorStatus("nope"), null);
});

test("isMinimaxPermanentFailure: classifies HTTP statuses correctly", () => {
  for (const s of MINIMAX_PERMANENT_STATUS) {
    expect_eq(isMinimaxPermanentFailure(s), true, `status ${s} should be permanent`);
  }
  // 5xx + transient → retryable
  expect_eq(isMinimaxPermanentFailure(500), false);
  expect_eq(isMinimaxPermanentFailure(503), false);
  expect_eq(isMinimaxPermanentFailure(504), false);
  // No status → retryable (transport-level error)
  expect_eq(isMinimaxPermanentFailure(null), false);
});

// ---------------------------------------------------------------------------
// Adapter declaration

test("MinimaxDirectSdkAdapter declares requiredEnvVars = ['OPEN_ROUTER_API_KEY']", () => {
  const adapter = new MinimaxDirectSdkAdapter();
  expect_deep([...adapter.requiredEnvVars], ["OPEN_ROUTER_API_KEY"]);
});

test("MinimaxDirectSdkAdapter id is 'minimax-direct-sdk'", () => {
  const adapter = new MinimaxDirectSdkAdapter();
  expect_eq(adapter.id, "minimax-direct-sdk");
});

// ---------------------------------------------------------------------------
// review() — happy path

test("review: streams chunk.delta.content, parses JSON, returns success", async () => {
  const events: TelemetryEvent[] = [];
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async (params) => {
          // Verify the adapter sent a JSON-only Chat Completions request
          // with `stream_options.include_usage` enabled.
          expect_eq(params.model, "minimax-m3");
          expect_eq(params.response_format?.type, "json_object");
          expect_eq(params.stream, true);
          expect_eq(params.stream_options?.include_usage, true);
          expect_eq(params.messages.length, 1);
          expect_eq(params.messages[0]?.role, "user");
          return makeStream([
            deltaChunk(APPROVED_RESPONSE_JSON.slice(0, 30)),
            deltaChunk(APPROVED_RESPONSE_JSON.slice(30)),
            finishChunk("stop"),
            usageChunk({ promptTokens: 1500, completionTokens: 280 }),
          ]);
        },
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "test-key", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
    emit: (e) => events.push(e),
  });
  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.criticId, "minimax-local-chief");

  // Telemetry: critic_run_started + critic_run_finished, both tagged
  // with criticId AND adapter.
  const started = events.find((e) => e.event === "critic_run_started");
  const finished = events.find((e) => e.event === "critic_run_finished");
  expect_truthy(started, "expected critic_run_started");
  expect_eq(started!.criticId, "minimax-local-chief");
  expect_eq(started!.adapter, "minimax-direct-sdk");
  expect_truthy(finished, "expected critic_run_finished");
  expect_eq(finished!.criticId, "minimax-local-chief");
  expect_eq(finished!.tokensIn, 1500);
  expect_eq(finished!.tokensOut, 280);
  expect_eq(finished!.retryCount, 0); // first-attempt success
});

test("review: baseUrl option threads through to the SDK client constructor", async () => {
  const seenBaseUrls: string[] = [];
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () =>
          makeStream([deltaChunk(APPROVED_RESPONSE_JSON), finishChunk("stop"), usageChunk()]),
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({
    apiKey: "k",
    baseUrl: "https://alt.openrouter.example/v1",
    createClient: (_apiKey, baseUrl) => {
      seenBaseUrls.push(baseUrl);
      return mockClient;
    },
  });
  await adapter.review(PACKET, CRITIC, { blockingSeverities: ["blocker"] });
  expect_deep(seenBaseUrls, ["https://alt.openrouter.example/v1"]);
});

test("review: default baseUrl is OpenRouter's /v1 endpoint", async () => {
  const seenBaseUrls: string[] = [];
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () =>
          makeStream([deltaChunk(APPROVED_RESPONSE_JSON), finishChunk("stop"), usageChunk()]),
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({
    apiKey: "k",
    createClient: (_apiKey, baseUrl) => {
      seenBaseUrls.push(baseUrl);
      return mockClient;
    },
  });
  await adapter.review(PACKET, CRITIC, { blockingSeverities: ["blocker"] });
  expect_deep(seenBaseUrls, [OPENROUTER_BASE_URL]);
  expect_eq(OPENROUTER_BASE_URL, "https://openrouter.ai/api/v1");
});

// ---------------------------------------------------------------------------
// review() — OpenRouter provider routing (data-collection compliance default)

test("review: sends provider.data_collection='deny' by default (compliance default)", async () => {
  let seenProvider: unknown;
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async (params) => {
          seenProvider = params.provider;
          return makeStream([deltaChunk(APPROVED_RESPONSE_JSON), finishChunk("stop"), usageChunk()]);
        },
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  await adapter.review(PACKET, CRITIC, { blockingSeverities: ["blocker"] });
  expect_deep(seenProvider, { data_collection: "deny" });
});

test("review: dataCollection option overrides the routing preference (escape hatch)", async () => {
  let seenProvider: unknown;
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async (params) => {
          seenProvider = params.provider;
          return makeStream([deltaChunk(APPROVED_RESPONSE_JSON), finishChunk("stop"), usageChunk()]);
        },
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({
    apiKey: "k",
    dataCollection: "allow",
    createClient: () => mockClient,
  });
  await adapter.review(PACKET, CRITIC, { blockingSeverities: ["blocker"] });
  expect_deep(seenProvider, { data_collection: "allow" });
});

// ---------------------------------------------------------------------------
// review() — failure paths

test("review: missing OPEN_ROUTER_API_KEY → permanent failure (no SDK call)", async () => {
  const calls: number[] = [];
  const adapter = new MinimaxDirectSdkAdapter({
    apiKey: "", // empty string falsy
    createClient: () => {
      calls.push(1);
      return {
        chat: { completions: { create: async () => makeStream([]) } },
        models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
      };
    },
  });
  // Stub env so this is deterministic regardless of caller env.
  const original = process.env["OPEN_ROUTER_API_KEY"];
  delete process.env["OPEN_ROUTER_API_KEY"];
  try {
    const result = await adapter.review(PACKET, CRITIC, { blockingSeverities: ["blocker"] });
    expect_eq(result.status, "error");
    expect_match(result.error?.message ?? "", /OPEN_ROUTER_API_KEY/);
    expect_eq(result.error?.retryable, false);
    // The createClient factory was NEVER invoked.
    expect_eq(calls.length, 0);
  } finally {
    if (original !== undefined) process.env["OPEN_ROUTER_API_KEY"] = original;
  }
});

test("review: HTTP 429 rate-limit error → permanent failure (no retry)", async () => {
  const events: TelemetryEvent[] = [];
  let attemptCount = 0;
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () => {
          attemptCount++;
          const e = new Error("rate limit exceeded") as Error & { status?: number };
          e.status = 429;
          throw e;
        },
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
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
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () => {
          attemptCount++;
          if (attemptCount < 3) {
            const e = new Error("upstream timeout") as Error & { status?: number };
            e.status = 500;
            throw e;
          }
          return makeStream([deltaChunk(APPROVED_RESPONSE_JSON), finishChunk("stop"), usageChunk()]);
        },
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  // Inject a no-op sleep so the retry budget exercises the loop without
  // wall-clock waits. The real RETRY_BACKOFF_MS schedule is exercised
  // by cursor-retry-loop tests that target the loop in isolation.
  const adapter = new MinimaxDirectSdkAdapter({
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
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () => {
          attemptCount++;
          const e = new Error("server still broken") as Error & { status?: number };
          e.status = 500;
          throw e;
        },
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({
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

test("review: finish_reason='length' (truncation) → permanent failure with 'incomplete' code + preserved partial text", async () => {
  // OpenAI Chat Completions emits `finish_reason: 'length'` when the
  // response was truncated at `max_tokens`. The adapter must classify
  // as permanent (retrying re-trips the same truncation), use a
  // distinct errorCode (`incomplete` vs `transport_error`), and
  // preserve the partial text for operator inspection.
  let attemptCount = 0;
  const events: TelemetryEvent[] = [];
  const partialText = '{"status":"complete","verd';
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () => {
          attemptCount++;
          return makeStream([
            deltaChunk(partialText),
            finishChunk("length"),
            usageChunk({ promptTokens: 1500, completionTokens: 256 }),
          ]);
        },
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "minimax-test-incomplete-"));
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
    diagnosticsDir: dir,
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.code, "incomplete");
  expect_eq(result.error?.retryable, false);
  expect_eq(attemptCount, 1, "must NOT retry on truncation");
  expect_match(result.error?.message ?? "", /length/);
  // Diagnostic preserved with the partial text
  expect_truthy(result.error?.rawSamplePath, "expected rawSamplePath when diagnosticsDir is set");
  expect_truthy(result.error!.rawSamplePath!.startsWith(dir));
  // Telemetry event tagged correctly
  const errEvent = events.find((e) => e.event === "critic_run_error");
  expect_eq(errEvent?.errorCode, "incomplete");
  expect_eq(errEvent?.status, "incomplete");
});

test("review: finish_reason='content_filter' (safety block) → permanent failure with 'incomplete' code (retry would re-trip)", async () => {
  let attemptCount = 0;
  const events: TelemetryEvent[] = [];
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () => {
          attemptCount++;
          return makeStream([
            deltaChunk("I cannot help with that request."),
            finishChunk("content_filter"),
            usageChunk(),
          ]);
        },
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    emit: (e) => events.push(e),
  });
  expect_eq(result.status, "error");
  expect_eq(result.error?.code, "incomplete");
  expect_eq(result.error?.retryable, false);
  expect_eq(attemptCount, 1, "must NOT retry on safety filter");
  const errEvent = events.find((e) => e.event === "critic_run_error");
  expect_eq(errEvent?.errorCode, "incomplete");
});

test("review: invalid JSON terminal text → permanent failure with rawSamplePath written", async () => {
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () =>
          makeStream([deltaChunk("not valid json at all"), finishChunk("stop"), usageChunk()]),
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "minimax-test-"));
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    diagnosticsDir: dir,
  });
  expect_eq(result.status, "error");
  expect_match(result.error?.message ?? "", /invalid JSON/i);
  expect_truthy(result.error?.rawSamplePath, "expected rawSamplePath when diagnosticsDir is set");
  expect_truthy(result.error!.rawSamplePath!.startsWith(dir));
});

test("review: AbortSignal aborted before stream starts → result is error with aborted summary", async () => {
  const controller = new AbortController();
  controller.abort();
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () => {
          // Should not be reached — runRetryLoop short-circuits at the top
          return makeStream([deltaChunk(APPROVED_RESPONSE_JSON), finishChunk("stop"), usageChunk()]);
        },
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker"],
    signal: controller.signal,
  });
  expect_eq(result.status, "error");
  expect_match(result.error?.message ?? "", /aborted/);
});

// ---------------------------------------------------------------------------
// doctor()

test("doctor: missing OPEN_ROUTER_API_KEY on optional shadow critic does not fail doctor", async () => {
  const original = process.env["OPEN_ROUTER_API_KEY"];
  delete process.env["OPEN_ROUTER_API_KEY"];
  try {
    const adapter = new MinimaxDirectSdkAdapter({ apiKey: "" });
    const checks = await adapter.doctor(CRITIC);
    const keyCheck = checks.find((c) => c.name === "open_router_api_key");
    expect_truthy(keyCheck);
    expect_eq(keyCheck!.passed, true);
    expect_match(keyCheck!.detail, /optional shadow critic/);
    expect_eq(keyCheck!.remediation, undefined);
  } finally {
    if (original !== undefined) process.env["OPEN_ROUTER_API_KEY"] = original;
  }
});

test("doctor: missing OPEN_ROUTER_API_KEY on required critic surfaces actionable remediation", async () => {
  const original = process.env["OPEN_ROUTER_API_KEY"];
  delete process.env["OPEN_ROUTER_API_KEY"];
  try {
    const adapter = new MinimaxDirectSdkAdapter({ apiKey: "" });
    const checks = await adapter.doctor({ ...CRITIC, required: true });
    const keyCheck = checks.find((c) => c.name === "open_router_api_key");
    expect_truthy(keyCheck);
    expect_eq(keyCheck!.passed, false);
    expect_match(keyCheck!.remediation ?? "", /OPEN_ROUTER_API_KEY/);
    expect_match(keyCheck!.remediation ?? "", /OpenRouter/);
  } finally {
    if (original !== undefined) process.env["OPEN_ROUTER_API_KEY"] = original;
  }
});

test("doctor: with API key + mock client, verifies model id resolves via models.list", async () => {
  const mockClient: MinimaxClient = {
    chat: { completions: { create: async () => makeStream([]) } },
    models: {
      list: () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { id: "minimax-m3" };
            yield { id: "MiniMaxAI/MiniMax-M2.7" };
          },
        } as AsyncIterable<{ id?: string }>),
    },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const checks = await adapter.doctor(CRITIC);
  const idCheck = checks.find((c) => c.name === "minimax_model_id");
  expect_truthy(idCheck);
  expect_eq(idCheck!.passed, true);
  expect_match(idCheck!.detail, /minimax-m3 available/);
});

test("doctor: model id NOT in models.list surfaces remediation", async () => {
  const mockClient: MinimaxClient = {
    chat: { completions: { create: async () => makeStream([]) } },
    models: {
      list: () =>
        ({
          async *[Symbol.asyncIterator]() {
            // Simulate OpenRouter's catalog WITHOUT the configured id —
            // e.g., a model-id typo or a future id rename.
            yield { id: "MiniMaxAI/MiniMax-M2.7" };
            yield { id: "MiniMaxAI/MiniMax-M2" };
          },
        } as AsyncIterable<{ id?: string }>),
    },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const checks = await adapter.doctor(CRITIC);
  const idCheck = checks.find((c) => c.name === "minimax_model_id");
  expect_truthy(idCheck);
  expect_eq(idCheck!.passed, false);
  expect_match(idCheck!.remediation ?? "", /OpenRouter/);
});

test("doctor: non-minimax model id family is flagged by family-prefix check before live models.list call", async () => {
  const c: CriticConfig = {
    ...CRITIC,
    model: { id: "gpt-5.5", params: [] }, // operator typo: pointing at an OpenAI id
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "" });
  const checks = await adapter.doctor(c);
  const familyCheck = checks.find((c) => c.name === "minimax_model_id_family");
  expect_truthy(familyCheck);
  expect_eq(familyCheck!.passed, false);
  expect_match(familyCheck!.remediation ?? "", /minimax/);
});

test("doctor: models.list throwing surfaces the error in the model_id check (not a hard crash)", async () => {
  const mockClient: MinimaxClient = {
    chat: { completions: { create: async () => makeStream([]) } },
    models: {
      list: () => {
        throw new Error("network unavailable");
      },
    },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const checks = await adapter.doctor(CRITIC);
  const idCheck = checks.find((c) => c.name === "minimax_model_id");
  expect_truthy(idCheck);
  expect_eq(idCheck!.passed, false);
  expect_match(idCheck!.detail, /network unavailable/);
});

// ---------------------------------------------------------------------------
// Issue #1484 — `gate`-field misshape on validation.qualityGateResults
//
// Real-world observation: models frequently echo the validation evidence
// using a `gate` key instead of the schema-required `command` key. Pre-fix,
// this tripped parseCriticResult inside the adapter and forced a
// permanent_failure even though the validation block is informational and
// is overwritten with deterministic packet evidence after parsing. The fix
// is to route the parsed model JSON through the shared normalizer
// (originally Cursor-only) so the bad entry is dropped at the adapter
// boundary rather than failing the entire run.

const MISSHAPEN_MINIMAX_GATE_ENTRY = {
  gate: "make quality-gates",
  exitCode: 0,
  durationMs: 1234,
  startedAt: "2026-06-06T00:00:00Z",
  finishedAt: "2026-06-06T00:00:02Z",
  logExcerpt: "ok",
};

const MISSHAPEN_MINIMAX_RESPONSE_JSON = JSON.stringify({
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
    qualityGateResults: [MISSHAPEN_MINIMAX_GATE_ENTRY],
    qualityGatesMissing: [],
  },
  confidence: "high",
});

test("review: model emits `gate` instead of `command` in qualityGateResults — adapter drops misshape and result is complete (issue #1484)", async () => {
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () =>
          makeStream([
            deltaChunk(MISSHAPEN_MINIMAX_RESPONSE_JSON),
            finishChunk("stop"),
            usageChunk(),
          ]),
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  // Pre-fix this was `error` with `minimax critic JSON failed schema validation`.
  expect_eq(result.status, "complete", "result must NOT be permanent_failure");
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.findings.length, 1);
  // The validation block gets overwritten with packet evidence (empty in
  // this test packet) — ends up empty AND schema-valid.
  expect_eq(result.validation.qualityGateResults.length, 0);
});

// ---------------------------------------------------------------------------
// Cycle 6.3 — per-critic telemetry on the returned CriticResult.
// MiniMax via OpenRouter exposes input/output via `usage` on the terminal
// chunk when `stream_options.include_usage: true` is sent (latest non-null
// wins, captured in lastUsage). OpenRouter also breaks out the cached-prefix
// portion under `prompt_tokens_details.cached_tokens` → `tokensCached`.

test("review: CriticResult carries tokensInput/Output + retries from usage chunk (success path)", async () => {
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () =>
          makeStream([
            deltaChunk(APPROVED_RESPONSE_JSON.slice(0, 30)),
            deltaChunk(APPROVED_RESPONSE_JSON.slice(30)),
            finishChunk("stop"),
            usageChunk({ promptTokens: 1200, completionTokens: 240, cachedTokens: 800 }),
          ]),
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "test-key", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "complete");
  expect_eq(result.tokensInput, 1200);
  expect_eq(result.tokensOutput, 240);
  // OpenRouter breaks out the cached-prefix portion → tokensCached.
  expect_eq(result.tokensCached, 800);
  expect_eq(result.retries, 0);
});

test("review: CriticResult omits token fields when usage chunk absent", async () => {
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () =>
          makeStream([
            deltaChunk(APPROVED_RESPONSE_JSON.slice(0, 30)),
            deltaChunk(APPROVED_RESPONSE_JSON.slice(30)),
            finishChunk("stop"),
            // no usage chunk
          ]),
      },
    },
    models: { list: async () => makeStream([]) as unknown as AsyncIterable<{ id?: string }> },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "test-key", createClient: () => mockClient });
  const result = await adapter.review(PACKET, CRITIC, {
    blockingSeverities: ["blocker", "high"],
  });
  expect_eq(result.status, "complete");
  expect_eq(result.tokensInput, undefined);
  expect_eq(result.tokensOutput, undefined);
  expect_eq(result.retries, 0);
});
