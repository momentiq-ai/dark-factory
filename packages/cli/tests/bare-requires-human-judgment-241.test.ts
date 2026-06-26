// Issue #241 — a BARE result-level `requiresHumanJudgment` (rHJ set on a
// CriticResult that returned APPROVED with no blocking-severity finding)
// must NOT unconditionally veto the gate. A clean APPROVED critic that
// stochastically self-flags rHJ otherwise deadlocks the gate, and on the
// canonical strict ruleset (empty `bypass_actors`) there is no escape.
// See momentiq-ai/cerebe-platform#337 (triggering) / #340 (RCA).
//
// This suite is the focused regression guard for the #241 fix. It covers:
//   1. `isBareRequiresHumanJudgment` — the single source-of-truth
//      predicate every veto/block site keys on.
//   2. `clearBareRequiresHumanJudgment` — the adapter-boundary guard
//      that mirrors the codex-sdk clearing logic.
//   3. The two adapter guards end-to-end (cursor-sdk via the parser
//      boundary it routes through; minimax-direct-sdk via its SDK mock).
//
// The report-level demotion (`criticVetoesGate`, `quorumAggregateVerdict`)
// and the gate-block enforcement (`evaluateCriticResults`,
// `evaluateQuorumCriticResults`) are covered in `quorum-policy.test.ts`
// (the existing matrix, updated for #241).

import { test } from "vitest";
import { expect_eq, expect_truthy } from "./_assert-shim.js";
import { parseCriticResult } from "@momentiq/dark-factory-schemas";
import type {
  CriticConfig,
  CriticResult,
  ReviewPacket,
  ReviewSeverity,
} from "@momentiq/dark-factory-schemas";

import { isBareRequiresHumanJudgment } from "../src/report.js";
import { clearBareRequiresHumanJudgment } from "../src/adapters/_shared.js";
import {
  MinimaxDirectSdkAdapter,
  type MinimaxClient,
  type MinimaxStreamChunk,
} from "../src/adapters/minimax-direct-sdk.js";

const BLOCKING: ReviewSeverity[] = ["blocker", "high"];

// A note-severity finding (NON-blocking) — the schema does not require a
// `file` on note severity, so this is the minimal non-blocking finding.
const NOTE_FINDING = {
  severity: "note" as const,
  category: "style",
  evidence: "subjective naming nit",
  impact: "minor",
  requiredFix: "consider renaming",
};

// A blocker-severity finding (BLOCKING) — schema requires `file`.
const BLOCKER_FINDING = {
  severity: "blocker" as const,
  category: "design",
  file: "src/api.ts",
  line: 42,
  evidence: "method signature ambiguous",
  impact: "consumers may pass wrong arg",
  requiredFix: "rename parameter",
};

function resultShape(opts: {
  verdict: "APPROVED" | "CHANGES_REQUESTED";
  requiresHumanJudgment: boolean;
  findings?: Array<Record<string, unknown>>;
}): CriticResult {
  return {
    criticId: "c1",
    status: "complete",
    verdict: opts.verdict,
    requiresHumanJudgment: opts.requiresHumanJudgment,
    reviewer: {
      name: "c1",
      adapter: "test-adapter",
      model: { id: "test-model", params: [] },
      runtime: "local",
    },
    summary: "test",
    findings: (opts.findings ?? []) as CriticResult["findings"],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
  };
}

// ---------------------------------------------------------------------------
// isBareRequiresHumanJudgment — the shared predicate

test("isBareRequiresHumanJudgment: APPROVED + rHJ + 0 findings → bare", () => {
  const r = resultShape({ verdict: "APPROVED", requiresHumanJudgment: true });
  expect_eq(isBareRequiresHumanJudgment(r, BLOCKING), true);
});

test("isBareRequiresHumanJudgment: APPROVED + rHJ + NON-blocking findings → bare (not literal-zero)", () => {
  // "Bare" means "no blocking finding + non-CR verdict", NOT literally
  // zero findings. This is the minimax triggering shape.
  const r = resultShape({
    verdict: "APPROVED",
    requiresHumanJudgment: true,
    findings: [NOTE_FINDING, NOTE_FINDING],
  });
  expect_eq(isBareRequiresHumanJudgment(r, BLOCKING), true);
});

test("isBareRequiresHumanJudgment: rHJ + a blocking finding → NOT bare", () => {
  const r = resultShape({
    verdict: "APPROVED",
    requiresHumanJudgment: true,
    findings: [BLOCKER_FINDING],
  });
  expect_eq(isBareRequiresHumanJudgment(r, BLOCKING), false);
});

test("isBareRequiresHumanJudgment: rHJ + CHANGES_REQUESTED verdict → NOT bare", () => {
  const r = resultShape({
    verdict: "CHANGES_REQUESTED",
    requiresHumanJudgment: true,
    findings: [NOTE_FINDING],
  });
  expect_eq(isBareRequiresHumanJudgment(r, BLOCKING), false);
});

test("isBareRequiresHumanJudgment: rHJ false → never bare", () => {
  const r = resultShape({ verdict: "APPROVED", requiresHumanJudgment: false });
  expect_eq(isBareRequiresHumanJudgment(r, BLOCKING), false);
});

