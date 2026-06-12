import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { LoadedConfig } from "./config.js";
import {
  collectChangedPaths,
  perShaQualityGatePath,
  type CommitTrailers,
} from "../evidence/index.js";
import { matchAnyGlob } from "../glob.js";
import {
  changedFiles,
  commitDiff,
  commitMetadata,
  commitParent,
  diffHash,
  resolveCommit,
} from "../git.js";
import { parseCommitTrailers } from "../evidence/index.js";
import { resolveArtifactDir, resolveArtifactRoot, telemetryPath } from "../paths.js";
import {
  findingCarriesCorroborationFlag,
  isCorroboratedByOtherCritic,
  isCriticCompleted,
  criticVetoesGate,
  quorumAggregateVerdict,
  readArtifact,
} from "../report.js";
import {
  classifyTdd as classifyTddImpl,
  type TddClassifierConfig,
  type TddClassifierResult,
} from "./tdd-classifier.js";
import {
  parseQualityGateEvidence,
  type GateBlock,
  type GateResult,
  type GateWarning,
  type QualityGateEvidence,
  type ReviewArtifact,
  type ReviewFinding,
  type ReviewSeverity,
  type VerificationRoute,
} from "@momentiq/dark-factory-schemas";

const BYPASS_ENV = "AGENT_REVIEW_BYPASS";

// Re-export classifyTdd from gate.ts so the cycle 318.2 exit-criteria
// statement ("gate.ts exports classifyTdd()") is satisfied without
// mixing the pure classifier logic into this file.
export { classifyTddImpl as classifyTdd };
export type { TddClassifierConfig, TddClassifierResult };

export interface EvaluateGateOptions {
  loaded: LoadedConfig;
  commit: string;
  cwd?: string;
  allowBypass?: boolean;
  bypassReason?: string;
  // Cycle 318.2 Component 5: rubric context. When set, blocker/high
  // findings on each critic result are pre-filtered through
  // `enforceFindingRubric` before contributing to gate blocks. Stripping
  // is logged to `_runs.ndjson` as `event: "rubric_strip"`.
  //
  // The orchestration helper `runCommitGate` builds the context from the
  // commit trailers + per-SHA evidence; pure-artifact tests of
  // `evaluateCommitGate` leave this undefined to keep the old behavior.
  rubricContext?: RubricStripContext;
  // Cycle 322.7 — when a profile is active, the caller may override
  // the aggregation quorum used by the quorum-policy evaluator. The
  // profile's `quorum` value replaces `loaded.config.aggregation.quorum`
  // for this gate evaluation. Has no effect under `block-if-any`.
  quorumOverride?: number;
  // Cycle 322.7 — when a profile is active, narrow the artifact's
  // `criticResults` to this allowlist before passing to the
  // policy-specific evaluator. Otherwise out-of-profile critics in the
  // artifact (e.g., a commit reviewed under `cloud` then pushed under
  // `local`) would contribute to the gate decision even though the
  // active profile is supposed to ignore them (Codex P2 on PR #1468).
  // When undefined, no filter applies.
  profileCriticIds?: ReadonlyArray<string>;
}

export async function evaluateCommitGate(options: EvaluateGateOptions): Promise<GateResult> {
  const { loaded, commit } = options;
  const cwd = options.cwd ?? loaded.repoRoot;
  const allowBypass = options.allowBypass ?? loaded.config.policy.allowEmergencyBypass;
  const bypassReasonRaw = options.bypassReason ?? process.env[BYPASS_ENV] ?? "";
  const bypassReason = bypassReasonRaw.trim();

  if (allowBypass && bypassReason) {
    return {
      blocked: false,
      blocks: [],
      warnings: [
        {
          reason: `bypass invoked: ${bypassReason}`,
        },
      ],
      bypass: { reason: bypassReason, at: new Date().toISOString() },
    };
  }

  const blocks: GateBlock[] = [];
  const warnings: GateWarning[] = [];

  const sha = await resolveCommit(commit, cwd);
  const artifact = await readArtifact(loaded, sha);
  if (!artifact) {
    if (loaded.config.policy.blockOnMissingReview) {
      blocks.push({
        reason: "missing_review",
        detail: `no review artifact for ${sha}; run \`make agent-review-commit COMMIT=${sha}\``,
      });
      return { blocked: true, blocks, warnings };
    }
    warnings.push({
      reason: "missing_review",
      detail: `no review artifact for ${sha} (blockOnMissingReview disabled)`,
    });
    return { blocked: false, blocks, warnings };
  }

  if (artifact.status === "pending" || artifact.status === "running") {
    blocks.push({
      reason: "review_in_progress",
      detail: `artifact status is ${artifact.status}; wait for completion`,
    });
    return { blocked: true, blocks, warnings };
  }

  if (artifact.status === "error") {
    if (loaded.config.policy.blockOnReviewError) {
      blocks.push({
        reason: "review_error",
        detail: "artifact status is error",
      });
      return { blocked: true, blocks, warnings };
    }
    warnings.push({ reason: "review_error" });
  }

  // Cycle 332 — precondition check for shape compatibility. Feeding a
  // push-range artifact to the commit gate would silently produce
  // stale_diff_hash (commit gate recomputes diffHash over
  // parent..sha; push artifact's diffHash is over base..head). A
  // distinct error keeps the operator's failure-mode dispatch
  // legible. Legacy artifacts (rangeKind undefined) are treated as
  // commit-shape for back-compat.
  if (artifact.rangeKind === "push") {
    blocks.push({
      reason: "artifact_shape_mismatch",
      detail:
        "evaluateCommitGate received a push-shape artifact (rangeKind=push); use evaluatePushGate for review-push runs.",
    });
    return { blocked: true, blocks, warnings };
  }

  // Verify diff hash freshness
  try {
    const parent = await safeParent(sha, cwd);
    const diff = await commitDiff(parent, sha, cwd);
    const expected = diffHash(diff);
    if (expected !== artifact.diffHash) {
      blocks.push({
        reason: "stale_diff_hash",
        detail: `expected ${expected}, artifact has ${artifact.diffHash}`,
      });
      return { blocked: true, blocks, warnings };
    }
  } catch (err) {
    blocks.push({
      reason: "diff_hash_check_failed",
      detail: (err as Error).message,
    });
    return { blocked: true, blocks, warnings };
  }

  await enforceRequiredQualityGates(loaded, sha, blocks);

  // Cycle 318.2 Component 5: when a rubric context is supplied (v2-aware
  // orchestrator path), strip naked blocker/high findings on each critic
  // result BEFORE the artifact-level evaluation. The stripped findings
  // never reach `evaluateCriticResults`, so a naked "missing tests"
  // finding with no evidence does not block the push. Stripping is
  // logged to NDJSON for audit by `enforceFindingRubric` itself.
  const rubricArtifact = options.rubricContext
    ? applyRubricToArtifact(artifact, options.rubricContext)
    : artifact;

  // Cycle 322.7 — when a profile is active at gate-push time, narrow the
  // artifact's criticResults to the profile's allowlist BEFORE policy
  // dispatch. Without this, a commit reviewed under `cloud` (3 critics)
  // and pushed under `--profile local` (2 critics) would still see
  // out-of-profile critics' verdicts contribute to the gate decision —
  // a divergence Codex P2 caught on PR #1468. Out-of-profile critics
  // are added as informational warnings so operators still see they
  // existed.
  //
  // After filtering, ALSO recompute the artifact's gateVerdict from the
  // scoped result set. Without this, the block-if-any cross-check at
  // `evaluateCriticResults:503-511` (which checks `artifact.gateVerdict
  // === "CHANGES_REQUESTED" && blocks.length === 0`) would falsely fire:
  // the verdict was set by buildAggregate against the FULL critic list,
  // but after profile filtering the scoped blocks could legitimately be
  // empty. (Cursor critic high finding on PR #1468 commit c7537f34.)
  let scopedArtifact = rubricArtifact;
  if (options.profileCriticIds && options.profileCriticIds.length > 0) {
    const allowed = new Set(options.profileCriticIds);
    const scopedResults = rubricArtifact.criticResults.filter((r) =>
      allowed.has(r.criticId),
    );
    const outOfProfile = rubricArtifact.criticResults.filter(
      (r) => !allowed.has(r.criticId),
    );
    for (const r of outOfProfile) {
      warnings.push({
        reason: "out_of_profile_critic",
        criticId: r.criticId,
        detail: `critic "${r.criticId}" ran but is not in the active profile's criticIds; verdict ignored at gate`,
      });
    }
    // Recompute gateVerdict from the scoped result set so the cross-check
    // in evaluateCriticResults sees a like-for-like aggregate. Only
    // recompute when the artifact is complete (status === "complete"):
    // pending/error artifacts have no gateVerdict to overwrite, and
    // the policy-specific evaluator handles those cases directly.
    let scopedVerdict = rubricArtifact.gateVerdict;
    if (rubricArtifact.status === "complete") {
      scopedVerdict = recomputeArtifactVerdict(
        scopedResults,
        loaded,
        options.quorumOverride,
      );
    }
    scopedArtifact = {
      ...rubricArtifact,
      criticResults: scopedResults,
      ...(scopedVerdict !== undefined ? { gateVerdict: scopedVerdict } : {}),
    };
  }

  // Cycle 322.3 — dispatch on aggregation policy.
  //   - `min-complete-quorum`: quorum-aware evaluator (defined below).
  //     The `required` flag is semantically irrelevant under the
  //     quorum policy (all critics contribute to the quorum count
  //     and any one can veto via §11), so the dispatcher does not
  //     thread `requiredCriticIds`.
  //   - `block-if-any` (default): 322.2-shape `required`-threaded
  //     evaluator (preserves shadow-mode semantics).
  if (loaded.config.aggregation.policy === "min-complete-quorum") {
    // Cycle 322.7 — profile.quorum (when supplied) overrides root
    // aggregation.quorum. Fall back to root value otherwise; legacy
    // fallback to 2 preserves cycle 322.3 default for hand-built
    // test configs.
    const effectiveQuorum =
      options.quorumOverride ?? loaded.config.aggregation.quorum ?? 2;
    evaluateQuorumCriticResults(
      scopedArtifact,
      loaded.config.aggregation.blockingSeverities,
      effectiveQuorum,
      blocks,
      warnings,
      loaded.config.aggregation.unilateralVetoRules,
    );
  } else {
    // Cycle 322.2 Component 4 — `required` flag threading.
    // Build the set of required critic ids so the per-critic evaluator
    // demotes findings from optional (`required: false`) critics from
    // `blocks` to `warnings`.
    const requiredCriticIds = new Set(
      loaded.config.critics.filter((c) => c.required).map((c) => c.id),
    );
    evaluateCriticResults(
      scopedArtifact,
      loaded.config.aggregation.blockingSeverities,
      blocks,
      warnings,
      loaded.config.policy.blockOnReviewError,
      requiredCriticIds,
    );
  }

  return { blocked: blocks.length > 0, blocks, warnings };
}

