// Issue #106 — aggregator regression test.
//
// The new per-finding `requiresHumanJudgment?: boolean` field is
// presentation-only at the CLI layer. Quorum/verdict math must be
// byte-identical regardless of whether findings carry the flag.
//
// This test pins that invariant: build a mixed fixture set, compute the
// aggregate verdict with NO findings carrying the flag, then attach the
// flag (in both `true` and `false` shapes) to every finding and recompute
// — the resulting verdict, vetoers, completed-critics, and aggregate
// reason must all be identical.

import { test } from "vitest";
import { expect_deep, expect_eq } from "./_assert-shim.js";
import {
  criticVetoesGate,
  quorumAggregateVerdict,
} from "../src/report.js";
import type {
  CriticResult,
  ReviewFinding,
  ReviewSeverity,
} from "@momentiq/dark-factory-schemas";

const BLOCKING: ReviewSeverity[] = ["blocker", "high"];

function makeFinding(severity: ReviewSeverity, flag?: boolean): ReviewFinding {
  const base: ReviewFinding = {
    severity,
    category: "test",
    file: "a.ts",
    line: 1,
    evidence: "test evidence",
    impact: "test impact",
    requiredFix: "test fix",
  };
  if (flag !== undefined) base.requiresHumanJudgment = flag;
  return base;
}

function critic(
  id: string,
  verdict: "APPROVED" | "CHANGES_REQUESTED",
  findingFlags: Array<boolean | undefined>,
  blockerSeverityIdx: Set<number> = new Set(),
): CriticResult {
  const findings = findingFlags.map((flag, i) =>
    makeFinding(blockerSeverityIdx.has(i) ? "blocker" : "note", flag),
  );
  return {
    criticId: id,
    status: "complete",
    verdict,
    requiresHumanJudgment: false,
    reviewer: {
      name: id,
      adapter: "test-adapter",
      model: { id: "test-model", params: [] },
      runtime: "local",
    },
    summary: "test summary",
    findings,
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
  };
}

// Build the SAME fixture set with three different per-finding-flag
// configurations:
//   "none"  — every finding omits requiresHumanJudgment
//   "false" — every finding carries requiresHumanJudgment=false
//   "true"  — every finding carries requiresHumanJudgment=true
//
// Then assert quorum math is byte-identical across all three.

function buildFixture(flag: undefined | boolean): CriticResult[] {
  // Mix: one APPROVED (no findings), one CHANGES_REQUESTED with a blocker
  // finding, one CHANGES_REQUESTED with only note findings, plus the
  // result-level requiresHumanJudgment unchanged at false on all critics.
  return [
    critic("c1", "APPROVED", []),
    critic("c2", "CHANGES_REQUESTED", [flag], new Set([0])), // blocker → vetos
    critic("c3", "CHANGES_REQUESTED", [flag, flag]),         // note + note → no veto
  ];
}

test("aggregator: per-finding requiresHumanJudgment does NOT affect quorum verdict", () => {
  const verdictWith = (flag: undefined | boolean) =>
    quorumAggregateVerdict(buildFixture(flag), BLOCKING, 2);

  const none = verdictWith(undefined);
  const falsey = verdictWith(false);
  const truthy = verdictWith(true);

  // Every field of the aggregate must be deeply equal across the three
  // shapes — verdict, reason, completion states, per-critic verdicts.
  expect_deep(falsey, none);
  expect_deep(truthy, none);

  // Sanity check the actual values are what we expect — a blocker
  // finding from c2 vetoes, so verdict is CHANGES_REQUESTED with
  // reason="veto" (NOT majority and NOT quorum_unmet).
  expect_eq(none.verdict, "CHANGES_REQUESTED");
  expect_eq(none.reason, "veto");
});

test("aggregator: per-finding requiresHumanJudgment does NOT affect criticVetoesGate", () => {
  // criticVetoesGate examines the result-level `requiresHumanJudgment`
  // and the presence of blocking-severity findings — NEVER the
  // per-finding flag. Pin that by toggling the per-finding flag and
  // confirming the boolean output is unchanged.
  const blockerCritic = (flag: undefined | boolean) =>
    critic("v", "CHANGES_REQUESTED", [flag], new Set([0]));
  expect_eq(criticVetoesGate(blockerCritic(undefined), BLOCKING), true);
  expect_eq(criticVetoesGate(blockerCritic(false), BLOCKING), true);
  expect_eq(criticVetoesGate(blockerCritic(true), BLOCKING), true);

  const cleanCritic = (flag: undefined | boolean) =>
    critic("c", "APPROVED", [flag]); // note-severity only
  expect_eq(criticVetoesGate(cleanCritic(undefined), BLOCKING), false);
  expect_eq(criticVetoesGate(cleanCritic(false), BLOCKING), false);
  expect_eq(criticVetoesGate(cleanCritic(true), BLOCKING), false);
});

test("aggregator: APPROVED critic with finding.requiresHumanJudgment=true does NOT auto-veto", () => {
  // The whole point of moving requiresHumanJudgment to a per-finding
  // flag (vs only the result-level flag) is that consumers can render
  // flagged findings differently WITHOUT the gate auto-blocking. An
  // APPROVED verdict with note-severity finding flagged true must stay
  // APPROVED at the gate layer; downstream consumers may surface
  // differently but the CLI's verdict math is unchanged.
  const c = critic("approved-with-flagged-note", "APPROVED", [true]);
  expect_eq(criticVetoesGate(c, BLOCKING), false);
  expect_eq(c.verdict, "APPROVED");
});
