// Issue #106 — per-adapter coverage for the new per-finding
// `requiresHumanJudgment?: boolean` field. Each adapter must:
//   1. Pass the field through verbatim when the LLM returns it.
//   2. Preserve the omitted-vs-false distinction: a model response that
//      omits the field on a finding emits a finding WITHOUT the field
//      (NOT `false`). Consumers rely on this to distinguish "the critic
//      didn't report" from "the critic reported false".
//   3. Reject non-boolean values at the schema boundary.
//
// Adapters under test:
//   - codex-sdk         (SDK mock via `createCodex`)
//   - gemini-sdk        (SDK mock via `createClient`)
//   - grok-direct-sdk   (SDK mock via `createClient`)
//   - minimax-direct-sdk (SDK mock via `createClient`; Cycle 20)
//   - cursor-cli        (subprocess runner mock via `runCursorAgentCli`)
//   - cursor-sdk        (no test seam for the SDK Agent class — covered
//                        via the schema boundary the adapter routes
//                        through: `parseCriticResult`. The adapter
//                        copies the finding straight from the parsed
//                        model output, so parser coverage IS the
//                        wire-through coverage for that path. Schema-
//                        level round-trip is also asserted in
//                        `packages/schemas/tests/review-finding-requires-human-judgment.test.ts`.)
//
// All adapter tests use the existing fixture-shaped APPROVED_RESPONSE
// pattern and extend it with a CHANGES_REQUESTED + findings payload so
// the new field rides through the same code path findings normally
// take.

import { test } from "vitest";
import {
  expect_eq,
  expect_truthy,
  expect_throws,
} from "./_assert-shim.js";
import { parseCriticResult, SchemaError } from "@momentiq/dark-factory-schemas";
import type { CriticConfig, ReviewPacket } from "@momentiq/dark-factory-schemas";

import {
  CodexSdkAdapter,
  type CodexClient,
  type CodexTurnResult,
  type CodexThread,
} from "../src/adapters/codex-sdk.js";
import {
  GeminiSdkAdapter,
  type GeminiClient,
  type GeminiStreamChunk,
} from "../src/adapters/gemini-sdk.js";
import {
  GrokDirectSdkAdapter,
  type GrokClient,
  type GrokStreamEvent,
} from "../src/adapters/grok-direct-sdk.js";
import {
  MinimaxDirectSdkAdapter,
  type MinimaxClient,
  type MinimaxStreamChunk,
} from "../src/adapters/minimax-direct-sdk.js";
import {
  CursorCliAdapter,
  type CursorCliRunOutcome,
} from "../src/adapters/cursor-cli.js";

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
    timestamp: "2026-06-01T00:00:00Z",
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

// One blocker-severity finding with file (schema requires file for blocker)
// plus one note-severity finding without file (the lower-severity path).
function modelResponseWithFindings(opts: {
  finding1Flag?: boolean;
  finding2Flag?: boolean;
  omitFinding2Flag?: boolean;
}): string {
  const finding1: Record<string, unknown> = {
    severity: "blocker",
    category: "design",
    file: "src/api.ts",
    line: 42,
    evidence: "method signature ambiguous",
    impact: "consumers may pass wrong arg",
    requiredFix: "rename parameter to clarify intent",
  };
  if (opts.finding1Flag !== undefined) {
    finding1["requiresHumanJudgment"] = opts.finding1Flag;
  }
  const finding2: Record<string, unknown> = {
    severity: "note",
    category: "other",
    evidence: "naming style",
    impact: "subjective; minor",
    requiredFix: "consider renaming",
  };
  if (!opts.omitFinding2Flag && opts.finding2Flag !== undefined) {
    finding2["requiresHumanJudgment"] = opts.finding2Flag;
  }
  return JSON.stringify({
    status: "complete",
    verdict: "CHANGES_REQUESTED",
    requiresHumanJudgment: false,
    summary: "two findings",
    findings: [finding1, finding2],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
  });
}

const BLOCKING = ["blocker", "high"];

// ---------------------------------------------------------------------------
// codex-sdk

const CODEX_CRITIC: CriticConfig = {
  id: "codex-local-chief",
  name: "Codex Local Critic",
  adapter: "codex-sdk",
  required: false,
  runtime: "local",
  model: { id: "gpt-5.5-codex", params: [{ id: "reasoning_effort", value: "high" }] },
  auth: "api",
};

