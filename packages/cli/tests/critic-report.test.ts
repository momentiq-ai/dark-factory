// sage3c#2213 — unit tests for `buildCriticReport` (report.ts).
//
// `buildCriticReport` is the pure helper behind the `df critic`
// observability fix: it turns an artifact's `criticResults[]` into the
// stdout block + the $GITHUB_STEP_SUMMARY markdown block. The two
// behaviors under test are exactly the evidence-loss-hole closers:
//
//   1. Per-critic `error.message` + `error.code` appear in the output
//      (previously they lived ONLY in the per-SHA artifact JSON, which
//      CI-runner teardown destroyed — the log showed only
//      `<id>: error — findings=0`).
//   2. A loud degradation warning fires when `completedCount < totalCount`
//      (the sage3c#2213 shape: 3 of 4 critics errored, verdict from 1),
//      and its X/Y math + singular/plural grammar are correct.
//
// Fixtures mirror the hand-constructed `CriticResult` shapes in
// quorum-policy.test.ts so `completedCount`/`totalCount` agree with the
// quorum aggregator's view of "completed" (`status === "complete"`).

import { describe, it, test } from "vitest";
import {
  expect_eq,
  expect_match,
  expect_no_match,
  expect_truthy,
} from "./_assert-shim.js";
import { buildCriticReport, quorumAggregateVerdict } from "../src/report.js";
import type {
  CriticResult,
  ReviewArtifact,
  ReviewSeverity,
} from "@momentiq/dark-factory-schemas";

const BLOCKING: ReviewSeverity[] = ["blocker", "high"];
const JSON_PATH = "/repo/.git/agent-reviews/abc123.json";

