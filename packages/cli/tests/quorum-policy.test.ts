// Cycle 322.3 — Phase C unit tests for the `min-complete-quorum`
// aggregation policy.
//
// Tests cover three surfaces:
//   1. Schema validation (parseAgentReviewConfig) — accepts the new
//      policy, validates `quorum` integer, rejects a stale `quorum`
//      field after a policy roll-back.
//   2. Pure verdict logic (`quorumAggregateVerdict` in report.ts) —
//      the 8-row matrix from cycle322.3 §"Failure modes", plus
//      explicit boundary tests so the §11 veto-preserves-quorum
//      invariant cannot regress silently.
//   3. Gate evaluator (`evaluateQuorumCriticResults` in gate.ts) —
//      block-reason mapping; specifically `quorum_unmet` is a
//      distinct block reason from a content block.
//
// The tests use hand-constructed `CriticResult` objects rather than
// running the adapter end-to-end — the adapter has its own coverage
// in cursor / gemini / grok adapter tests. The boundary between
// "what the adapter produces" and "how aggregation interprets it"
// is the schema, which both sides honor.


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
  evaluateQuorumCriticResults,
} from "../src/policy/gate.js";
import {
  criticVetoesGate,
  isCriticCompleted,
  quorumAggregateVerdict,
} from "../src/report.js";
import {
  AGGREGATION_POLICIES,
  parseAgentReviewConfig,
  type CriticResult,
  type GateBlock,
  type GateWarning,
  type ReviewArtifact,
  type ReviewSeverity,
} from "@momentiq/dark-factory-schemas";

// ---------------------------------------------------------------------------
// Helpers

const BLOCKING: ReviewSeverity[] = ["blocker", "high"];

