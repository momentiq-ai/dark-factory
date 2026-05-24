// Service #6 — Merge Queue Admission Policy (Phase D boundary).
//
// Two responsibilities, each extracted from a distinct sage3c source:
//
// 1) `ruleset-shape` — the TypeScript contract for the GitHub Repository
//    Ruleset rules that codify Dark Factory's merge-queue admission
//    posture: which checks must be green, what the merge-queue strategy
//    is, where the CE-bypass lane lives. Mirrors the shape that
//    sage3c's `audit_branch_protection.py` compares against (Service
//    #7 — already shipped in Phase C). This file declares the contract
//    so consumers can author / validate their own `spec.yaml` without
//    re-implementing the rule shapes from scratch.
//
// 2) `plan-vs-code router` — the heuristic that classifies a PR as
//    `plan` (cycle-doc-only) vs `code` (touches anything outside
//    `docs/`). Ported from sage3c's `.github/workflows/plan-pr-review-gate.yml`
//    lines 117-134. Drives the stricter-gate-for-plan-PRs rule that
//    forces CE-in-the-loop on the highest-leverage artifacts.
//
// What this file deliberately does NOT do:
//
//   * Compare a spec against a live ruleset — that's Service #7
//     (`audit_branch_protection.py` in `branch-protection/`).
//   * Classify trivial-vs-substantive issues — that's the Cerebe-
//     backed tier classifier (`scripts/ci/tier_classifier.py`), a
//     separate service not in scope for 331.1.
//   * Enforce committer identity (the AI-Agentic-Engineer authorship
//     gate, `scripts/ci/check_agentic_engineer_authorship.py`) — also
//     a separate service.
//
// Sources:
//   sage3c/.github/rulesets/main.json
//   sage3c/.github/rulesets/main-ce-review.json
//   sage3c/.github/workflows/plan-pr-review-gate.yml
//   sage3c/scripts/ci/audit_branch_protection.py (for the rule shapes
//     this file declares; the comparator stays in branch-protection/)
//
// Ratified design references:
//   docs/roadmap/cycles/cycle322-dark-factory-chief-engineer-merge-bypass.md
//   docs/roadmap/cycles/cycle322.4-...md (CE bypass lane two-ruleset arch)
//   docs/roadmap/cycles/cycle331.1-extract-from-sage3c.md § Phase D

// PR classification — the policy boundary's two-value result. Used
// by the plan-PR review gate and the (Phase E) reusable-workflow
// router. Lives in this module rather than under `adapters/` because
// it's a policy-layer concept, not a critic-vendor concept.
export type PrKind = "plan" | "code";

/** Minimal shape of a GitHub PR file entry — enough for the classifier. */
export interface PrFile {
  path: string;
}

// ---------------------------------------------------------------------------
// Plan-vs-code PR classifier
//
// Ported from `.github/workflows/plan-pr-review-gate.yml` (cycle 322.4).
// The workflow's bash equivalent is:
//
//   PLAN_FILES = (count files matching docs/roadmap/cycles/cycle*.md
//                directly under cycles/)
//   NON_DOC_FILES = (count files NOT under docs/)
//   if PLAN_FILES > 0 and NON_DOC_FILES == 0:
//     kind = "plan"
//   else:
//     kind = "code"
//
// The classifier matches the bash regex `^docs/roadmap/cycles/cycle[0-9.]+-?[a-z0-9-]*\.md$`.
// Files under `cycle*-evidence/` deliberately classify as `code` —
// they're operational artifacts, not plans, even though they sit
// under `docs/roadmap/cycles/`.
// ---------------------------------------------------------------------------

export const PR_DOC_ROOT = "docs/";

// Direct match for a top-level cycle doc: `docs/roadmap/cycles/cycleN[.M[.K]]-slug.md`.
// Examples (match):
//   docs/roadmap/cycles/cycle331-dark-factory-platformization.md
//   docs/roadmap/cycles/cycle322.4-foo-bar.md
//   docs/roadmap/cycles/cycle1.md
// Examples (no match — these classify as code):
//   docs/roadmap/cycles/cycle322-evidence/some-artifact.md
//   docs/roadmap/cycles/cycle322/nested.md
export const PR_PLAN_DOC_PATTERN = /^docs\/roadmap\/cycles\/cycle[0-9.]+-?[a-z0-9-]*\.md$/;