function makeCodexClient(finalResponse: string): CodexClient {
  return {
    startThread: () => {
      const thread = {
        get id() {
          return "thread_test_1";
        },
        run: async (): Promise<CodexTurnResult> => ({
          finalResponse,
          items: [],
          usage: null,
        }),
      } as CodexThread;
      return thread;
    },
  };
}

test("codex-sdk: finding.requiresHumanJudgment=true rides through to emitted CriticResult", async () => {
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => makeCodexClient(
      modelResponseWithFindings({ finding1Flag: true, omitFinding2Flag: true }),
    ),
  });
  const result = await adapter.review(PACKET, CODEX_CRITIC, { blockingSeverities: BLOCKING });
  expect_eq(result.status, "complete");
  expect_eq(result.findings[0]?.requiresHumanJudgment, true);
  // Second finding omitted the field → emitted without it (NOT false)
  expect_eq(result.findings[1]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in result.findings[1]!, false);
});

test("codex-sdk: omitted finding.requiresHumanJudgment does NOT default to false", async () => {
  const adapter = new CodexSdkAdapter({
    apiKey: "k",
    createCodex: () => makeCodexClient(modelResponseWithFindings({ omitFinding2Flag: true })),
  });
  const result = await adapter.review(PACKET, CODEX_CRITIC, { blockingSeverities: BLOCKING });
  // First finding omitted the field too → must be absent (NOT false)
  expect_eq(result.findings[0]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in result.findings[0]!, false);
  expect_eq(result.findings[1]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in result.findings[1]!, false);
});

// ---------------------------------------------------------------------------
// gemini-sdk

const GEMINI_CRITIC: CriticConfig = {
  id: "gemini-local-chief",
  name: "Gemini Local Critic",
  adapter: "gemini-sdk",
  required: false,
  runtime: "local",
  model: { id: "gemini-3.1-pro", params: [] },
};

function makeGeminiStream(text: string): AsyncIterable<GeminiStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { text };
    },
  };
}

test("gemini-sdk: finding.requiresHumanJudgment=true rides through to emitted CriticResult", async () => {
  const text = modelResponseWithFindings({ finding1Flag: true, omitFinding2Flag: true });
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () => makeGeminiStream(text),
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, GEMINI_CRITIC, { blockingSeverities: BLOCKING });
  expect_eq(result.status, "complete");
  expect_eq(result.findings[0]?.requiresHumanJudgment, true);
  expect_eq(result.findings[1]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in result.findings[1]!, false);
});

test("gemini-sdk: omitted finding.requiresHumanJudgment does NOT default to false", async () => {
  const text = modelResponseWithFindings({ omitFinding2Flag: true });
  const mockClient: GeminiClient = {
    models: {
      generateContentStream: async () => makeGeminiStream(text),
    },
  };
  const adapter = new GeminiSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, GEMINI_CRITIC, { blockingSeverities: BLOCKING });
  expect_eq(result.findings[0]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in result.findings[0]!, false);
});

// ---------------------------------------------------------------------------
// grok-direct-sdk

const GROK_CRITIC: CriticConfig = {
  id: "grok-local-chief",
  name: "Grok Local Critic",
  adapter: "grok-direct-sdk",
  required: false,
  runtime: "local",
  model: { id: "grok-4.3", params: [] },
};

function makeGrokStream(text: string): AsyncIterable<GrokStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "response.output_text.delta", delta: text };
      yield { type: "response.completed", response: { usage: {} } };
    },
  };
}

test("grok-direct-sdk: finding.requiresHumanJudgment=true rides through to emitted CriticResult", async () => {
  const text = modelResponseWithFindings({ finding1Flag: true, omitFinding2Flag: true });
  const mockClient: GrokClient = {
    responses: {
      create: async () => makeGrokStream(text),
    },
    models: {
      list: async () => ({
        async *[Symbol.asyncIterator]() {
          // empty list
        },
      }),
    },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, GROK_CRITIC, { blockingSeverities: BLOCKING });
  expect_eq(result.status, "complete");
  expect_eq(result.findings[0]?.requiresHumanJudgment, true);
  expect_eq(result.findings[1]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in result.findings[1]!, false);
});