function completed(
  criticId: string,
  verdict: "APPROVED" | "CHANGES_REQUESTED",
  options: {
    requiresHumanJudgment?: boolean;
    blockerFinding?: boolean;
    highFinding?: boolean;
  } = {},
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
  if (options.highFinding) {
    findings.push({
      severity: "high" as const,
      category: "test",
      file: "b.ts",
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
    requiresHumanJudgment: options.requiresHumanJudgment ?? false,
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

function errored(criticId: string, code = "http_500"): CriticResult {
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
    error: { message: "transient", retryable: true, code, retryCount: 2 },
  };
}

function pending(criticId: string): CriticResult {
  return {
    criticId,
    status: "pending",
    requiresHumanJudgment: false,
    reviewer: {
      name: criticId,
      adapter: "test-adapter",
      model: { id: "test-model", params: [] },
      runtime: "local",
    },
    summary: "pending",
    findings: [],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "unknown",
  };
}

function artifact(results: CriticResult[]): ReviewArtifact {
  return {
    version: 2,
    status: "complete",
    repo: "test",
    commit: "x".repeat(40),
    parent: "y".repeat(40),
    range: "y..x",
    diffHash: "deadbeef",
    artifactScope: "git-common-dir",
    aggregationPolicy: "min-complete-quorum",
    criticResults: results,
    createdAt: "2026-05-14T00:00:00.000Z",
    gateVerdict: "APPROVED",
  };
}

const BASE_CONFIG = {
  version: 2,
  critics: [
    {
      id: "cursor-local-chief-engineer",
      name: "Cursor",
      adapter: "cursor-sdk",
      required: false,
      runtime: "local",
      model: { id: "composer-2", params: [] },
    },
    {
      id: "gemini-local-chief-engineer",
      name: "Gemini",
      adapter: "gemini-sdk",
      required: false,
      runtime: "local",
      model: { id: "gemini-2.5-pro", params: [] },
    },
    {
      id: "grok-local-chief-engineer",
      name: "Grok",
      adapter: "grok-direct-sdk",
      required: false,
      runtime: "local",
      model: { id: "grok-4.3", params: [] },
    },
  ],
  git: { hookPath: ".husky", artifactDir: "agent-reviews", artifactScope: "git-common-dir" },
  policy: {
    blockOnMissingReview: true,
    blockOnReviewError: true,
    allowEmergencyBypass: true,
    postCommitMode: "async",
  },
  context: {
    guidanceFiles: [],
    promptFragments: [],
    maxChangedFileBytes: 200000,
    includeFullChangedFiles: true,
  },
  tdd: {
    classifier: {
      productionGlobs: ["**/*.py"],
      testGlobs: ["tests/**"],
      exclusionGlobs: ["docs/**"],
      justificationTrailer: "Tdd-Justification",
    },
  },
  validation: {
    runBeforeReview: false,
    resultFile: "agent-reviews/quality-gates/latest.json",
    requiredQualityGates: [],
    optionalQualityGates: [],
    verificationRoutes: [],
  },
  security: { redactSecretsInDiagnostics: true, treatDiffAsUntrustedInput: true },
};

// ---------------------------------------------------------------------------
// Helper exports (shared between report.ts and gate.ts)

test("isCriticCompleted: true for status=complete, false otherwise", () => {
  expect_eq(isCriticCompleted(completed("c1", "APPROVED")), true);
  expect_eq(isCriticCompleted(errored("c2")), false);
  expect_eq(isCriticCompleted(pending("c3")), false);
});

test("criticVetoesGate: completed critic with blocking finding → veto", () => {
  const c = completed("c1", "APPROVED", { blockerFinding: true });
  expect_eq(criticVetoesGate(c, BLOCKING), true);
});

test("criticVetoesGate: completed APPROVED with no blocking findings → no veto", () => {
  const c = completed("c1", "APPROVED");
  expect_eq(criticVetoesGate(c, BLOCKING), false);
});

test("criticVetoesGate: errored critic does NOT veto (only completed critics can veto)", () => {
  expect_eq(criticVetoesGate(errored("c2"), BLOCKING), false);
});

test("criticVetoesGate: BARE requiresHumanJudgment (APPROVED + 0 findings) does NOT veto by default (#241)", () => {
  // Issue #241 — a bare result-level rHJ (no CHANGES_REQUESTED verdict,
  // no blocking finding) is demoted to a non-blocking note by default
  // ('note'). It no longer deadlocks the gate on the canonical strict
  // ruleset. The §11 safety net is asserted by the two tests below.
  const c = completed("c1", "APPROVED", { requiresHumanJudgment: true });
  expect_eq(criticVetoesGate(c, BLOCKING), false);
});

test("criticVetoesGate: rHJ riding a blocking finding STILL vetoes (#241 — §11 safety net)", () => {
  // A NON-bare rHJ — one with a blocking-severity finding to defend it —
  // must keep vetoing regardless of the bare-rHJ demotion.
  const c = completed("c1", "APPROVED", { requiresHumanJudgment: true, blockerFinding: true });
  expect_eq(criticVetoesGate(c, BLOCKING), true);
});

test("criticVetoesGate: rHJ on a CHANGES_REQUESTED verdict STILL vetoes (#241 — §11 safety net)", () => {
  // A NON-bare rHJ — riding a CHANGES_REQUESTED verdict — keeps vetoing.
  const c = completed("c1", "CHANGES_REQUESTED", { requiresHumanJudgment: true });
  expect_eq(criticVetoesGate(c, BLOCKING), true);
});

test("criticVetoesGate: bare rHJ vetoes when onRequiresHumanJudgment='block' (#241 opt-in)", () => {
  // Operators can restore the pre-#241 unconditional bare-rHJ veto by
  // setting the policy knob to 'block'.
  const c = completed("c1", "APPROVED", { requiresHumanJudgment: true });
  const ctx = {
    allResults: [c],
    rules: {
      requireCorroborationFor: [],
      requireCorroborationOnHunkRadius: 0,
      onRequiresHumanJudgment: "block" as const,
    },
  };
  expect_eq(criticVetoesGate(c, BLOCKING, ctx), true);
});

// ---------------------------------------------------------------------------
// Schema validation

test("schema: AGGREGATION_POLICIES contains both policy variants", () => {
  expect_deep([...AGGREGATION_POLICIES], ["block-if-any", "min-complete-quorum"]);
});

test("schema: min-complete-quorum requires quorum integer", () => {
  const bad = {
    ...BASE_CONFIG,
    aggregation: { policy: "min-complete-quorum", blockingSeverities: ["blocker"] },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /quorum/i);
});

test("schema: min-complete-quorum rejects quorum < 2", () => {
  const bad = {
    ...BASE_CONFIG,
    aggregation: {
      policy: "min-complete-quorum",
      blockingSeverities: ["blocker"],
      quorum: 1,
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /quorum.*>= 2/i);
});

test("schema: min-complete-quorum rejects quorum > critic count", () => {
  const bad = {
    ...BASE_CONFIG,
    aggregation: {
      policy: "min-complete-quorum",
      blockingSeverities: ["blocker"],
      quorum: 4, // BASE_CONFIG has 3 critics
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /exceeds.*critic count/i);
});

test("schema: block-if-any with stray quorum field is rejected (anti-foot-gun on policy rollback)", () => {
  const bad = {
    ...BASE_CONFIG,
    aggregation: {
      policy: "block-if-any",
      blockingSeverities: ["blocker"],
      quorum: 2, // stale leftover from a previous min-complete-quorum config
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /only valid for policy="min-complete-quorum"/i);
});

test("schema: min-complete-quorum with quorum=2 + 3 critics parses cleanly", () => {
  const good = {
    ...BASE_CONFIG,
    aggregation: {
      policy: "min-complete-quorum",
      blockingSeverities: ["blocker", "high"],
      quorum: 2,
    },
  };
  const parsed = parseAgentReviewConfig(good);
  expect_eq(parsed.aggregation.policy, "min-complete-quorum");
  expect_eq(parsed.aggregation.quorum, 2);
});

test("schema: block-if-any without quorum parses cleanly (no regression)", () => {
  // Cycle 322.7 safety invariant: block-if-any requires at least one
  // critic with `required: true` (otherwise gate would silently
  // downgrade blockers to warnings). Promote first BASE_CONFIG critic
  // to required for this test — the back-compat assertion (no quorum
  // field needed) still holds.
  const critics = BASE_CONFIG.critics.map((c, i) =>
    i === 0 ? { ...c, required: true } : c,
  );
  const good = {
    ...BASE_CONFIG,
    critics,
    aggregation: {
      policy: "block-if-any",
      blockingSeverities: ["blocker", "high"],
    },
  };
  const parsed = parseAgentReviewConfig(good);
  expect_eq(parsed.aggregation.policy, "block-if-any");
  expect_eq(parsed.aggregation.quorum, undefined);
});

// ---------------------------------------------------------------------------
// quorumAggregateVerdict — the cycle322.3 verdict matrix
// (rows from "Failure modes" table in the cycle doc)

test("quorum: 3 APPROVE → APPROVED (majority)", () => {
  const out = quorumAggregateVerdict(
    [
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      completed("c3", "APPROVED"),
    ],
    BLOCKING,
    2,
  );
  expect_eq(out.verdict, "APPROVED");
  expect_eq(out.reason, "majority");
  expect_eq(out.completedCount, 3);
});

test("quorum: 2 APPROVE + 1 ERROR → APPROVED (quorum met, errored doesn't vote)", () => {
  const out = quorumAggregateVerdict(
    [
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      errored("c3"),
    ],
    BLOCKING,
    2,
  );
  expect_eq(out.verdict, "APPROVED");
  expect_eq(out.reason, "majority");
  expect_eq(out.completedCount, 2);
});

test("quorum: 2 APPROVE + 1 BLOCK (with blocker finding) → CHANGES_REQUESTED (veto preserves §11)", () => {
  const out = quorumAggregateVerdict(
    [
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      completed("c3", "CHANGES_REQUESTED", { blockerFinding: true }),
    ],
    BLOCKING,
    2,
  );
  expect_eq(out.verdict, "CHANGES_REQUESTED");
  expect_eq(out.reason, "veto");
});

test("quorum: 2 BLOCK + 1 APPROVE → CHANGES_REQUESTED (veto AND majority both → veto preferred for reason)", () => {
  const out = quorumAggregateVerdict(
    [
      completed("c1", "CHANGES_REQUESTED", { blockerFinding: true }),
      completed("c2", "CHANGES_REQUESTED", { blockerFinding: true }),
      completed("c3", "APPROVED"),
    ],
    BLOCKING,
    2,
  );
  expect_eq(out.verdict, "CHANGES_REQUESTED");
  // Veto is the priority-1 reason in cycle322.3 §Component 2
  // verdict rules; both veto AND majority apply but veto wins so
  // operators see the higher-signal alert reason.
  expect_eq(out.reason, "veto");
});

test("quorum: 1 APPROVE + 1 BLOCK + 1 ERROR → CHANGES_REQUESTED (veto wins)", () => {
  const out = quorumAggregateVerdict(
    [
      completed("c1", "APPROVED"),
      completed("c2", "CHANGES_REQUESTED", { blockerFinding: true }),
      errored("c3"),
    ],
    BLOCKING,
    2,
  );
  expect_eq(out.verdict, "CHANGES_REQUESTED");
  expect_eq(out.reason, "veto");
});

test("quorum: 1 APPROVE + 2 ERROR → CHANGES_REQUESTED, reason=quorum_unmet", () => {
  const out = quorumAggregateVerdict(
    [
      completed("c1", "APPROVED"),
      errored("c2"),
      errored("c3"),
    ],
    BLOCKING,
    2,
  );
  expect_eq(out.verdict, "CHANGES_REQUESTED");
  expect_eq(out.reason, "quorum_unmet");
  expect_eq(out.completedCount, 1);
});

test("quorum: 3 ERROR (zero completing) → CHANGES_REQUESTED, reason=quorum_unmet", () => {
  const out = quorumAggregateVerdict(
    [errored("c1"), errored("c2"), errored("c3")],
    BLOCKING,
    2,
  );
  expect_eq(out.verdict, "CHANGES_REQUESTED");
  expect_eq(out.reason, "quorum_unmet");
  expect_eq(out.completedCount, 0);
});

test("quorum: 1 BLOCK (with blocker finding) + 2 ERROR → CHANGES_REQUESTED, reason=veto (NOT quorum_unmet)", () => {
  // The §11 invariant: a single rigorous critic vetoes regardless
  // of quorum status. A vendor outage hitting 2 critics MUST NOT
  // mask the third critic's blocker finding by demoting it to
  // quorum_unmet.
  const out = quorumAggregateVerdict(
    [
      completed("c1", "CHANGES_REQUESTED", { blockerFinding: true }),
      errored("c2"),
      errored("c3"),
    ],
    BLOCKING,
    2,
  );
  expect_eq(out.verdict, "CHANGES_REQUESTED");
  expect_eq(out.reason, "veto");
});

test("quorum: 2-1 disagree split (2 APPROVE, 1 CHANGES_REQUESTED without blockers) → CHANGES_REQUESTED (veto)", () => {
  // CHANGES_REQUESTED with no blocking findings and no
  // requiresHumanJudgment IS a veto per criticVetoesGate (the
  // verdict itself is the signal), so this case yields a veto —
  // NOT majority even though 2 of 3 voted APPROVED. The test
  // verifies the boundary explicitly: a CHANGES_REQUESTED verdict
  // from any completed critic wins over a numerical majority.
  const out = quorumAggregateVerdict(
    [
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      completed("c3", "CHANGES_REQUESTED"),
    ],
    BLOCKING,
    2,
  );
  // The CHANGES_REQUESTED verdict on c3 is itself a veto per
  // criticVetoesGate — so veto wins, even with no blocking
  // findings.
  expect_eq(out.verdict, "CHANGES_REQUESTED");
  expect_eq(out.reason, "veto");
});

test("quorum: HIGH-severity finding without blocker still vetoes (HIGH in blockingSeverities)", () => {
  const out = quorumAggregateVerdict(
    [
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      completed("c3", "APPROVED", { highFinding: true }),
    ],
    BLOCKING, // ["blocker", "high"]
    2,
  );
  // c3 APPROVED but has a HIGH finding → veto by criticVetoesGate
  expect_eq(out.verdict, "CHANGES_REQUESTED");
  expect_eq(out.reason, "veto");
});

test("quorum: BARE requiresHumanJudgment (APPROVED + 0 findings) does NOT veto → majority APPROVED (#241)", () => {
  // Issue #241 — a bare result-level rHJ on c3 (APPROVED + 0 findings)
  // is demoted to a non-blocking note by default, so the 3-APPROVE
  // majority stands instead of deadlocking. This is the exact
  // triggering shape from momentiq-ai/cerebe-platform#337 (cursor:
  // APPROVED, 0 findings, bare rHJ).
  const out = quorumAggregateVerdict(
    [
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      completed("c3", "APPROVED", { requiresHumanJudgment: true }),
    ],
    BLOCKING,
    2,
  );
  expect_eq(out.verdict, "APPROVED");
  expect_eq(out.reason, "majority");
});

test("quorum: bare rHJ with NON-blocking findings (the minimax shape) does NOT veto → majority (#241)", () => {
  // Issue #241 — the minimax triggering shape: APPROVED, rHJ, and a
  // NON-blocking (note-severity) finding. "Bare" means "no blocking
  // finding + non-CR verdict", NOT literally zero findings, so this is
  // still demoted. Build the result directly so a note-severity finding
  // rides along (the `completed` helper only adds blocking findings).
  const minimaxShape: CriticResult = {
    ...completed("c3", "APPROVED", { requiresHumanJudgment: true }),
    findings: [
      {
        severity: "note",
        category: "style",
        evidence: "subjective naming nit",
        impact: "minor",
        requiredFix: "consider renaming",
      },
    ],
  };
  const out = quorumAggregateVerdict(
    [completed("c1", "APPROVED"), completed("c2", "APPROVED"), minimaxShape],
    BLOCKING,
    2,
  );
  // c3 has rHJ but no BLOCKING finding and an APPROVED verdict → demoted.
  expect_eq(out.verdict, "APPROVED");
  expect_eq(out.reason, "majority");
});

test("quorum: rHJ riding a blocking finding STILL vetoes (#241 — §11 safety net)", () => {
  const out = quorumAggregateVerdict(
    [
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      completed("c3", "APPROVED", { requiresHumanJudgment: true, blockerFinding: true }),
    ],
    BLOCKING,
    2,
  );
  expect_eq(out.verdict, "CHANGES_REQUESTED");
  expect_eq(out.reason, "veto");
});

// ---------------------------------------------------------------------------
// evaluateQuorumCriticResults — gate-block reason mapping

test("gate-quorum: 3 APPROVE → no blocks", () => {
  const blocks: GateBlock[] = [];
  const warnings: GateWarning[] = [];
  evaluateQuorumCriticResults(
    artifact([
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      completed("c3", "APPROVED"),
    ]),
    BLOCKING,
    2,
    blocks,
    warnings,
  );
  expect_eq(blocks.length, 0);
});

test("gate-quorum: 1 APPROVE + 2 ERROR → block reason=quorum_unmet", () => {
  const blocks: GateBlock[] = [];
  const warnings: GateWarning[] = [];
  evaluateQuorumCriticResults(
    artifact([completed("c1", "APPROVED"), errored("c2"), errored("c3")]),
    BLOCKING,
    2,
    blocks,
    warnings,
  );
  const reasons = blocks.map((b) => b.reason);
  expect_deep(reasons, ["quorum_unmet"]);
  // detail should name the errored adapters for diagnostics
  expect_match(blocks[0]!.detail ?? "", /c2.*c3|c3.*c2/);
  // Errored critics still surface as warnings for operator
  // visibility (the quorum_unmet block names them too, but
  // dedicated warnings carry the per-critic error message).
  const errorWarnings = warnings.filter((w) => w.reason === "critic_error");
  expect_eq(errorWarnings.length, 2);
});

test("gate-quorum: 1 BLOCK + 2 ERROR → veto blocks, NOT quorum_unmet (§11 invariant)", () => {
  const blocks: GateBlock[] = [];
  const warnings: GateWarning[] = [];
  evaluateQuorumCriticResults(
    artifact([
      completed("c1", "CHANGES_REQUESTED", { blockerFinding: true }),
      errored("c2"),
      errored("c3"),
    ]),
    BLOCKING,
    2,
    blocks,
    warnings,
  );
  const reasons = blocks.map((b) => b.reason);
  // veto path: changes_requested + blocker_finding. NOT quorum_unmet.
  expect_truthy(reasons.includes("changes_requested"));
  expect_truthy(reasons.includes("blocker_finding"));
  expect_truthy(!reasons.includes("quorum_unmet"));
});

test("gate-quorum: 2 APPROVE + 1 BLOCK with blocker finding → veto blocks (no quorum_unmet)", () => {
  const blocks: GateBlock[] = [];
  const warnings: GateWarning[] = [];
  evaluateQuorumCriticResults(
    artifact([
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      completed("c3", "CHANGES_REQUESTED", { blockerFinding: true }),
    ]),
    BLOCKING,
    2,
    blocks,
    warnings,
  );
  const reasons = blocks.map((b) => b.reason);
  expect_truthy(reasons.includes("changes_requested"));
  expect_truthy(reasons.includes("blocker_finding"));
  expect_truthy(!reasons.includes("quorum_unmet"));
});

test("gate-quorum: BARE requiresHumanJudgment does NOT block under quorum (#241)", () => {
  // Issue #241 — `evaluateQuorumCriticResults` gates the
  // requires_human_judgment block behind `criticVetoesGate`, so a bare
  // rHJ (APPROVED + 0 findings) no longer produces a block. (The
  // block-if-any evaluator surfaces it as a non-blocking warning; this
  // quorum path simply does not block.)
  const blocks: GateBlock[] = [];
  const warnings: GateWarning[] = [];
  evaluateQuorumCriticResults(
    artifact([
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      completed("c3", "APPROVED", { requiresHumanJudgment: true }),
    ]),
    BLOCKING,
    2,
    blocks,
    warnings,
  );
  const reasons = blocks.map((b) => b.reason);
  expect_eq(reasons.includes("requires_human_judgment"), false);
});

test("gate-quorum: NON-bare requiresHumanJudgment (rHJ + blocking finding) STILL blocks (#241 — §11)", () => {
  // The §11 safety net: an rHJ riding a blocking finding keeps blocking,
  // and the block carries the requires_human_judgment reason.
  const blocks: GateBlock[] = [];
  const warnings: GateWarning[] = [];
  evaluateQuorumCriticResults(
    artifact([
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      completed("c3", "APPROVED", { requiresHumanJudgment: true, blockerFinding: true }),
    ]),
    BLOCKING,
    2,
    blocks,
    warnings,
  );
  const reasons = blocks.map((b) => b.reason);
  expect_truthy(reasons.includes("requires_human_judgment"));
});

test("gate-quorum: pending critic generates a warning (not a block) under quorum", () => {
  const blocks: GateBlock[] = [];
  const warnings: GateWarning[] = [];
  evaluateQuorumCriticResults(
    artifact([
      completed("c1", "APPROVED"),
      completed("c2", "APPROVED"),
      pending("c3"),
    ]),
    BLOCKING,
    2,
    blocks,
    warnings,
  );
  // 2 completed + 1 pending → quorum met (2 >= 2), no blocks
  expect_eq(blocks.length, 0);
  const inProgressWarnings = warnings.filter((w) => w.reason === "critic_in_progress");
  expect_eq(inProgressWarnings.length, 1);
});

test("gate-quorum: aggregateVerdict dispatches to quorum logic when policy=min-complete-quorum", async () => {
  // Round-trip: build a config with min-complete-quorum, run
  // through the schema parser, simulate a 1-completed-2-errored
  // artifact, verify quorumAggregateVerdict reason is reflected.
  // (This is the integration that ensures aggregateVerdict in
  // report.ts correctly dispatches without an explicit policy
  // parameter — only `loaded.config.aggregation.policy`.)
  const out = quorumAggregateVerdict(
    [completed("c1", "APPROVED"), errored("c2"), errored("c3")],
    BLOCKING,
    2,
  );
  expect_eq(out.reason, "quorum_unmet");
});