// Cycle 332 — push-range gate evaluator. Parallel to evaluateCommitGate
// for review-push runs (per-push delta). The two evaluators differ in
// three respects:
//   1. Range: this evaluator computes diffHash over <baseSha>..<headSha>
//      (not commit-parent..commit). The runner-push module's
//      buildPushArtifact stamps the same range on the artifact, so the
//      stale_diff_hash check is comparing like-to-like.
//   2. Shape check: this evaluator REJECTS a commit-shape artifact
//      (rangeKind="commit" or undefined). Same rationale as the
//      symmetric check in evaluateCommitGate — a shape mismatch
//      surfaces as artifact_shape_mismatch, not silent
//      stale_diff_hash.
//   3. Quality-gate evidence: enforceRequiredQualityGates(loaded,
//      headSha, blocks) — required deterministic-gate evidence at the
//      current head is enforced identically to the commit gate. A
//      carry-forward run with a failing `make sage-quality-gates-static`
//      artifact for headSha still BLOCKs, regardless of how clean
//      cached critic results are.
//
// The aggregation policy dispatch and rubric / profile-scope logic
// are shared with the commit gate via the same helpers; this
// evaluator differs only in the precondition and diff-hash baseline.
export interface EvaluatePushGateOptions {
  loaded: LoadedConfig;
  artifact: ReviewArtifact;
  baseSha: string;
  headSha: string;
  cwd?: string;
  allowBypass?: boolean;
  bypassReason?: string;
  rubricContext?: RubricStripContext;
  quorumOverride?: number;
  profileCriticIds?: ReadonlyArray<string>;
}

export async function evaluatePushGate(options: EvaluatePushGateOptions): Promise<GateResult> {
  const { loaded, artifact } = options;
  const cwd = options.cwd ?? loaded.repoRoot;
  const allowBypass = options.allowBypass ?? loaded.config.policy.allowEmergencyBypass;
  const bypassReasonRaw = options.bypassReason ?? process.env[BYPASS_ENV] ?? "";
  const bypassReason = bypassReasonRaw.trim();

  if (allowBypass && bypassReason) {
    return {
      blocked: false,
      blocks: [],
      warnings: [{ reason: `bypass invoked: ${bypassReason}` }],
      bypass: { reason: bypassReason, at: new Date().toISOString() },
    };
  }

  const blocks: GateBlock[] = [];
  const warnings: GateWarning[] = [];

  // Shape precondition: reject anything that isn't a push-shape
  // artifact. Legacy (undefined) and explicit "commit" are both
  // rejected — caller should be dispatching to evaluateCommitGate
  // for those.
  if (artifact.rangeKind !== "push") {
    blocks.push({
      reason: "artifact_shape_mismatch",
      detail: `evaluatePushGate received an artifact with rangeKind=${
        artifact.rangeKind ?? "undefined"
      } (expected "push"); use evaluateCommitGate for commit-shape artifacts.`,
    });
    return { blocked: true, blocks, warnings };
  }

  // SHA precondition: the artifact's commit/parent MUST identify the
  // same head/base the gate is being evaluated against. Without this
  // assertion, a fresh artifact for a different push-range could fail
  // loudly only via the downstream diffHash recompute — and only when
  // the two ranges happen to produce different diffs. An explicit
  // SHA check makes mismatched artifacts unambiguous (cycle 332 bot
  // review #5).
  if (artifact.commit !== options.headSha || artifact.parent !== options.baseSha) {
    blocks.push({
      reason: "artifact_sha_mismatch",
      detail: `evaluatePushGate received artifact for commit=${artifact.commit} parent=${artifact.parent} but gate is evaluating headSha=${options.headSha} baseSha=${options.baseSha}`,
    });
    return { blocked: true, blocks, warnings };
  }

  if (artifact.status === "pending" || artifact.status === "running") {
    blocks.push({
      reason: "review_in_progress",
      detail: `artifact status is ${artifact.status}; wait for completion`,
    });
    return { blocked: true, blocks, warnings };
  }

  if (artifact.status === "error") {
    if (loaded.config.policy.blockOnReviewError) {
      blocks.push({
        reason: "review_error",
        detail: "artifact status is error",
      });
      return { blocked: true, blocks, warnings };
    }
    warnings.push({ reason: "review_error" });
  }

  // Verify diff hash freshness over <baseSha>..<headSha>.
  try {
    // The push-shape artifact's diffHash is computed against the
    // base..head range. We recompute the same range here. The
    // commitDiff helper handles non-empty parent, which for
    // base..head is just the base sha.
    const diff = await commitDiff(options.baseSha, options.headSha, cwd);
    const expected = diffHash(diff);
    if (expected !== artifact.diffHash) {
      blocks.push({
        reason: "stale_diff_hash",
        detail: `expected ${expected}, artifact has ${artifact.diffHash}`,
      });
      return { blocked: true, blocks, warnings };
    }
  } catch (err) {
    blocks.push({
      reason: "diff_hash_check_failed",
      detail: (err as Error).message,
    });
    return { blocked: true, blocks, warnings };
  }

  // Quality-gate evidence enforced at headSha — same contract as
  // the commit gate, scoped to the head of the push range.
  await enforceRequiredQualityGates(loaded, options.headSha, blocks);

  const rubricArtifact = options.rubricContext
    ? applyRubricToArtifact(artifact, options.rubricContext)
    : artifact;

  let scopedArtifact = rubricArtifact;
  if (options.profileCriticIds && options.profileCriticIds.length > 0) {
    const allowed = new Set(options.profileCriticIds);
    const scopedResults = rubricArtifact.criticResults.filter((r) =>
      allowed.has(r.criticId),
    );
    const outOfProfile = rubricArtifact.criticResults.filter(
      (r) => !allowed.has(r.criticId),
    );
    for (const r of outOfProfile) {
      warnings.push({
        reason: "out_of_profile_critic",
        criticId: r.criticId,
        detail: `critic "${r.criticId}" ran but is not in the active profile's criticIds; verdict ignored at gate`,
      });
    }
    let scopedVerdict = rubricArtifact.gateVerdict;
    if (rubricArtifact.status === "complete") {
      scopedVerdict = recomputeArtifactVerdict(
        scopedResults,
        loaded,
        options.quorumOverride,
      );
    }
    scopedArtifact = {
      ...rubricArtifact,
      criticResults: scopedResults,
      ...(scopedVerdict !== undefined ? { gateVerdict: scopedVerdict } : {}),
    };
  }

  if (loaded.config.aggregation.policy === "min-complete-quorum") {
    const effectiveQuorum =
      options.quorumOverride ?? loaded.config.aggregation.quorum ?? 2;
    evaluateQuorumCriticResults(
      scopedArtifact,
      loaded.config.aggregation.blockingSeverities,
      effectiveQuorum,
      blocks,
      warnings,
      loaded.config.aggregation.unilateralVetoRules,
    );
  } else {
    const requiredCriticIds = new Set(
      loaded.config.critics.filter((c) => c.required).map((c) => c.id),
    );
    evaluateCriticResults(
      scopedArtifact,
      loaded.config.aggregation.blockingSeverities,
      blocks,
      warnings,
      loaded.config.policy.blockOnReviewError,
      requiredCriticIds,
    );
  }

  return { blocked: blocks.length > 0, blocks, warnings };
}