test("grok-direct-sdk: omitted finding.requiresHumanJudgment does NOT default to false", async () => {
  const text = modelResponseWithFindings({ omitFinding2Flag: true });
  const mockClient: GrokClient = {
    responses: {
      create: async () => makeGrokStream(text),
    },
    models: {
      list: async () => ({
        async *[Symbol.asyncIterator]() {
          // empty list
        },
      }),
    },
  };
  const adapter = new GrokDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, GROK_CRITIC, { blockingSeverities: BLOCKING });
  expect_eq(result.findings[0]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in result.findings[0]!, false);
});

// ---------------------------------------------------------------------------
// minimax-direct-sdk (Cycle 20)

const MINIMAX_CRITIC: CriticConfig = {
  id: "minimax-local-chief",
  name: "MiniMax Local Critic",
  adapter: "minimax-direct-sdk",
  required: false,
  runtime: "local",
  model: { id: "minimax-m3", params: [] },
};

function makeMinimaxStream(text: string): AsyncIterable<MinimaxStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: text }, finish_reason: null, index: 0 }] };
      yield { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] };
      yield { choices: [], usage: {} };
    },
  };
}

test("minimax-direct-sdk: finding.requiresHumanJudgment=true rides through to emitted CriticResult", async () => {
  const text = modelResponseWithFindings({ finding1Flag: true, omitFinding2Flag: true });
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () => makeMinimaxStream(text),
      },
    },
    models: {
      list: async () => ({
        async *[Symbol.asyncIterator]() {
          // empty list
        },
      }),
    },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, MINIMAX_CRITIC, { blockingSeverities: BLOCKING });
  expect_eq(result.status, "complete");
  expect_eq(result.findings[0]?.requiresHumanJudgment, true);
  expect_eq(result.findings[1]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in result.findings[1]!, false);
});

test("minimax-direct-sdk: omitted finding.requiresHumanJudgment does NOT default to false", async () => {
  const text = modelResponseWithFindings({ omitFinding2Flag: true });
  const mockClient: MinimaxClient = {
    chat: {
      completions: {
        create: async () => makeMinimaxStream(text),
      },
    },
    models: {
      list: async () => ({
        async *[Symbol.asyncIterator]() {
          // empty list
        },
      }),
    },
  };
  const adapter = new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
  const result = await adapter.review(PACKET, MINIMAX_CRITIC, { blockingSeverities: BLOCKING });
  expect_eq(result.findings[0]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in result.findings[0]!, false);
});

// ---------------------------------------------------------------------------
// cursor-cli

const CURSOR_CLI_CRITIC: CriticConfig = {
  id: "cursor-cli-chief",
  name: "Cursor CLI Critic",
  adapter: "cursor-cli",
  required: false,
  runtime: "local",
  model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
  auth: "chatgpt",
};

function makeCursorCliOutcome(resultText: string): CursorCliRunOutcome {
  return {
    events: [
      {
        type: "system",
        subtype: "init",
        apiKeySource: "login",
        session_id: "session-test-1",
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: resultText }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: resultText,
        session_id: "session-test-1",
        duration_ms: 100,
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    ],
    exitCode: 0,
    stderr: "",
    spawnError: null,
  };
}

test("cursor-cli: finding.requiresHumanJudgment=true rides through to emitted CriticResult", async () => {
  const text = modelResponseWithFindings({ finding1Flag: true, omitFinding2Flag: true });
  const adapter = new CursorCliAdapter({
    runCursorAgentCli: async () => makeCursorCliOutcome(text),
  });
  const result = await adapter.review(PACKET, CURSOR_CLI_CRITIC, { blockingSeverities: BLOCKING });
  expect_eq(result.status, "complete");
  expect_eq(result.findings[0]?.requiresHumanJudgment, true);
  expect_eq(result.findings[1]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in result.findings[1]!, false);
});

test("cursor-cli: omitted finding.requiresHumanJudgment does NOT default to false", async () => {
  const text = modelResponseWithFindings({ omitFinding2Flag: true });
  const adapter = new CursorCliAdapter({
    runCursorAgentCli: async () => makeCursorCliOutcome(text),
  });
  const result = await adapter.review(PACKET, CURSOR_CLI_CRITIC, { blockingSeverities: BLOCKING });
  expect_eq(result.findings[0]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in result.findings[0]!, false);
});