/**
 * A pure-function classifier — takes a list of file paths from a PR's diff.
 *
 * Faithful byte-for-byte port of the bash regex in sage3c's
 * `plan-pr-review-gate.yml` (cycle 322.4). One known quirk preserved
 * from that source: the workflow's accompanying CLAUDE.md comment
 * says "Files under `cycle*-evidence/` are operational artifacts,
 * not plans; they classify as `code`" — but the bash regex anchors
 * the non-doc count on the `docs/` prefix, so a cycle-doc + sibling
 * `cycle*-evidence/snapshot.md` (both inside `docs/`) still returns
 * `plan`. This port preserves the bash behavior, not the comment's
 * stated intent — fixing the gap is sage3c's call, not the extracted
 * CLI's. See `tests/policy/merge-queue.test.ts` for the pinned
 * regression test.
 */
export function classifyPrKindFromFiles(filePaths: readonly string[]): PrKind {
  let planFiles = 0;
  let nonDocFiles = 0;
  for (const path of filePaths) {
    if (PR_PLAN_DOC_PATTERN.test(path)) {
      planFiles++;
    }
    if (!path.startsWith(PR_DOC_ROOT)) {
      nonDocFiles++;
    }
  }
  if (planFiles > 0 && nonDocFiles === 0) return "plan";
  return "code";
}

/** Convenience wrapper for the typed adapter shape (`PrFile`). */
export function classifyPrKind(files: readonly PrFile[]): PrKind {
  return classifyPrKindFromFiles(files.map((f) => f.path));
}

// ---------------------------------------------------------------------------
// Chief-Engineer identity resolution
//
// The plan-PR gate has two branches: CE-self-skip (CE authored the
// plan PR) vs. require-CE-APPROVED (non-CE author needs CE review).
// CE identity lives at `.github/agentic-engineers.json` on the
// PROTECTED BASE REF — never PR head — so a malicious PR cannot
// elevate its author to CE just for the duration of one PR.
//
// This helper takes a parsed JSON blob (the registry) and returns
// the CE login or null. The base-ref FETCH is the caller's job (the
// CLI subcommand wraps that via `gh api`; the unit tests pass a
// literal object). The resolver itself stays pure.
// ---------------------------------------------------------------------------

export interface AgenticEngineerRegistry {
  chief_engineer?: {
    github_login?: string | null;
  } | null;
}

/**
 * Extract the Chief Engineer's GitHub login from a parsed agentic-engineers
 * registry. Returns null on any deviation from the expected shape so the
 * caller can fail closed without a try/catch storm.
 */