function applyRubricToArtifact(
  artifact: ReviewArtifact,
  context: RubricStripContext,
): ReviewArtifact {
  // Deep-replace each critic's findings with the rubric-kept subset AND
  // recompute the critic's verdict when stripping removes the last
  // blocking finding (codex P2 follow-up on PR #1349). Without the
  // verdict recompute, an artifact whose CHANGES_REQUESTED verdict was
  // driven by now-stripped blockers still triggers the existing
  // `verdict === "CHANGES_REQUESTED"` block path in `evaluateCriticResults`,
  // re-blocking the push that the rubric just cleared.
  //
  // The artifact itself is returned shallow-copied so callers don't
  // observe mutation of the on-disk artifact.
  const blockingSeverities = context.loaded.config.aggregation.blockingSeverities;
  const newCriticResults = artifact.criticResults.map((cr) => {
    const { kept, stripped } = enforceFindingRubric(cr.findings, context);
    const updated = { ...cr, findings: kept };
    // Only recompute verdict for completed critics — pending/running/error
    // already have specialized handling in `evaluateCriticResults`.
    //
    // Critical: we only flip CHANGES_REQUESTED → APPROVED when the rubric
    // ACTUALLY stripped a blocking finding. If the verdict was already
    // CHANGES_REQUESTED for a different reason (e.g., the critic
    // intentionally returned CHANGES_REQUESTED with only medium findings,
    // or the verdict was set by `aggregateVerdict` for a non-finding
    // reason), the rubric step is silent and the verdict stays.
    // (Codex P2 follow-up on d46b8be7 — predicate was too broad.)
    if (updated.status === "complete" && updated.verdict === "CHANGES_REQUESTED") {
      const strippedBlockingCount = stripped.filter((s) =>
        blockingSeverities.includes(s.finding.severity),
      ).length;
      const stillHasBlocking = kept.some((f) =>
        blockingSeverities.includes(f.severity),
      );
      if (
        strippedBlockingCount > 0 &&
        !stillHasBlocking &&
        !updated.requiresHumanJudgment
      ) {
        updated.verdict = "APPROVED";
      }
    }
    return updated;
  });
  // The artifact-level `gateVerdict` is also derived from critic verdicts
  // by `buildAggregate()`. Recompute it from the rewritten critic results
  // so the gate-level check stays consistent: a per-critic verdict flip
  // to APPROVED has to surface at the aggregate too, or the existing
  // "aggregate_changes_requested" cross-check in `evaluateCriticResults`
  // re-blocks the same push.
  const recomputedArtifact: ReviewArtifact = {
    ...artifact,
    criticResults: newCriticResults,
  };
  if (artifact.status === "complete") {
    // Cycle 322.2 — recompute is required-aware so an optional critic's
    // surviving blockers don't re-flip the aggregate after rubric strip.
    const requiredCriticIds = new Set(
      context.loaded.config.critics.filter((c) => c.required).map((c) => c.id),
    );
    recomputedArtifact.gateVerdict = recomputeGateVerdict(
      newCriticResults,
      blockingSeverities,
      requiredCriticIds,
    );
  }
  return recomputedArtifact;
}