function completed(
  criticId: string,
  verdict: "APPROVED" | "CHANGES_REQUESTED",
  options: { blockerFinding?: boolean } = {},
): CriticResult {
  const findings = [];
  if (options.blockerFinding) {
    findings.push({
      severity: "blocker" as const,
      category: "test",
      file: "a.ts",
      line: 1,
      evidence: "test evidence",
      impact: "test impact",
      requiredFix: "test fix",
    });
  }
  return {
    criticId,
    status: "complete",
    verdict,
    requiresHumanJudgment: false,
    reviewer: {
      name: criticId,
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

function errored(
  criticId: string,
  message: string,
  code?: string,
): CriticResult {
  return {
    criticId,
    status: "error",
    requiresHumanJudgment: false,
    reviewer: {
      name: criticId,
      adapter: "test-adapter",
      model: { id: "test-model", params: [] },
      runtime: "local",
    },
    summary: "errored",
    findings: [],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "unknown",
    error: {
      message,
      retryable: true,
      ...(code !== undefined ? { code } : {}),
      retryCount: 2,
    },
  };
}

function artifact(
  results: CriticResult[],
  gateVerdict?: "APPROVED" | "CHANGES_REQUESTED",
): ReviewArtifact {
  return {
    version: 2,
    status: "complete",
    repo: "test",
    commit: "abc123" + "0".repeat(34),
    parent: "y".repeat(40),
    range: "y..x",
    diffHash: "deadbeef",
    artifactScope: "git-common-dir",
    aggregationPolicy: "min-complete-quorum",
    criticResults: results,
    createdAt: "2026-05-25T00:00:00.000Z",
    ...(gateVerdict !== undefined ? { gateVerdict } : {}),
  };
}

describe("buildCriticReport — per-critic error surfacing (sage3c#2213)", () => {
  test("errored critic's message + code appear in stdout", () => {
    const report = buildCriticReport(
      artifact([
        completed("cursor-local", "APPROVED"),
        errored("codex-local", "capacity_exceeded after retry", "rate_limited"),
      ]),
      JSON_PATH,
    );
    // The pre-fix one-liner is still present...
    expect_match(report.stdout, /codex-local: error/);
    // ...AND the message + code now surface (previously artifact-only).
    expect_match(report.stdout, /\[critic-error\] codex-local: capacity_exceeded after retry/);
    expect_match(report.stdout, /\[code=rate_limited\]/);
  });

  test("errored critic's message + code appear in $GITHUB_STEP_SUMMARY", () => {
    const report = buildCriticReport(
      artifact([
        completed("cursor-local", "APPROVED"),
        errored("codex-local", "capacity_exceeded after retry", "rate_limited"),
      ]),
      JSON_PATH,
    );
    expect_match(report.stepSummary, /Per-critic errors:/);
    expect_match(report.stepSummary, /codex-local.*capacity_exceeded after retry/);
    expect_match(report.stepSummary, /code=rate_limited/);
  });

  test("missing error.code omits the code suffix but still prints the message", () => {
    const report = buildCriticReport(
      artifact([errored("grok-local", "socket hang up")]),
      JSON_PATH,
    );
    expect_match(report.stdout, /\[critic-error\] grok-local: socket hang up/);
    expect_no_match(report.stdout, /\[code=/);
  });

  test("a missing error object falls back to a placeholder, never undefined", () => {
    // Defensive: an error-status result with no `error` field (schema-
    // legal absence) must still print a human string, not `undefined`.
    const noErrorObj: CriticResult = {
      ...errored("gemini-local", "x"),
    };
    delete (noErrorObj as { error?: unknown }).error;
    const report = buildCriticReport(artifact([noErrorObj]), JSON_PATH);
    expect_match(report.stdout, /\[critic-error\] gemini-local: \(no error message captured\)/);
    expect_no_match(report.stdout, /undefined/);
  });

  test("no [critic-error] lines when every critic completed", () => {
    const report = buildCriticReport(
      artifact(
        [completed("c1", "APPROVED"), completed("c2", "APPROVED")],
        "APPROVED",
      ),
      JSON_PATH,
    );
    expect_no_match(report.stdout, /\[critic-error\]/);
    expect_no_match(report.stepSummary, /Per-critic errors:/);
  });
});

describe("buildCriticReport — loud degradation warning (sage3c#2213)", () => {
  test("fires the ⚠ banner when completedCount < totalCount (the #2213 shape)", () => {
    // 3 of 4 errored — verdict computed from 1 critic.
    const report = buildCriticReport(
      artifact(
        [
          completed("c1", "APPROVED"),
          errored("c2", "boom"),
          errored("c3", "boom"),
          errored("c4", "boom"),
        ],
        "CHANGES_REQUESTED",
      ),
      JSON_PATH,
    );
    expect_eq(report.degraded, true);
    expect_eq(report.completedCount, 1);
    expect_eq(report.totalCount, 4);
    // exact wording the brief specifies, singular "critic" for count==1
    expect_match(report.stdout, /⚠ 3\/4 critics errored — verdict computed from 1 critic\b/);
    expect_match(report.stepSummary, /⚠ 3\/4 critics errored — verdict computed from 1 critic\b/);
    // rendered as a blockquote in the step summary so GitHub surfaces it
    expect_match(report.stepSummary, /^> ⚠ 3\/4 critics errored/m);
  });

  test("pluralizes 'critics' when more than one completed", () => {
    const report = buildCriticReport(
      artifact(
        [
          completed("c1", "APPROVED"),
          completed("c2", "APPROVED"),
          errored("c3", "boom"),
        ],
        "APPROVED",
      ),
      JSON_PATH,
    );
    expect_eq(report.completedCount, 2);
    expect_eq(report.totalCount, 3);
    expect_match(report.stdout, /⚠ 1\/3 critics errored — verdict computed from 2 critics\b/);
  });

  test("no banner when all critics complete (non-degraded)", () => {
    const report = buildCriticReport(
      artifact(
        [completed("c1", "APPROVED"), completed("c2", "APPROVED")],
        "APPROVED",
      ),
      JSON_PATH,
    );
    expect_eq(report.degraded, false);
    expect_eq(report.completedCount, 2);
    expect_eq(report.totalCount, 2);
    expect_no_match(report.stdout, /⚠/);
    expect_no_match(report.stepSummary, /⚠/);
  });

  test("completedCount/totalCount agree with quorumAggregateVerdict", () => {
    // The degradation math must mirror the quorum aggregator's
    // definition of "completed" so the two never disagree on the same
    // artifact. Use a mixed set and cross-check.
    const results = [
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      errored("c3", "boom"),
      errored("c4", "boom"),
    ];
    const report = buildCriticReport(artifact(results, "APPROVED"), JSON_PATH);
    const quorum = quorumAggregateVerdict(results, BLOCKING, 2);
    expect_eq(report.completedCount, quorum.completedCount);
    expect_eq(report.totalCount, quorum.totalCount);
  });
});

describe("buildCriticReport — structural invariants", () => {
  it("always includes the verdict, artifact path, and per-critic block", () => {
    const report = buildCriticReport(
      artifact([completed("c1", "APPROVED")], "APPROVED"),
      JSON_PATH,
    );
    expect_match(report.stdout, /df critic: review complete for abc123/);
    expect_match(report.stdout, /verdict: APPROVED/);
    expect_match(report.stdout, new RegExp(`artifact: ${JSON_PATH.replace(/[/.]/g, "\\$&")}`));
    expect_match(report.stdout, /c1: complete \(APPROVED\) — findings=0/);
    // step summary always carries the completed/total line
    expect_match(report.stepSummary, /Critics completed:\*\* 1\/1/);
  });

  it("renders '(no verdict)' when gateVerdict is absent", () => {
    const report = buildCriticReport(artifact([errored("c1", "boom")]), JSON_PATH);
    expect_match(report.stdout, /verdict: \(no verdict\)/);
    expect_truthy(report.stdout.endsWith("\n"));
  });
});
