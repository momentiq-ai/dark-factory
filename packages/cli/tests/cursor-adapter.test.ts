
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
  buildModelSelection,
  checkRunFinished,
  extractRuntimeModel,
  normalizeCriticEcho,
} from "../src/adapters/cursor-sdk.js";
import { parseCriticResult, SchemaError, type CriticConfig } from "@momentiq/dark-factory-schemas";

const CRITIC_NO_PARAMS: CriticConfig = {
  id: "x", name: "x", adapter: "cursor-sdk", required: true, runtime: "local",
  model: { id: "gpt-5.5", params: [] },
};

const CRITIC_WITH_PARAMS: CriticConfig = {
  id: "x", name: "x", adapter: "cursor-sdk", required: true, runtime: "local",
  model: {
    id: "gpt-5.5",
    params: [
      { id: "reasoning", value: "extra-high" },
      { id: "context", value: "1m" },
      { id: "fast", value: false }, // boolean to test coercion
    ],
  },
};

test("buildModelSelection passes id alone when params is empty", () => {
  const sel = buildModelSelection(CRITIC_NO_PARAMS);
  expect_eq(sel.id, "gpt-5.5");
  expect_eq(sel.params, undefined);
});

test("buildModelSelection forwards configured params to SDK shape", () => {
  // Regression for: previous adapter passed only `{ id }`, dropping params.
  // Cursor SDK then resolved to model default (gpt-5.5 default = reasoning=medium)
  // even when the config asked for extra-high. Reviewer metadata still echoed
  // the configured params, so the artifact silently lied. Caught by the
  // upgraded critic (gpt-5.5 extra-high) reviewing the very commit that tried
  // to bump reasoning.
  const sel = buildModelSelection(CRITIC_WITH_PARAMS);
  expect_eq(sel.id, "gpt-5.5");
  expect_deep(sel.params, [
    { id: "reasoning", value: "extra-high" },
    { id: "context", value: "1m" },
    { id: "fast", value: "false" }, // coerced from boolean
  ]);
});

test("buildModelSelection coerces numeric param values to strings", () => {
  const critic: CriticConfig = {
    id: "x", name: "x", adapter: "cursor-sdk", required: true, runtime: "local",
    model: { id: "gpt-5.5", params: [{ id: "max_tokens", value: 8192 }] },
  };
  const sel = buildModelSelection(critic);
  expect_deep(sel.params, [{ id: "max_tokens", value: "8192" }]);
});

const REVIEWER_OK = {
  name: "Cursor Local Critic",
  adapter: "cursor-sdk",
  runtime: "local",
  model: { id: "gpt-5.5", params: [] },
};

const FULL_GATE = {
  command: "make test",
  exitCode: 0,
  passed: true,
  durationMs: 100,
  startedAt: "2026-05-03T00:00:00Z",
  finishedAt: "2026-05-03T00:00:01Z",
  logExcerpt: "ok",
};

test("normalizeCriticEcho strips malformed validation entries (adapter-side leniency)", () => {
  const raw = {
    criticId: "x",
    status: "complete",
    verdict: "APPROVED",
    requiresHumanJudgment: false,
    summary: "ok",
    findings: [],
    validation: {
      qualityGateResults: [
        FULL_GATE,
        { command: "make test-lint", passed: true /* missing exitCode */ },
        "not-an-object",
      ],
      qualityGatesMissing: [],
    },
    confidence: "high",
    reviewer: REVIEWER_OK,
  };
  const cleaned = normalizeCriticEcho(raw) as { validation: { qualityGateResults: unknown[] } };
  expect_eq(cleaned.validation.qualityGateResults.length, 1);
  // and the cleaned form parses strictly
  const parsed = parseCriticResult(cleaned, ["blocker", "high"]);
  expect_eq(parsed.validation.qualityGateResults.length, 1);
});

test("normalizeCriticEcho drops echoes missing logExcerpt (regression for predicate drift)", () => {
  // Critic finding c048d04 §schema §2 — earlier predicate accepted echoes
  // missing logExcerpt; strict parse then threw. Predicate must now match
  // parseQualityGateResult exactly.
  const echoMissingLogExcerpt = {
    command: "make test-lint",
    passed: true,
    exitCode: 0,
    durationMs: 100,
    startedAt: "2026-05-03T00:00:00Z",
    finishedAt: "2026-05-03T00:00:01Z",
    // logExcerpt intentionally omitted
  };
  const raw = {
    criticId: "x",
    status: "complete",
    verdict: "APPROVED",
    requiresHumanJudgment: false,
    summary: "ok",
    findings: [],
    validation: {
      qualityGateResults: [echoMissingLogExcerpt, FULL_GATE],
      qualityGatesMissing: [],
    },
    confidence: "high",
    reviewer: REVIEWER_OK,
  };
  const cleaned = normalizeCriticEcho(raw) as { validation: { qualityGateResults: unknown[] } };
  expect_eq(cleaned.validation.qualityGateResults.length, 1, "missing-logExcerpt entry must be dropped");
  // post-normalize must parse successfully through the strict schema
  const parsed = parseCriticResult(cleaned, ["blocker", "high"]);
  expect_eq(parsed.validation.qualityGateResults.length, 1);
});