function recomputeGateVerdict(
  results: ReadonlyArray<{
    criticId: string;
    status: string;
    verdict?: string;
    requiresHumanJudgment: boolean;
    findings: ReadonlyArray<{ severity: string }>;
  }>,
  blockingSeverities: readonly string[],
  // Cycle 322.2 — optional critics' verdicts don't drive recomputation;
  // only required critics determine the aggregate gate verdict here.
  requiredCriticIds: ReadonlySet<string>,
): "APPROVED" | "CHANGES_REQUESTED" {
  for (const r of results) {
    if (!requiredCriticIds.has(r.criticId)) continue;
    if (r.status !== "complete") return "CHANGES_REQUESTED";
    if (r.verdict === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
    if (r.requiresHumanJudgment) return "CHANGES_REQUESTED";
    if (r.findings.some((f) => blockingSeverities.includes(f.severity))) {
      return "CHANGES_REQUESTED";
    }
  }
  return "APPROVED";
}

/**
 * Cycle 322.7 — recompute the artifact's gateVerdict from a scoped
 * (profile-filtered) result set, dispatching on the same policy the
 * runner used. Always returns a verdict — the caller is expected to
 * only invoke this for completed artifacts (the only artifact status
 * that has a gateVerdict to overwrite).
 *
 * This is the symmetric helper to the recomputation already performed
 * by `applyRubricToArtifact` when the rubric strip removes the
 * blocker that drove the verdict. Without this, profile-filtered
 * gate evaluation could falsely trip the `aggregate_changes_requested`
 * cross-check at `evaluateCriticResults:503-511` (Cursor critic high
 * finding on PR #1468 commit c7537f34).
 */
function recomputeArtifactVerdict(
  scopedResults: CriticResultSummary[],
  loaded: LoadedConfig,
  quorumOverride: number | undefined,
): "APPROVED" | "CHANGES_REQUESTED" {
  if (loaded.config.aggregation.policy === "min-complete-quorum") {
    const quorum = quorumOverride ?? loaded.config.aggregation.quorum ?? 2;
    return quorumAggregateVerdict(
      // Cast: `quorumAggregateVerdict` reads CriticResult fields by
      // name; scoped results are a subset of the original artifact's
      // results array, so the shape is identical.
      scopedResults as ReadonlyArray<unknown> as Parameters<typeof quorumAggregateVerdict>[0],
      loaded.config.aggregation.blockingSeverities,
      quorum,
      // Issue dark-factory-platform#112 — thread the corroboration
      // rules so a profile-filtered recompute honors the same policy
      // the live verdict computation does.
      loaded.config.aggregation.unilateralVetoRules,
    ).verdict;
  }
  // block-if-any: only required critics drive the aggregate.
  const requiredCriticIds = new Set(
    loaded.config.critics.filter((c) => c.required).map((c) => c.id),
  );
  return recomputeGateVerdict(
    scopedResults,
    loaded.config.aggregation.blockingSeverities,
    requiredCriticIds,
  );
}

type CriticResultSummary = {
  criticId: string;
  status: string;
  verdict?: string;
  requiresHumanJudgment: boolean;
  findings: ReadonlyArray<{ severity: string }>;
};

// Deterministic gate-evidence enforcement, independent of critic verdict.
// Without this, a critic that returns APPROVED while `qualityGatesMissing`
// is non-empty (or any required gate has non-zero exit) would let the push
// through. The gate must enforce the configured required gates directly
// rather than trusting the model. Adapter populates each critic result's
// `validation` view from the same packet, so reading any one is sufficient.
async function enforceRequiredQualityGates(
  loaded: LoadedConfig,
  sha: string,
  blocks: GateBlock[],
): Promise<void> {
  const required = loaded.config.validation.requiredQualityGates;
  if (required.length === 0) return;
  // Closes #1549. Read the per-SHA quality-gate evidence file DIRECTLY
  // rather than `artifact.criticResults[0]?.validation`. The old path was
  // fragile in two ways the dogfood case made obvious:
  //   (a) `criticResults[0]` is whichever critic appears first in
  //       `.agent-review/config.json`. When that critic errored (e.g.,
  //       cursor sandbox failure in CI runs since the post-#1546/1547
  //       cleanup), the adapter builds a `status: "error"` result with
  //       `validation: { qualityGateResults: [], qualityGatesMissing: [] }`
  //       — so every required gate trips `required_gate_missing` even
  //       though gate-prepare wrote real evidence to disk.
  //   (b) Even on the success path, the adapter's `validation` block is
  //       a SECONDHAND copy of `packet.validation.evidence` (set by the
  //       cursor/codex/gemini/grok adapters from the same packet). The
  //       gate's authoritative source of truth is the on-disk per-SHA
  //       file written by `gate-prepare`; routing through critic state
  //       only added a layer that could go wrong.
  // `readPerShaEvidence` returns null when the file is missing OR when
  // its `commit` field doesn't match `sha` (the integrity check in
  // `readPerShaEvidence`). Both states collapse to `required_gate_missing`
  // with the same detail; that's intentional — the operator action is
  // the same either way (re-run `gate-prepare --commit <sha>`).
  const evidence = await readPerShaEvidence(loaded, sha);
  if (!evidence) {
    for (const gate of required) {
      blocks.push({
        reason: "required_gate_missing",
        detail: `no per-SHA evidence file for ${sha}; run \`gate-prepare --commit ${sha}\``,
      });
    }
    return;
  }
  for (const gate of required) {
    const result = evidence.results.find((r) => r.command === gate);
    if (!result) {
      blocks.push({
        reason: "required_gate_missing",
        detail: `no evidence for required gate: ${gate}`,
      });
      continue;
    }
    if (result.exitCode !== 0) {
      blocks.push({
        reason: "required_gate_failed",
        detail: `${gate} exit=${result.exitCode}`,
      });
    }
  }
}

function evaluateCriticResults(
  artifact: ReviewArtifact,
  blockingSeverities: ReviewSeverity[],
  blocks: GateBlock[],
  warnings: GateWarning[],
  blockOnReviewError: boolean,
  // Cycle 322.2 Component 4 — `required` flag threading. Findings,
  // verdict flips, and human-judgment markers from optional
  // (`required: false`) critics are demoted to warnings instead of
  // contributing to blocks. Errors from optional critics are similarly
  // demoted (the `blockOnReviewError` flag still applies, but only for
  // required critics — an optional critic's transient SDK error must
  // never block the gate by definition of being optional).
  requiredCriticIds: ReadonlySet<string>,
): void {
  // Track per-critic errors that we downgraded to warnings. The aggregate
  // cross-check below must not silently re-block them via the "verdict was
  // CHANGES_REQUESTED but no block captured" path. Without this counter,
  // `buildAggregate()` flips the verdict to CHANGES_REQUESTED for any
  // required errored critic (in `report.ts:aggregateVerdict`), which then
  // re-blocks even though the operator set `blockOnReviewError=false`.
  // (Cycle 3 #13 follow-up — flagged by critic on cerebe df2169a.)
  let errorsDowngraded = 0;
  for (const result of artifact.criticResults) {
    const isRequired = requiredCriticIds.has(result.criticId);
    if (result.status === "error") {
      // Per-critic errors (startup/JSON/schema failures) are persisted
      // inside a `status: "complete"` artifact, so the artifact-level
      // `blockOnReviewError` check above wouldn't apply here. Honor the
      // same flag at the per-critic level — without this, setting
      // `blockOnReviewError=false` had no effect for the common failure
      // path. (Cycle 3 #13)
      // Cycle 322.2 — optional critic errors are unconditionally demoted
      // to warnings; only required critic errors honor blockOnReviewError.
      const detail = result.error?.message ?? "critic returned error";
      if (isRequired && blockOnReviewError) {
        blocks.push({ reason: "critic_error", criticId: result.criticId, detail });
      } else {
        warnings.push({ reason: "critic_error", criticId: result.criticId, detail });
        if (isRequired) errorsDowngraded++;
      }
      continue;
    }
    if (result.status === "pending" || result.status === "running") {
      // Cycle 322.2 — pending/running on optional critics is a warning
      // (informational); only required critics block on in-progress state.
      if (isRequired) {
        blocks.push({
          reason: "critic_in_progress",
          criticId: result.criticId,
          detail: `critic status is ${result.status}`,
        });
      } else {
        warnings.push({
          reason: "critic_in_progress",
          criticId: result.criticId,
          detail: `critic status is ${result.status} (optional)`,
        });
      }
      continue;
    }
    if (result.requiresHumanJudgment) {
      if (isRequired) {
        blocks.push({
          reason: "requires_human_judgment",
          criticId: result.criticId,
          detail: result.summary,
        });
      } else {
        warnings.push({
          reason: "requires_human_judgment",
          criticId: result.criticId,
          detail: `${result.summary} (optional)`,
        });
      }
    }
    if (result.verdict === "CHANGES_REQUESTED") {
      if (isRequired) {
        blocks.push({
          reason: "changes_requested",
          criticId: result.criticId,
          detail: result.summary,
        });
      } else {
        warnings.push({
          reason: "changes_requested",
          criticId: result.criticId,
          detail: `${result.summary} (optional)`,
        });
      }
    }
    const blocking = result.findings.filter((f) => blockingSeverities.includes(f.severity));
    for (const f of blocking) {
      const detail = `${f.category}@${f.file ?? "?"}: ${f.evidence}`;
      if (isRequired) {
        blocks.push({ reason: `${f.severity}_finding`, criticId: result.criticId, detail });
      } else {
        warnings.push({
          reason: `${f.severity}_finding`,
          criticId: result.criticId,
          detail: `${detail} (optional)`,
        });
      }
    }
    const nonBlocking = result.findings.filter((f) => !blockingSeverities.includes(f.severity));
    for (const f of nonBlocking) {
      // Below-threshold findings are always warnings regardless of the
      // critic's required flag.
      warnings.push({
        reason: `${f.severity}_finding`,
        criticId: result.criticId,
        detail: `${f.category}@${f.file ?? "?"}: ${f.evidence}`,
      });
    }
  }

  // Aggregate gate verdict cross-check. Skip when the only reason the
  // aggregate is CHANGES_REQUESTED is downgraded errors — otherwise the
  // operator's `blockOnReviewError=false` setting would be silently
  // overridden by the cross-check for required critics, since
  // `aggregateVerdict()` flips on required+error before this gate runs.
  if (
    artifact.gateVerdict === "CHANGES_REQUESTED" &&
    blocks.length === 0 &&
    errorsDowngraded === 0
  ) {
    blocks.push({
      reason: "aggregate_changes_requested",
      detail: "gateVerdict is CHANGES_REQUESTED but no per-critic blocker captured",
    });
  }
}

// ---------------------------------------------------------------------------
// Cycle 322.3 — `min-complete-quorum` gate evaluator.
//
// Companion to `report.ts:quorumAggregateVerdict` — both functions
// share the same "completed", "vetoes" predicates via the helper
// exports so the gate-block enforcement and the aggregate-verdict
// computation cannot drift.
//
// Verdict→block mapping:
//   - veto by any completed critic → `blocker_finding` /
//     `high_finding` / `requires_human_judgment` /
//     `changes_requested` blocks (one per veto-source) PLUS the
//     non-blocking findings as warnings. Identical block reason
//     strings to the block-if-any evaluator so downstream parsers
//     don't need a separate quorum-mode branch.
//   - completed_count < quorum (no veto) → `quorum_unmet` block.
//     Distinct block reason so operators can route alerts
//     differently from content blocks (e.g., page on a sustained
//     `quorum_unmet` spike correlated with `critic_run_error`).
//   - completed_count >= quorum, no veto → no blocks.
//
// Per-critic errors are recorded as warnings unconditionally under
// quorum policy — `quorum_unmet` is the canonical fail-closed
// signal when too many critics error. This is a deliberate
// semantic divergence from `block-if-any` (where
// `policy.blockOnReviewError=true` blocks on any required-critic
// error): under quorum, the operator-facing "fail-closed" knob is
// the `quorum` value itself. Setting `quorum = critics.length`
// forces ALL critics to complete for the gate to pass (any single
// error → `quorum_unmet` → block); lower quorum values express the
// operator's tolerance for vendor outages. `blockOnReviewError`
// would be redundant with `quorum` under this scheme and is
// therefore NOT threaded into the quorum evaluator. See cycle
// 322.3 §"Failure modes" + cycle 322.3 Cursor critic feedback
// (367476d3 finding #3) for the design rationale.
//
// The cycle 322.3.1 promotion PR will document the operator
// runbook for choosing `quorum`; until then, the policy stays at
// `block-if-any` and `blockOnReviewError` continues to drive the
// fail-closed behavior in the legacy evaluator below.
/**
 * Issue dark-factory-platform#112 — collect blocking-severity findings
 * the critic produced that should be demoted from blocks to warnings
 * under the corroboration policy. A finding is demoted when ALL of:
 *   1. It carries a flag listed in `rules.requireCorroborationFor`
 *      (mapped via `FLAG_TO_FINDING_KEY` in `report.ts`).
 *   2. No OTHER completed critic raises a blocking finding on the
 *      same file within `rules.requireCorroborationOnHunkRadius` lines.
 *
 * Findings without a flag, or with corroboration, are NOT demoted —
 * the safety net stays intact for findings the critic can defend.
 * The demoted set is populated in `sink` (mutation-free at the caller
 * boundary: the caller pre-allocates the Set).
 */
function collectDemotedFindings(
  critic: import("@momentiq/dark-factory-schemas").CriticResult,
  allResults: readonly import("@momentiq/dark-factory-schemas").CriticResult[],
  blockingSeverities: ReviewSeverity[],
  rules: import("@momentiq/dark-factory-schemas").UnilateralVetoRules,
  sink: Set<ReviewFinding>,
): void {
  for (const f of critic.findings) {
    if (!blockingSeverities.includes(f.severity)) continue;
    if (!findingCarriesCorroborationFlag(f, rules.requireCorroborationFor)) continue;
    const corroborated = isCorroboratedByOtherCritic(
      f,
      critic.criticId,
      allResults,
      blockingSeverities,
      rules.requireCorroborationOnHunkRadius,
    );
    if (!corroborated) sink.add(f);
  }
}

export function evaluateQuorumCriticResults(
  artifact: ReviewArtifact,
  blockingSeverities: ReviewSeverity[],
  quorum: number,
  blocks: GateBlock[],
  warnings: GateWarning[],
  // Issue dark-factory-platform#112 — optional unilateral-veto rules.
  // When supplied, blocking findings that carry one of the
  // configured corroboration-required flags AND are not corroborated
  // by another critic within the configured radius are demoted to
  // `critic_disagreement` warnings instead of contributing to blocks.
  unilateralVetoRules?: import("@momentiq/dark-factory-schemas").UnilateralVetoRules,
): void {
  // Surface every critic's terminal state as a warning so the
  // artifact reader sees all per-critic diagnostics even when no
  // veto fires.
  for (const result of artifact.criticResults) {
    if (result.status === "error") {
      const detail = result.error?.message ?? "critic returned error";
      warnings.push({ reason: "critic_error", criticId: result.criticId, detail });
      continue;
    }
    if (result.status === "pending" || result.status === "running") {
      warnings.push({
        reason: "critic_in_progress",
        criticId: result.criticId,
        detail: `critic status is ${result.status}`,
      });
      continue;
    }
    // Completed critic. Vetoes contribute blocks; non-veto findings
    // contribute warnings.
    //
    // Issue dark-factory-platform#112 — pre-compute the per-finding
    // demotion set under `unilateralVetoRules`. A blocking-severity
    // finding that's flagged for corroboration AND has none from
    // another critic within the configured radius gets demoted: it
    // contributes to `warnings` (as `critic_disagreement`) instead of
    // `blocks`. Findings with no flag, or with corroboration, stay on
    // the block path.
    const demoted = new Set<ReviewFinding>();
    if (unilateralVetoRules !== undefined) {
      collectDemotedFindings(
        result,
        artifact.criticResults,
        blockingSeverities,
        unilateralVetoRules,
        demoted,
      );
    }
    const ctx =
      unilateralVetoRules !== undefined
        ? {
            allResults: artifact.criticResults,
            rules: unilateralVetoRules,
          }
        : undefined;
    const vetoes = ctx
      ? criticVetoesGate(result, blockingSeverities, ctx)
      : criticVetoesGate(result, blockingSeverities);
    if (vetoes) {
      if (result.requiresHumanJudgment) {
        blocks.push({
          reason: "requires_human_judgment",
          criticId: result.criticId,
          detail: result.summary,
        });
      }
      if (result.verdict === "CHANGES_REQUESTED") {
        blocks.push({
          reason: "changes_requested",
          criticId: result.criticId,
          detail: result.summary,
        });
      }
      const blocking = result.findings.filter((f) =>
        blockingSeverities.includes(f.severity),
      );
      for (const f of blocking) {
        const detail = `${f.category}@${f.file ?? "?"}: ${f.evidence}`;
        if (demoted.has(f)) {
          warnings.push({
            reason: "critic_disagreement",
            criticId: result.criticId,
            detail,
          });
        } else {
          blocks.push({
            reason: `${f.severity}_finding`,
            criticId: result.criticId,
            detail,
          });
        }
      }
    } else {
      // Critic didn't veto — but blocking findings still need to be
      // surfaced somewhere. Under corroboration-policy demotion, they
      // become `critic_disagreement` warnings; otherwise this branch
      // does nothing (the existing semantics — non-vetoing critic's
      // blocking findings only ever surface via the `vetoes === true`
      // branch under standard quorum policy).
      if (demoted.size > 0) {
        for (const f of result.findings) {
          if (!demoted.has(f)) continue;
          const detail = `${f.category}@${f.file ?? "?"}: ${f.evidence}`;
          warnings.push({
            reason: "critic_disagreement",
            criticId: result.criticId,
            detail,
          });
        }
      }
    }
    // Non-blocking findings are always warnings regardless of vetoes.
    const nonBlocking = result.findings.filter(
      (f) => !blockingSeverities.includes(f.severity),
    );
    for (const f of nonBlocking) {
      warnings.push({
        reason: `${f.severity}_finding`,
        criticId: result.criticId,
        detail: `${f.category}@${f.file ?? "?"}: ${f.evidence}`,
      });
    }
  }

  // Quorum check. If `quorum_unmet` AND no veto blocks already
  // captured, surface a single `quorum_unmet` block. The
  // veto-preserves-quorum semantics live in `criticVetoesGate`
  // above — when a veto already blocks, `quorum_unmet` is silent
  // (the §11 invariant). When the verdict already shows a veto
  // contributed to blocks, do NOT also add `quorum_unmet` — the
  // veto is the actionable signal.
  const outcome = quorumAggregateVerdict(
    artifact.criticResults,
    blockingSeverities,
    quorum,
    unilateralVetoRules,
  );
  if (outcome.reason === "quorum_unmet" && blocks.length === 0) {
    const completed = artifact.criticResults.filter(isCriticCompleted).length;
    const total = artifact.criticResults.length;
    const erroredAdapters = artifact.criticResults
      .filter((r) => r.status === "error")
      .map((r) => `${r.criticId}=${r.error?.code ?? "(no code)"}`)
      .join(", ");
    blocks.push({
      reason: "quorum_unmet",
      detail:
        `only ${completed}/${total} critics completed; quorum is ${quorum}` +
        (erroredAdapters
          ? ` (errored: ${erroredAdapters})`
          : ""),
    });
  }
}

async function safeParent(sha: string, cwd: string): Promise<string> {
  try {
    return await commitParent(sha, cwd);
  } catch {
    return "";
  }
}

export function summarizeGate(result: GateResult): string {
  const lines: string[] = [];
  lines.push(result.blocked ? "GATE: BLOCKED" : "GATE: PASSED");
  if (result.bypass) {
    lines.push(`bypass: ${result.bypass.reason}`);
  }
  for (const b of result.blocks) {
    lines.push(`  block: [${b.reason}]${b.criticId ? ` (${b.criticId})` : ""}${b.detail ? ` ${b.detail}` : ""}`);
  }
  for (const w of result.warnings) {
    lines.push(`  warn:  [${w.reason}]${w.criticId ? ` (${w.criticId})` : ""}${w.detail ? ` ${w.detail}` : ""}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Cycle 318.2 Component 2 — Verification routes.
//
// `enforceVerificationRoutes` reads the per-SHA evidence file for the commit
// being gated, determines which routes the commit's diff triggers, applies
// exclusive-route suppression (e.g., docs-only PRs suppress production
// routes), and asserts each remaining route has an `exitCode === 0` entry
// under `gateResults[routeId]`. Missing or failing route evidence becomes
// a BLOCKER on the gate result.
//
// Pure semantics — no side effects beyond reading the per-SHA file.

export interface RouteEvaluation {
  // Routes whose triggers matched at least one changed path.
  triggered: VerificationRoute[];
  // Routes activated for enforcement (triggered ∩ NOT exclusively suppressed).
  active: VerificationRoute[];
  // The exclusive route that suppressed others, if any.
  suppressedBy?: VerificationRoute;
  // Per-route enforcement result: ok | missing | failed | skipped.
  perRoute: RouteResult[];
}

export interface RouteResult {
  routeId: string;
  status: "ok" | "missing" | "failed" | "skipped";
  exitCode?: number;
  detail: string;
}

// ---------------------------------------------------------------------------
// Cycle 21 — Evidence-Gated Validation Routes (momentiq-ai/dark-factory#184).
//
// The classifier that maps a change → required-evidence routes is a
// deterministic path-glob route TABLE (the floor). `tableArmedRoutes`
// computes that floor: the subset of the table whose `trigger` globs match
// at least one changed path.
//
// `planRoutes` adds an ADDITIVE planner seam on top of the floor. A planner
// hook may only ADD routes (e.g. for a cross-cutting change the static
// globs miss); it can NEVER remove a route the table armed. The returned
// set is the UNION (de-duplicated by id), table routes taking precedence.
//
// The monotonicity is load-bearing: an additive-only planner can only ever
// INCREASE the evidence burden, so a non-deterministic (eventually
// LLM-backed) planner can never weaken or relax the gate. The deterministic
// table is always the floor. v1 ships the table + the additive hook
// (interface + a default no-op); the full LLM planner phases in later
// behind this same additive-only contract.

/**
 * A planner hook: given the changed paths and the table-armed floor, it MAY
 * return additional routes to enforce. It can only ADD — `planRoutes`
 * unions the planner's output with the floor and never lets the planner
 * remove a table-armed route. v1's default planner is a no-op (returns []).
 */
export type RoutePlanner = (
  changedPaths: readonly string[],
  tableArmed: readonly VerificationRoute[],
) => VerificationRoute[];

/**
 * The deterministic floor: routes in `table` whose `trigger` globs match at
 * least one of `changedPaths`. Pure; no IO.
 */
export function tableArmedRoutes(
  changedPaths: readonly string[],
  table: readonly VerificationRoute[],
): VerificationRoute[] {
  const armed: VerificationRoute[] = [];
  for (const route of table) {
    if (changedPaths.some((p) => matchAnyGlob(p, route.trigger))) {
      armed.push(route);
    }
  }
  return armed;
}

/**
 * Plan the verification routes for a change: start from the deterministic
 * table floor (`tableArmedRoutes`), let the optional additive `planner`
 * append routes, and return the UNION de-duplicated by `id`.
 *
 * INVARIANT (tested in route-planner.test.ts): `tableArmed ⊆ planned` for
 * ANY planner output. The planner can only add; a table-armed route always
 * survives, and a planner re-proposing a table route does not double-count
 * it (table precedence on id collision).
 */
export function planRoutes(
  changedPaths: readonly string[],
  table: readonly VerificationRoute[],
  planner?: RoutePlanner,
): VerificationRoute[] {
  const armed = tableArmedRoutes(changedPaths, table);
  if (!planner) return armed;
  const byId = new Map<string, VerificationRoute>();
  // Table floor first so it wins on id collision — the planner cannot
  // override (or remove) a route the table armed.
  for (const r of armed) byId.set(r.id, r);
  for (const r of planner(changedPaths, armed)) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

export interface EnforceRoutesOptions {
  loaded: LoadedConfig;
  sha: string;
  changedPaths: readonly string[];
  // Cycle 21 (momentiq-ai/dark-factory#184) — optional additive planner.
  // When supplied, `enforceVerificationRoutes` enforces the PLANNED set
  // (table floor ∪ planner additions), not the raw table. Default: the
  // table floor only (v1 no-op planner).
  planner?: RoutePlanner;
  // Cycle 21 (momentiq-ai/dark-factory#186) — the diff hash of the gated
  // range. When supplied AND the per-SHA evidence carries a `diffHash`,
  // `enforceVerificationRoutes` rejects evidence whose `diffHash` does not
  // match (a route gated under a DIFFERENT diff cannot satisfy this gate).
  // Absent, or evidence without a `diffHash`, preserves SHA-only binding
  // (back-compat). The down-payment against T2 (gamed/stale evidence).
  diffHash?: string;
}

export async function enforceVerificationRoutes(
  options: EnforceRoutesOptions,
): Promise<RouteEvaluation> {
  const { loaded, sha, changedPaths } = options;
  const routes = loaded.config.validation.verificationRoutes ?? [];
  if (routes.length === 0) {
    return { triggered: [], active: [], perRoute: [] };
  }

  // Step 1 — determine triggered routes via the additive planner. The
  // planner unions the deterministic table floor with any additive
  // proposals; `tableArmed ⊆ triggered` always holds (the planner can
  // only add — momentiq-ai/dark-factory#184). With no planner this is
  // exactly the table floor, identical to the pre-Cycle-21 behavior.
  const triggered: VerificationRoute[] = planRoutes(
    changedPaths,
    routes,
    options.planner,
  );

  // Step 2 — exclusive-route suppression. The cycle-318.2 doc rule: an
  // exclusive route fires ONLY when every changed path matches its
  // trigger. When it fires, drop all non-exclusive routes. Mixed PRs
  // (e.g., docs + production paths) keep the production routes active.
  let suppressedBy: VerificationRoute | undefined;
  for (const route of triggered) {
    if (!route.exclusive) continue;
    const allMatch = changedPaths.every((p) => matchAnyGlob(p, route.trigger));
    if (allMatch) {
      suppressedBy = route;
      break;
    }
  }

  let active: VerificationRoute[];
  if (suppressedBy) {
    active = triggered.filter((r) => r === suppressedBy);
  } else {
    active = triggered.filter((r) => !r.exclusive);
  }

  // Step 3 — read per-SHA evidence and evaluate each active route.
  const evidence = await readPerShaEvidence(loaded, sha);
  const perRoute: RouteResult[] = [];

  // Cycle 21/22 (momentiq-ai/dark-factory#186 + #194) — diff-hash content
  // binding. The binding is ACTIVE iff the caller supplies the gated
  // `diffHash`. The push gate (runner.ts) always supplies it; a caller that
  // wants SHA-only binding simply omits it. When active, the per-SHA evidence
  // file MUST carry a `diffHash` that matches the gated diff:
  //   - #186 shipped the STALE check  — evidence has a `diffHash` that differs
  //     (same SHA, re-staged under a DIFFERENT diff).
  //   - #194 adds the ABSENT check    — evidence has NO `diffHash` at all.
  //     This closes the gaming hole where STRIPPING the field bypassed
  //     content-binding, and is the residual teeth of Cycle 21 EC7. It
  //     REVOKES the pre-#194 permissive behavior for SHA-only evidence: a
  //     producer that does not stamp the field can no longer satisfy a
  //     content-bound gate (adopt `df verify`, which stamps it).
  // Both collapse to one "binding unsatisfied" condition, evaluated per active
  // command route AFTER the missing-evidence check — so a route with no
  // evidence at all surfaces the precise `missing` diagnostic ("run the
  // route"), not a binding failure.
  const bindingActive = options.diffHash !== undefined;
  const diffHashUnsatisfied =
    bindingActive &&
    (evidence?.diffHash === undefined || evidence.diffHash !== options.diffHash);

  for (const route of active) {
    if (route.command === null) {
      // Suppression-only routes have no command; if they're "active"
      // (i.e., suppressedBy === route), there is nothing to enforce —
      // the suppression itself is the gate decision.
      perRoute.push({
        routeId: route.id,
        status: "skipped",
        detail: "suppression-only route (no command to enforce)",
      });
      continue;
    }
    const gateResult = evidence?.gateResults?.[route.id];
    if (!gateResult) {
      perRoute.push({
        routeId: route.id,
        status: "missing",
        detail: `no evidence at agent-reviews/quality-gates/${sha}.json for route "${route.id}"; run \`df verify --route ${route.id}\` (or the consumer's override of that command)`,
      });
      continue;
    }
    if (diffHashUnsatisfied) {
      const why =
        evidence?.diffHash === undefined
          ? "evidence carries no diffHash (SHA-only) but content-binding is required"
          : `evidence diffHash ${evidence.diffHash} != gated diff ${options.diffHash} (same SHA, different diff)`;
      perRoute.push({
        routeId: route.id,
        status: "failed",
        detail: `route "${route.id}" evidence is unbound/stale: ${why} — re-run \`df verify --route ${route.id}\` against the current diff`,
      });
      continue;
    }
    if (gateResult.exitCode !== 0) {
      perRoute.push({
        routeId: route.id,
        status: "failed",
        exitCode: gateResult.exitCode,
        detail: `route "${route.id}" command exited ${gateResult.exitCode}`,
      });
      continue;
    }
    perRoute.push({
      routeId: route.id,
      status: "ok",
      exitCode: 0,
      detail: `route "${route.id}" passed`,
    });
  }

  return {
    triggered,
    active,
    ...(suppressedBy !== undefined ? { suppressedBy } : {}),
    perRoute,
  };
}