export function resolveChiefEngineerLogin(
  registry: AgenticEngineerRegistry | null | undefined,
): string | null {
  if (!registry || typeof registry !== "object") return null;
  const ce = registry.chief_engineer;
  if (!ce || typeof ce !== "object") return null;
  const login = ce.github_login;
  if (typeof login !== "string") return null;
  const trimmed = login.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Plan-PR review gate evaluator
//
// Pure function: given the PR's classification, author login, CE
// login, and the PR's review history, decide whether the PR can be
// admitted. Mirrors the bash logic in plan-pr-review-gate.yml lines
// 136-340 (the "fail-closed" path, the "CE-self-skip" path, and the
// "require CE APPROVED on current head SHA" path).
// ---------------------------------------------------------------------------

export interface PlanPrReview {
  /** The reviewer's GitHub login. */
  userLogin: string;
  /** The PR SHA the review was submitted against. Reviews on stale SHAs are ignored (dismiss_stale_reviews_on_push semantics). */
  commitId: string;
  /** Submission timestamp (ISO 8601 or epoch ms — caller can choose; comparator is `>`). */
  submittedAt: string | number;
  /** GitHub review state. COMMENTED is excluded from latest-wins to preserve a prior APPROVED. */
  state: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "COMMENTED" | "PENDING";
}

export interface PlanPrGateInputs {
  /** Output of `classifyPrKind` over the PR's files. */
  kind: PrKind;
  /** PR author login (`pull_request.user.login`). */
  prAuthorLogin: string;
  /** The Chief Engineer's login, resolved from the base-ref registry. */
  chiefEngineerLogin: string | null;
  /** Current PR head SHA. The CE-APPROVED filter requires the review to be on this SHA. */
  prHeadSha: string;
  /** Every review submitted against the PR. */
  reviews: readonly PlanPrReview[];
}

export type PlanPrGateVerdict =
  | { admit: true; reason: "code_pr_not_applicable" | "ce_self_skip" | "ce_approved_on_head" }
  | {
      admit: false;
      reason:
        | "missing_chief_engineer_login"
        | "no_ce_review_on_head"
        | "ce_review_requested_changes"
        | "ce_dismissed_or_pending";
      detail: string;
    };

/**
 * Pure evaluator for the plan-PR review gate.
 *
 * Returns `admit: true` for:
 *  - code PRs (gate not applicable),
 *  - CE-authored plan PRs (architect-loop is the review),
 *  - non-CE plan PRs where the CE has APPROVED on the current head SHA.
 *
 * Returns `admit: false` for:
 *  - missing CE identity in the registry (fail-closed),
 *  - non-CE plan PR with no CE review on the current head SHA,
 *  - non-CE plan PR with a CHANGES_REQUESTED CE review on the current head SHA,
 *  - non-CE plan PR with the CE's latest review on the current head SHA being DISMISSED/PENDING.
 */
export function evaluatePlanPrReviewGate(inputs: PlanPrGateInputs): PlanPrGateVerdict {
  if (inputs.kind === "code") {
    return { admit: true, reason: "code_pr_not_applicable" };
  }
  if (!inputs.chiefEngineerLogin) {
    return {
      admit: false,
      reason: "missing_chief_engineer_login",
      detail:
        "Could not resolve `chief_engineer.github_login` from `.github/agentic-engineers.json` " +
        "on the base ref. Without a CE identity, the gate cannot route plan PRs.",
    };
  }
  if (inputs.prAuthorLogin === inputs.chiefEngineerLogin) {
    return { admit: true, reason: "ce_self_skip" };
  }

  // Find the CE's latest non-COMMENTED review on the current head SHA.
  // COMMENTED is excluded so a CE follow-up note doesn't dismiss a prior APPROVED.
  const ceHeadReviews = inputs.reviews.filter(
    (r) =>
      r.userLogin === inputs.chiefEngineerLogin &&
      r.commitId === inputs.prHeadSha &&
      r.state !== "COMMENTED",
  );
  if (ceHeadReviews.length === 0) {
    return {
      admit: false,
      reason: "no_ce_review_on_head",
      detail: `No Chief Engineer review found on head SHA ${inputs.prHeadSha} by ${inputs.chiefEngineerLogin}.`,
    };
  }
  ceHeadReviews.sort((a, b) => compareSubmittedAt(a.submittedAt, b.submittedAt));
  const latest = ceHeadReviews[ceHeadReviews.length - 1];
  if (!latest) {
    // Unreachable — guarded by length check above, but TS narrows array[N] to T | undefined.
    return {
      admit: false,
      reason: "no_ce_review_on_head",
      detail: `No Chief Engineer review found on head SHA ${inputs.prHeadSha}.`,
    };
  }
  if (latest.state === "APPROVED") {
    return { admit: true, reason: "ce_approved_on_head" };
  }
  if (latest.state === "CHANGES_REQUESTED") {
    return {
      admit: false,
      reason: "ce_review_requested_changes",
      detail: `Chief Engineer ${inputs.chiefEngineerLogin} requested changes on head SHA ${inputs.prHeadSha}.`,
    };
  }
  return {
    admit: false,
    reason: "ce_dismissed_or_pending",
    detail: `Chief Engineer ${inputs.chiefEngineerLogin}'s latest review on head SHA ${inputs.prHeadSha} is in state ${latest.state}.`,
  };
}

function compareSubmittedAt(a: string | number, b: string | number): number {
  const an = toMs(a);
  const bn = toMs(b);
  return an - bn;
}

function toMs(t: string | number): number {
  if (typeof t === "number") return t;
  const n = Date.parse(t);
  // Treat NaN (unparseable) as 0 so it sorts deterministically before
  // any real timestamp — never throws on user-supplied review data.
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Ruleset shape exports
//
// TypeScript contracts for the GitHub Repository Ruleset rules Dark
// Factory consumers declare. These mirror the live shape of sage3c's
// `.github/rulesets/main.json` (Ruleset A) and `main-ce-review.json`
// (Ruleset B). They exist as a typed surface so consumers can author
// their own ruleset files without copy-pasting JSON.
//
// The comparator (drift detector) is Service #7 and lives in
// `branch-protection/`. This file only declares the contract.
// ---------------------------------------------------------------------------

export interface MergeQueueRule {
  type: "merge_queue";
  parameters: {
    merge_method: "MERGE" | "SQUASH" | "REBASE";
    max_entries_to_build: number;
    min_entries_to_merge: number;
    max_entries_to_merge: number;
    min_entries_to_merge_wait_minutes: number;
    grouping_strategy: "ALLGREEN" | "HEADGREEN";
    check_response_timeout_minutes: number;
  };
}

export interface PullRequestRule {
  type: "pull_request";
  parameters: {
    required_approving_review_count: number;
    dismiss_stale_reviews_on_push: boolean;
    required_reviewers: readonly string[];
    require_code_owner_review: boolean;
    require_last_push_approval: boolean;
    required_review_thread_resolution: boolean;
    allowed_merge_methods: readonly ("merge" | "squash" | "rebase")[];
  };
}

export interface RequiredStatusChecksRule {
  type: "required_status_checks";
  parameters: {
    strict_required_status_checks_policy: boolean;
    do_not_enforce_on_create: boolean;
    required_status_checks: readonly { context: string; integration_id?: number }[];
  };
}

export interface CopilotCodeReviewRule {
  type: "copilot_code_review";
  parameters: {
    review_on_push: boolean;
    review_draft_pull_requests: boolean;
  };
}

export interface DeletionRule {
  type: "deletion";
}

export interface NonFastForwardRule {
  type: "non_fast_forward";
}

export interface RequiredLinearHistoryRule {
  type: "required_linear_history";
}

export type RulesetRule =
  | DeletionRule
  | NonFastForwardRule
  | RequiredLinearHistoryRule
  | PullRequestRule
  | RequiredStatusChecksRule
  | CopilotCodeReviewRule
  | MergeQueueRule;

export interface BypassActor {
  actor_id: number | null;
  actor_type: "Team" | "RepositoryRole" | "Integration" | "OrganizationAdmin";
  bypass_mode: "always" | "pull_request";
}

export interface RulesetShape {
  name: string;
  target: "branch" | "tag";
  source_type: "Repository" | "Organization";
  source: string;
  enforcement: "active" | "evaluate" | "disabled";
  bypass_actors: readonly BypassActor[];
  conditions: {
    ref_name: {
      include: readonly string[];
      exclude: readonly string[];
    };
  };
  rules: readonly RulesetRule[];
}

/**
 * Reference merge-queue rule mirroring sage3c's current `main1` posture
 * (cycle 322.4): SQUASH, ALLGREEN, batch up to 5, 60-min check timeout.
 * Consumers can spread + override:
 *   { ...defaultMergeQueueRule(), parameters: { ...defaultMergeQueueRule().parameters, merge_method: "REBASE" } }
 */
export function defaultMergeQueueRule(): MergeQueueRule {
  return {
    type: "merge_queue",
    parameters: {
      merge_method: "SQUASH",
      max_entries_to_build: 5,
      min_entries_to_merge: 1,
      max_entries_to_merge: 5,
      min_entries_to_merge_wait_minutes: 0,
      grouping_strategy: "ALLGREEN",
      check_response_timeout_minutes: 60,
    },
  };
}

/**
 * Reference Ruleset A (the merge-queue + required-checks ruleset)
 * mirroring sage3c's `main1`. Consumers seed from this then layer
 * their own contexts.
 */
export function defaultMainRulesetShape(
  source: string,
  options: { additionalRequiredContexts?: readonly string[] } = {},
): RulesetShape {
  const ctxs = (options.additionalRequiredContexts ?? []).map((context) => ({ context }));
  return {
    name: "main1",
    target: "branch",
    source_type: "Repository",
    source,
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: { include: ["refs/heads/main"], exclude: [] },
    },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          required_reviewers: [],
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ["merge", "squash", "rebase"],
        },
      },
      { type: "required_linear_history" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: ctxs,
        },
      },
      defaultMergeQueueRule(),
    ],
  };
}

/**
 * Reference Ruleset B (the CE-bypass review ruleset) mirroring
 * sage3c's `main-ce-review`. Consumers seed from this and replace
 * the `bypass_actors[0]` team id with their own CE team's id.
 *
 * The two-ruleset architecture (cycle 322.4): Ruleset A holds the
 * required checks the CE should NOT be able to bypass; Ruleset B
 * holds the human-review rule the CE bypasses. Required because
 * `bypass_mode` is RULESET-scope, not rule-scope.
 */
export function defaultCeReviewRulesetShape(
  source: string,
  options: { chiefEngineerTeamId?: number | null; chiefEngineerTeamSlug?: string } = {},
): RulesetShape {
  return {
    name: "main-ce-review",
    target: "branch",
    source_type: "Repository",
    source,
    enforcement: "active",
    bypass_actors: [
      {
        actor_id: options.chiefEngineerTeamId ?? null,
        actor_type: "Team",
        bypass_mode: "pull_request",
      },
    ],
    conditions: {
      ref_name: { include: ["refs/heads/main"], exclude: [] },
    },
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          required_reviewers: [],
          require_code_owner_review: true,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["merge", "squash", "rebase"],
        },
      },
    ],
  };
}