test("normalizeCriticEcho drops echoes with non-integer exitCode (regression)", () => {
  const raw = {
    criticId: "x",
    status: "complete",
    verdict: "APPROVED",
    requiresHumanJudgment: false,
    summary: "ok",
    findings: [],
    validation: {
      qualityGateResults: [
        { ...FULL_GATE, exitCode: 0.5 },
        { ...FULL_GATE, durationMs: 1.5 },
        FULL_GATE,
      ],
      qualityGatesMissing: [],
    },
    confidence: "high",
    reviewer: REVIEWER_OK,
  };
  const cleaned = normalizeCriticEcho(raw) as { validation: { qualityGateResults: unknown[] } };
  expect_eq(cleaned.validation.qualityGateResults.length, 1, "only the strictly-typed entry survives");
});

test("normalizeCriticEcho is a no-op when validation is well-formed", () => {
  const raw = {
    validation: { qualityGateResults: [FULL_GATE], qualityGatesMissing: [] },
  };
  const cleaned = normalizeCriticEcho(raw) as { validation: { qualityGateResults: unknown[] } };
  expect_eq(cleaned.validation.qualityGateResults.length, 1);
});

test("normalizeCriticEcho leaves non-object input untouched", () => {
  expect_eq(normalizeCriticEcho(null), null);
  expect_eq(normalizeCriticEcho("nope"), "nope");
  expect_eq(normalizeCriticEcho(42), 42);
});

test("normalizeCriticEcho leaves payloads without validation untouched", () => {
  const raw = { criticId: "x", findings: [] };
  expect_deep(normalizeCriticEcho(raw), raw);
});

test("strict parseCriticResult still rejects raw malformed echo (proves boundary stayed strict)", () => {
  const raw = {
    criticId: "x",
    status: "complete",
    verdict: "APPROVED",
    requiresHumanJudgment: false,
    summary: "ok",
    findings: [],
    validation: {
      qualityGateResults: [{ command: "make test-lint", passed: true }],
      qualityGatesMissing: [],
    },
    confidence: "high",
    reviewer: REVIEWER_OK,
  };
  expect_throws(() => parseCriticResult(raw, ["blocker", "high"]), SchemaError);
});

// extractRuntimeModel reads the SDK-resolved model selection off the agent.
// SDK type definition (`SDKAgent.model: ModelSelection | undefined`) says
// this is "updated after each successful send({ model })", so it reflects
// what the SDK actually accepted — not what we tried to send. This is the
// proof signal for "the configured tier actually engaged".

test("extractRuntimeModel reads agent.model with id and params", () => {
  const agent = {
    id: "agent-123",
    model: {
      id: "gpt-5.5",
      params: [
        { id: "reasoning", value: "extra-high" },
        { id: "context", value: "1m" },
      ],
    },
  };
  const result = extractRuntimeModel(agent);
  expect_deep(result, {
    id: "gpt-5.5",
    params: [
      { id: "reasoning", value: "extra-high" },
      { id: "context", value: "1m" },
    ],
  });
});

test("extractRuntimeModel returns id-only when params absent", () => {
  const agent = { model: { id: "gpt-5.5" } };
  expect_deep(extractRuntimeModel(agent), { id: "gpt-5.5" });
});

test("extractRuntimeModel returns undefined when agent has no model field (defensive)", () => {
  // Older SDK shapes may not expose .model; fallback to config in adapter.
  expect_eq(extractRuntimeModel({ id: "agent-x" }), undefined);
  expect_eq(extractRuntimeModel(null), undefined);
  expect_eq(extractRuntimeModel("not-an-object"), undefined);
});

// checkRunFinished is the policy gate: anything other than "finished" must
// produce an error string (which the adapter then throws). Without this gate,
// a cancelled/failed SDK run with partial streamed text that happens to form
// valid JSON could become an APPROVED artifact.

test("checkRunFinished returns null when status is finished (healthy path)", () => {
  expect_eq(checkRunFinished("finished"), null);
});

test("checkRunFinished returns error string for status=error (failed run)", () => {
  const msg = checkRunFinished("error");
  expect_match(msg ?? "", /status=error/);
  expect_match(msg ?? "", /expected "finished"/);
});

test("checkRunFinished returns error string for status=running (incomplete run)", () => {
  const msg = checkRunFinished("running");
  expect_match(msg ?? "", /status=running/);
});

test("checkRunFinished returns error string for unknown SDK status (defensive)", () => {
  const msg = checkRunFinished("cancelled");
  expect_match(msg ?? "", /status=cancelled/);
});

test("checkRunFinished returns error string for missing status (regression: undefined → unknown)", () => {
  // SDK shape change could remove `status` from run.wait result. Fail
  // closed rather than treating "missing field" as approval.
  const msg = checkRunFinished(undefined);
  expect_match(msg ?? "", /status=unknown/);
});

test("extractRuntimeModel skips malformed param entries (defensive)", () => {
  const agent = {
    model: {
      id: "gpt-5.5",
      params: [
        { id: "reasoning", value: "extra-high" },
        { id: "missing-value" }, // dropped
        { value: "no-id" }, // dropped
        "not-an-object", // dropped
        { id: "context", value: "1m" },
      ],
    },
  };
  expect_deep(extractRuntimeModel(agent), {
    id: "gpt-5.5",
    params: [
      { id: "reasoning", value: "extra-high" },
      { id: "context", value: "1m" },
    ],
  });
});