async function readPerShaEvidence(
  loaded: LoadedConfig,
  sha: string,
): Promise<QualityGateEvidence | null> {
  const root = await resolveArtifactRoot(loaded);
  const path = perShaQualityGatePath(root, loaded.config.git.artifactDir, sha);
  if (!existsSync(path)) return null;
  let evidence: QualityGateEvidence;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    evidence = parseQualityGateEvidence(raw);
  } catch {
    return null;
  }
  // Bind the parsed `commit` field to the SHA being gated. Matches the
  // tighter read semantics in `quality-gates.ts:readEvidenceAtPath` and
  // closes the integrity gap the critic flagged: a hand-edited file at
  // `<sha>.json` that names a different commit would otherwise satisfy
  // verificationRoutes without representing the gated commit.
  if (evidence.commit !== sha) return null;
  return evidence;
}

// ---------------------------------------------------------------------------
// Cycle 318.2 Component 1 — TDD classifier wrapper that bundles diff
// extraction + trailer parsing. Pure logic lives in `tdd.ts`; this helper
// is the IO-aware glue gate-push uses.

export interface RunTddClassifierOptions {
  loaded: LoadedConfig;
  sha: string;
  cwd?: string;
}

export async function runTddClassifier(
  options: RunTddClassifierOptions,
): Promise<TddClassifierResult | null> {
  const { loaded, sha } = options;
  const cwd = options.cwd ?? loaded.repoRoot;
  if (!loaded.config.tdd) return null;

  const parent = await safeParent(sha, cwd);
  const files = await changedFiles(parent, sha, cwd, { readContent: false });
  const meta = await commitMetadata(sha, cwd);
  const fullMessage = meta.body
    ? `${meta.subject}\n\n${meta.body}`
    : meta.subject;
  const trailers = parseCommitTrailers(fullMessage);
  const classifierConfig: TddClassifierConfig = {
    productionGlobs: loaded.config.tdd.classifier.productionGlobs,
    testGlobs: loaded.config.tdd.classifier.testGlobs,
    exclusionGlobs: loaded.config.tdd.classifier.exclusionGlobs,
    justificationTrailer: loaded.config.tdd.classifier.justificationTrailer,
  };
  // Include both `path` (new) and `oldPath` (rename/copy source) so a
  // rename out of a production glob still routes through the classifier.
  // Centralized in `collectChangedPaths` (see evidence.ts).
  return classifyTddImpl(collectChangedPaths(files), trailers, classifierConfig);
}