// ---------------------------------------------------------------------------
// clearBareRequiresHumanJudgment — the adapter-boundary guard

test("clearBareRequiresHumanJudgment: APPROVED + rHJ + 0 findings → cleared to false", () => {
  const r = resultShape({ verdict: "APPROVED", requiresHumanJudgment: true });
  const out = clearBareRequiresHumanJudgment(r);
  expect_eq(out.requiresHumanJudgment, false);
});

test("clearBareRequiresHumanJudgment: rHJ riding a blocking finding → left untouched", () => {
  // The adapter guard is the narrow belt-and-suspenders (literal 0
  // findings only); the report-side demotion handles the broader bare
  // case. A finding present means the adapter must NOT clear.
  const r = resultShape({
    verdict: "APPROVED",
    requiresHumanJudgment: true,
    findings: [BLOCKER_FINDING],
  });
  const out = clearBareRequiresHumanJudgment(r);
  expect_eq(out.requiresHumanJudgment, true);
});

test("clearBareRequiresHumanJudgment: CHANGES_REQUESTED + rHJ → left untouched", () => {
  const r = resultShape({
    verdict: "CHANGES_REQUESTED",
    requiresHumanJudgment: true,
    findings: [NOTE_FINDING],
  });
  const out = clearBareRequiresHumanJudgment(r);
  expect_eq(out.requiresHumanJudgment, true);
});

test("clearBareRequiresHumanJudgment: rHJ already false → returns same result reference", () => {
  const r = resultShape({ verdict: "APPROVED", requiresHumanJudgment: false });
  const out = clearBareRequiresHumanJudgment(r);
  expect_eq(out, r);
});

// ---------------------------------------------------------------------------
// cursor-sdk — the adapter routes findings through `parseCriticResult`
// then `clearBareRequiresHumanJudgment`. Exercise that exact composition
// (the CursorSdkAdapter has no DI seam for the @cursor/sdk Agent class,
// matching the posture in adapter-requires-human-judgment.test.ts).

test("cursor-sdk (parser + clear boundary): bare result-level rHJ is cleared", () => {
  const raw = {
    criticId: "cursor-sdk-chief",
    status: "complete",
    verdict: "APPROVED",
    requiresHumanJudgment: true,
    summary: "clean pass but self-flagged",
    findings: [],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
    reviewer: {
      name: "Cursor Local Critic",
      adapter: "cursor-sdk",
      runtime: "local",
      model: { id: "gpt-5.5", params: [] },
    },
  };
  const parsed = parseCriticResult(raw, BLOCKING as Parameters<typeof parseCriticResult>[1]);
  // Sanity: the schema permits APPROVED + rHJ:true + 0 findings.
  expect_eq(parsed.requiresHumanJudgment, true);
  const cleared = clearBareRequiresHumanJudgment(parsed);
  expect_eq(cleared.requiresHumanJudgment, false);
});

// ---------------------------------------------------------------------------
// minimax-direct-sdk — end-to-end through the SDK mock.

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

function minimaxAdapterFor(responseText: string): MinimaxDirectSdkAdapter {
  const mockClient: MinimaxClient = {
    chat: { completions: { create: async () => makeMinimaxStream(responseText) } },
    models: {
      list: async () => ({
        async *[Symbol.asyncIterator]() {
          // empty list
        },
      }),
    },
  };
  return new MinimaxDirectSdkAdapter({ apiKey: "k", createClient: () => mockClient });
}

test("minimax-direct-sdk: bare result-level rHJ on APPROVED+0-findings is cleared at the adapter", async () => {
  const text = JSON.stringify({
    status: "complete",
    verdict: "APPROVED",
    requiresHumanJudgment: true,
    summary: "clean pass but self-flagged",
    findings: [],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
  });
  const result = await minimaxAdapterFor(text).review(PACKET, MINIMAX_CRITIC, {
    blockingSeverities: BLOCKING,
  });
  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "APPROVED");
  // #241 — adapter clears the bare result-level rHJ so it never reaches
  // the artifact / gate.
  expect_eq(result.requiresHumanJudgment, false);
});

test("minimax-direct-sdk: rHJ riding a CHANGES_REQUESTED verdict is NOT cleared (§11)", async () => {
  const text = JSON.stringify({
    status: "complete",
    verdict: "CHANGES_REQUESTED",
    requiresHumanJudgment: true,
    summary: "needs a human eye",
    findings: [
      {
        severity: "blocker",
        category: "design",
        file: "src/api.ts",
        line: 7,
        evidence: "ambiguous contract",
        impact: "callers may misuse",
        requiredFix: "clarify the contract",
      },
    ],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
  });
  const result = await minimaxAdapterFor(text).review(PACKET, MINIMAX_CRITIC, {
    blockingSeverities: BLOCKING,
  });
  expect_eq(result.status, "complete");
  // Non-bare (CR verdict + blocking finding) → rHJ preserved → still vetoes.
  expect_truthy(result.requiresHumanJudgment);
});