// ---------------------------------------------------------------------------
// cursor-sdk — covered via the parser boundary the adapter routes through.
//
// The CursorSdkAdapter has no DI seam for the @cursor/sdk Agent client;
// it instantiates the real SDK at construction and exercises it inside
// `attemptReview`. The adapter's only post-processing of findings is
// `parseCriticResult(...)` — see `cursor-sdk.ts:~345`. So the
// boundary-test below proves the cursor-sdk wire-through path is byte-
// identical to the other adapters' (and to a future cursor-sdk-side
// review whose mock Agent returns the same JSON).

test("cursor-sdk (parser boundary): finding.requiresHumanJudgment passes through parseCriticResult", () => {
  const raw = JSON.parse(modelResponseWithFindings({
    finding1Flag: true,
    omitFinding2Flag: true,
  })) as Record<string, unknown>;
  raw["criticId"] = "cursor-sdk-chief";
  raw["reviewer"] = {
    name: "Cursor Local Critic",
    adapter: "cursor-sdk",
    runtime: "local",
    model: { id: "gpt-5.5", params: [] },
  };
  const parsed = parseCriticResult(raw, BLOCKING as Parameters<typeof parseCriticResult>[1]);
  expect_eq(parsed.findings[0]?.requiresHumanJudgment, true);
  expect_eq(parsed.findings[1]?.requiresHumanJudgment, undefined);
  expect_eq("requiresHumanJudgment" in parsed.findings[1]!, false);
});

test("cursor-sdk (parser boundary): non-boolean finding.requiresHumanJudgment is rejected", () => {
  const raw = {
    criticId: "cursor-sdk-chief",
    status: "complete",
    verdict: "APPROVED",
    requiresHumanJudgment: false,
    summary: "ok",
    findings: [
      {
        severity: "note",
        category: "other",
        evidence: "x",
        impact: "x",
        requiredFix: "x",
        requiresHumanJudgment: "yes-please",
      },
    ],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
    reviewer: {
      name: "Cursor Local Critic",
      adapter: "cursor-sdk",
      runtime: "local",
      model: { id: "gpt-5.5", params: [] },
    },
  };
  expect_throws(
    () => parseCriticResult(raw, BLOCKING as Parameters<typeof parseCriticResult>[1]),
    SchemaError,
  );
});

// ---------------------------------------------------------------------------
// Sanity: the Codex output-schema literal must include the new optional
// property so the model is permitted to emit it. The schema is generated
// from the Zod source-of-truth at module load time; this test pins the
// shape.

test("CRITIC_RESULT_JSON_SCHEMA: findings[].requiresHumanJudgment property declared in schema", async () => {
  const { CRITIC_RESULT_JSON_SCHEMA } = await import(
    "../src/adapters/critic-result-schema.js"
  );
  const schema = CRITIC_RESULT_JSON_SCHEMA as Record<string, unknown>;
  const props = schema["properties"] as Record<string, unknown>;
  const findings = props["findings"] as Record<string, unknown>;
  const items = findings["items"] as Record<string, unknown>;
  const itemProps = items["properties"] as Record<string, unknown>;
  expect_truthy(
    itemProps["requiresHumanJudgment"] !== undefined,
    "expected findings[].requiresHumanJudgment in JSON schema",
  );
});

// ---------------------------------------------------------------------------
// Prompt template: the JSON_SCHEMA_DESCRIPTION emitted by
// `compileCriticPrompt` must mention the per-finding field so the LLM
// knows the field exists and how to use it. Without this the field is a
// schema-only widget the model will never populate.

test("prompt template advertises per-finding requiresHumanJudgment instruction", async () => {
  const { compileCriticPrompt } = await import("../src/prompt.js");
  const compiled = compileCriticPrompt({
    packet: PACKET,
    critic: CODEX_CRITIC,
    blockingSeverities: ["blocker", "high"],
    treatDiffAsUntrusted: true,
  });
  // The instruction line must be present and reference the per-finding
  // surface explicitly (distinct from the result-level field already
  // mentioned in the verdict guidance).
  expect_truthy(
    /per-finding requiresHumanJudgment/i.test(compiled.text),
    "prompt must instruct the LLM how to use the per-finding field",
  );
});