// ---------------------------------------------------------------------------
// Cycle 318.2 Component 5 — `enforceFindingRubric` strips BLOCKER/HIGH
// findings that have none of the three concrete evidence types:
//   1. `evidencePath` referencing a per-SHA gate artifact whose
//      `gateResults[routeId]` has `exitCode !== 0`
//   2. `file` + `line` + `evidence` — a concrete code/doc location with
//      a quoted excerpt (the normal shape of an ordinary code-review
//      finding; never stripped)
//   3. `justification` from a recognized commit trailer (the human-override
//      path, e.g., `Tdd-Justification: …`)
//
// Findings of severity below the blocking threshold (medium, low, note)
// are ALWAYS kept regardless of evidence shape — the rubric only filters
// the blocking layer. This is the "evidence is data, not vibes" enforcement
// from cycle 318 §architectural-posture.
//
// Strips are logged to `<artifactDir>/_runs.ndjson` (the same NDJSON sink
// used by telemetry) so the audit trail is observable.

export interface RubricStripContext {
  loaded: LoadedConfig;
  sha: string;
  trailers: CommitTrailers;
  evidence: QualityGateEvidence | null;
}

export interface RubricResult {
  kept: ReviewFinding[];
  stripped: StrippedFinding[];
}

export interface StrippedFinding {
  finding: ReviewFinding;
  reason: string;
}

export function enforceFindingRubric(
  findings: readonly ReviewFinding[],
  context: RubricStripContext,
): RubricResult {
  const blockingSeverities = context.loaded.config.aggregation.blockingSeverities;
  const v2 = context.loaded.config.version === 2;
  const kept: ReviewFinding[] = [];
  const stripped: StrippedFinding[] = [];

  for (const f of findings) {
    // Below-threshold severities are never stripped by the rubric.
    if (!blockingSeverities.includes(f.severity)) {
      kept.push(f);
      continue;
    }
    // v1 configs keep the old behavior (no rubric enforcement) so
    // downstream repos can still use the schema. Only v2 enforces.
    if (!v2) {
      kept.push(f);
      continue;
    }

    const verdict = evaluateFindingRubric(f, context);
    if (verdict.kept) {
      kept.push(f);
    } else {
      stripped.push({ finding: f, reason: verdict.reason });
    }
  }

  if (stripped.length > 0) {
    void logRubricStrips(context, stripped);
  }

  return { kept, stripped };
}

interface RubricVerdict {
  kept: boolean;
  reason: string;
}

function evaluateFindingRubric(
  finding: ReviewFinding,
  context: RubricStripContext,
): RubricVerdict {
  // (1) Gate-failure evidence: all three of the following must hold:
  //   (a) `evidencePath` points at the canonical per-SHA artifact for
  //       the gated SHA (full or short suffix)
  //   (b) `routeId` names a specific route
  //   (c) `evidence.gateResults[routeId].exitCode !== 0`
  // Without (b)+(c), the finding could ride on any failing gate in the
  // file — closing the loopholes the 729a646c and 244464aa critics flagged.
  if (
    finding.evidencePath &&
    finding.routeId &&
    context.evidence?.gateResults
  ) {
    if (
      evidencePathMatchesSha(finding.evidencePath, context.sha) ||
      evidencePathMatchesSha(finding.evidencePath, context.sha.slice(0, 12))
    ) {
      const namedRoute = context.evidence.gateResults[finding.routeId];
      if (namedRoute && namedRoute.exitCode !== 0) {
        return {
          kept: true,
          reason: `evidencePath+routeId bound to ${context.sha.slice(0, 12)}; gateResults["${finding.routeId}"].exitCode=${namedRoute.exitCode}`,
        };
      }
    }
  }

  // (2) File + line + evidence — the spec-defined shape of an ordinary
  // code-review finding (cycle 318.2 §Component 5 + §Exit Criteria). All
  // three are required: file (already required by the schema parser for
  // blocker severities), a concrete line number, and an evidence string.
  // Findings that name a location without pointing at a specific line
  // fall back to evidence_path or justification — this is what keeps the
  // prompt rubric and harness rubric in lock-step (closes the spec drift
  // the local critic flagged on 71c5b3c7).
  if (
    finding.file &&
    finding.file.trim().length > 0 &&
    finding.line !== undefined &&
    finding.evidence.trim().length > 0
  ) {
    return { kept: true, reason: "file+line+evidence (code-review finding shape)" };
  }

  // (3) Per-finding `justification` — the critic must populate this
  // with the VALUE of a recognized commit trailer (Tdd-Justification,
  // Evidence, Migration-Justification, or the config's
  // `tdd.classifier.justificationTrailer`). The rubric verifies the
  // value actually appears in `context.trailers`, so the critic can't
  // invent a free-form justification string — there has to be a real
  // human-supplied trailer behind it. Closes the loophole the 67b9ecd7
  // critic flagged.
  if (finding.justification && finding.justification.trim().length > 0) {
    const recognizedTrailers = new Set<string>([
      "tdd-justification",
      "evidence",
      "migration-justification",
    ]);
    const customTrailer = context.loaded.config.tdd?.classifier.justificationTrailer;
    if (customTrailer) recognizedTrailers.add(customTrailer.toLowerCase());
    const justification = finding.justification.trim();
    for (const key of recognizedTrailers) {
      const value = context.trailers.trailers[key];
      if (value && value.trim() === justification) {
        return {
          kept: true,
          reason: `per-finding justification matches commit trailer ${key}`,
        };
      }
    }
    // Justification text present but does NOT match any recognized
    // trailer value — fall through to the strip path. The critic
    // attached prose but no auditable human override is on the commit.
  }

  return {
    kept: false,
    reason: "no evidencePath+routeId matching gate failure, no file+line+evidence, no per-finding justification backed by a recognized commit trailer",
  };
}

// Does the finding's `evidencePath` string anchor to the gated SHA?
// We accept three shapes:
//   - exact suffix `<sha>.json` (full sha)
//   - exact suffix `<short-sha>.json` (when caller passes a 12-char prefix)
//   - the path is a substring containing the sha — guards against a critic
//     that writes a fully-qualified absolute path
// The check is intentionally generous on path separators (Windows-style
// or slash-mixed) but strict on the SHA itself.
function evidencePathMatchesSha(evidencePath: string, sha: string): boolean {
  if (!sha) return false;
  const needle = `${sha}.json`;
  // Allow both forward and back slashes in the path; the path may be
  // relative ("agent-reviews/quality-gates/<sha>.json") or absolute.
  return evidencePath.includes(needle);
}

async function logRubricStrips(
  context: RubricStripContext,
  stripped: StrippedFinding[],
): Promise<void> {
  try {
    const dir = await resolveArtifactDir(context.loaded);
    mkdirSync(dir, { recursive: true });
    const path = telemetryPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    for (const s of stripped) {
      const event = {
        ts: new Date().toISOString(),
        event: "rubric_strip",
        commit: context.sha,
        severity: s.finding.severity,
        category: s.finding.category,
        file: s.finding.file ?? null,
        line: s.finding.line ?? null,
        reason: s.reason,
        manifesto_section: s.finding.manifestoSection ?? null,
      };
      appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    }
  } catch {
    // Telemetry writes are best-effort; do not fail the gate because
    // we couldn't log a strip event.
  }
}

// Helper for tests / CLI: build a `RubricStripContext` from a SHA. Reads
// commit message + per-SHA evidence; safe to call when either is absent.
export interface BuildRubricContextOptions {
  loaded: LoadedConfig;
  sha: string;
  cwd?: string;
}

export async function buildRubricContext(
  options: BuildRubricContextOptions,
): Promise<RubricStripContext> {
  const { loaded, sha } = options;
  const cwd = options.cwd ?? loaded.repoRoot;
  const meta = await commitMetadata(sha, cwd);
  const fullMessage = meta.body
    ? `${meta.subject}\n\n${meta.body}`
    : meta.subject;
  const trailers = parseCommitTrailers(fullMessage);
  const evidence = await readPerShaEvidence(loaded, sha);
  return { loaded, sha, trailers, evidence };
}

// Re-export the per-SHA path helper from `evidence.ts` so callers can
// import a single boundary — this matches the cycle-318.2 doc's mental
// model of `gate.ts` as the canonical surface for gate-time decisions.
export { perShaQualityGatePath, parseCommitTrailers };
// Keep `resolve` referenced so bundlers don't strip it from the runtime
// import — some downstream tooling depends on this module re-exporting
// the same node:path helpers as the previous version.
void resolve;
