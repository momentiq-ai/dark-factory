// Service #6 boundary test — plan-vs-code PR classifier + plan-PR
// review gate evaluator + ruleset-shape exports.
//
// Mirrors the bash logic in sage3c/.github/workflows/plan-pr-review-gate.yml
// (cycle 322.4) so a port-equivalence regression here would surface
// before the Phase E reusable workflow ships.

import { describe, expect, it } from "vitest";

import {
  PR_PLAN_DOC_PATTERN,
  classifyPrKind,
  classifyPrKindFromFiles,
  defaultCeReviewRulesetShape,
  defaultMainRulesetShape,
  defaultMergeQueueRule,
  evaluatePlanPrReviewGate,
  resolveChiefEngineerLogin,
  type PlanPrReview,
} from "../../src/policy/merge-queue.js";

// Mirror the top-level barrel test — anything we export should be
// reachable through `../src/index.ts` for the npm-published consumer
// import path.
import {
  classifyPrKindFromFiles as fromBarrel,
  defaultMergeQueueRule as defaultMqFromBarrel,
} from "../../src/index.js";

describe("PR_PLAN_DOC_PATTERN — direct regex behavior", () => {
  it("matches a top-level numeric cycle doc", () => {
    expect(PR_PLAN_DOC_PATTERN.test("docs/roadmap/cycles/cycle331.md")).toBe(true);
    expect(PR_PLAN_DOC_PATTERN.test("docs/roadmap/cycles/cycle1.md")).toBe(true);
  });

  it("matches a sub-cycle doc (cycleN.M)", () => {
    expect(PR_PLAN_DOC_PATTERN.test("docs/roadmap/cycles/cycle331.1.md")).toBe(true);
    expect(
      PR_PLAN_DOC_PATTERN.test("docs/roadmap/cycles/cycle331.1-extract-from-sage3c.md"),
    ).toBe(true);
  });

  it("matches a sub-sub-cycle doc (cycleN.M.K)", () => {
    expect(PR_PLAN_DOC_PATTERN.test("docs/roadmap/cycles/cycle322.7.1.md")).toBe(true);
  });

  it("does NOT match files under cycle*-evidence/", () => {
    expect(
      PR_PLAN_DOC_PATTERN.test("docs/roadmap/cycles/cycle322-evidence/snapshot.md"),
    ).toBe(false);
  });

  it("does NOT match nested cycle dirs", () => {
    expect(PR_PLAN_DOC_PATTERN.test("docs/roadmap/cycles/cycle322/nested.md")).toBe(false);
  });

  it("does NOT match unrelated docs", () => {
    expect(PR_PLAN_DOC_PATTERN.test("docs/architecture/something.md")).toBe(false);
    expect(PR_PLAN_DOC_PATTERN.test("README.md")).toBe(false);
  });
});

describe("classifyPrKindFromFiles — plan vs code router", () => {
  it("classifies a pure cycle-doc PR as plan", () => {
    expect(
      classifyPrKindFromFiles([
        "docs/roadmap/cycles/cycle331-dark-factory-platformization.md",
      ]),
    ).toBe("plan");
  });

  it("classifies multiple cycle docs (no code) as plan", () => {
    expect(
      classifyPrKindFromFiles([
        "docs/roadmap/cycles/cycle331.md",
        "docs/roadmap/cycles/cycle331.1.md",
      ]),
    ).toBe("plan");
  });

  it("classifies cycle doc + sibling docs file as plan (still all under docs/)", () => {
    expect(
      classifyPrKindFromFiles([
        "docs/roadmap/cycles/cycle331.md",
        "docs/architecture/something.md",
      ]),
    ).toBe("plan");
  });

  it("classifies cycle doc + code as code", () => {
    expect(
      classifyPrKindFromFiles([
        "docs/roadmap/cycles/cycle331.md",
        "packages/cli/src/cli.ts",
      ]),
    ).toBe("code");
  });

  it("classifies docs-only-but-no-cycle-doc as code (no plan files)", () => {
    expect(
      classifyPrKindFromFiles([
        "docs/architecture/something.md",
        "docs/guides/another.md",
      ]),
    ).toBe("code");
  });

  it("cycle-evidence + cycle-doc both under docs/ classifies as plan (regex quirk preserved from sage3c bash)", () => {
    // Faithful port of the bash regex in
    // sage3c/.github/workflows/plan-pr-review-gate.yml. The
    // CLAUDE.md comment on that workflow says "Files under
    // `cycle*-evidence/` are operational artifacts, not plans; they
    // classify as `code`" — but the actual bash regex anchors only on
    // the `docs/` prefix for the non-doc count. Since cycle*-evidence
    // sits inside docs/, plan_files=1 (the cycle-doc) AND
    // non_doc_files=0, so the classifier returns `plan`.
    //
    // This is a preserved-but-quirky behavior, not a Phase-D
    // regression. Tracked as a pre-existing gap; correcting it (if we
    // ever do) is sage3c's call, not the extracted CLI's.
    expect(
      classifyPrKindFromFiles([
        "docs/roadmap/cycles/cycle331.md",
        "docs/roadmap/cycles/cycle331-evidence/snapshot.md",
      ]),
    ).toBe("plan");
  });

  it("classifies empty file list as code (no plan files match)", () => {
    expect(classifyPrKindFromFiles([])).toBe("code");
  });
});

describe("classifyPrKind — convenience wrapper for typed PrFile arrays", () => {
  it("accepts {path} objects", () => {
    expect(
      classifyPrKind([{ path: "docs/roadmap/cycles/cycle331.md" }]),
    ).toBe("plan");
    expect(
      classifyPrKind([
        { path: "docs/roadmap/cycles/cycle331.md" },
        { path: "packages/cli/src/cli.ts" },
      ]),
    ).toBe("code");
  });
});

describe("resolveChiefEngineerLogin", () => {
  it("extracts a valid login", () => {
    expect(resolveChiefEngineerLogin({ chief_engineer: { github_login: "alien8d" } })).toBe(
      "alien8d",
    );
  });

  it("returns null for missing registry", () => {
    expect(resolveChiefEngineerLogin(null)).toBeNull();
    expect(resolveChiefEngineerLogin(undefined)).toBeNull();
  });

  it("returns null for missing chief_engineer", () => {
    expect(resolveChiefEngineerLogin({})).toBeNull();
    expect(resolveChiefEngineerLogin({ chief_engineer: null })).toBeNull();
  });

  it("returns null for missing github_login", () => {
    expect(resolveChiefEngineerLogin({ chief_engineer: {} })).toBeNull();
    expect(
      resolveChiefEngineerLogin({ chief_engineer: { github_login: null } }),
    ).toBeNull();
  });

  it("rejects non-string github_login", () => {
    // Type cast for the test — runtime hardening against schema drift.
    expect(
      resolveChiefEngineerLogin({
        chief_engineer: { github_login: 42 as unknown as string },
      }),
    ).toBeNull();
  });

  it("trims whitespace and rejects empty strings", () => {
    expect(
      resolveChiefEngineerLogin({ chief_engineer: { github_login: "  alien8d  " } }),
    ).toBe("alien8d");
    expect(
      resolveChiefEngineerLogin({ chief_engineer: { github_login: "   " } }),
    ).toBeNull();
  });
});

describe("evaluatePlanPrReviewGate — admission verdict", () => {
  const baseInputs = {
    chiefEngineerLogin: "alien8d",
    prHeadSha: "abc123",
    reviews: [] as readonly PlanPrReview[],
  };

  it("code PRs are not in scope (admit: true, code_pr_not_applicable)", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "code",
      prAuthorLogin: "anyone",
    });
    expect(v).toEqual({ admit: true, reason: "code_pr_not_applicable" });
  });

  it("missing chief_engineer login → fail-closed", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "plan",
      chiefEngineerLogin: null,
      prAuthorLogin: "anyone",
    });
    expect(v.admit).toBe(false);
    if (!v.admit) {
      expect(v.reason).toBe("missing_chief_engineer_login");
    }
  });

  it("CE-authored plan PR → ce_self_skip", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "plan",
      prAuthorLogin: "alien8d",
    });
    expect(v).toEqual({ admit: true, reason: "ce_self_skip" });
  });

  it("non-CE plan PR with no CE review → no_ce_review_on_head", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "plan",
      prAuthorLogin: "lyra-bot",
      reviews: [],
    });
    expect(v.admit).toBe(false);
    if (!v.admit) {
      expect(v.reason).toBe("no_ce_review_on_head");
    }
  });

  it("non-CE plan PR with CE APPROVED on head → admit", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "plan",
      prAuthorLogin: "lyra-bot",
      reviews: [
        {
          userLogin: "alien8d",
          commitId: "abc123",
          submittedAt: "2026-05-23T10:00:00Z",
          state: "APPROVED",
        },
      ],
    });
    expect(v).toEqual({ admit: true, reason: "ce_approved_on_head" });
  });

  it("ignores CE APPROVED on stale SHA", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "plan",
      prAuthorLogin: "lyra-bot",
      reviews: [
        {
          userLogin: "alien8d",
          commitId: "STALE",
          submittedAt: "2026-05-23T10:00:00Z",
          state: "APPROVED",
        },
      ],
    });
    expect(v.admit).toBe(false);
    if (!v.admit) {
      expect(v.reason).toBe("no_ce_review_on_head");
    }
  });

  it("treats CE CHANGES_REQUESTED as blocking", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "plan",
      prAuthorLogin: "lyra-bot",
      reviews: [
        {
          userLogin: "alien8d",
          commitId: "abc123",
          submittedAt: "2026-05-23T10:00:00Z",
          state: "CHANGES_REQUESTED",
        },
      ],
    });
    expect(v.admit).toBe(false);
    if (!v.admit) {
      expect(v.reason).toBe("ce_review_requested_changes");
    }
  });

  it("latest non-COMMENTED review wins (latest is APPROVED → admit)", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "plan",
      prAuthorLogin: "lyra-bot",
      reviews: [
        {
          userLogin: "alien8d",
          commitId: "abc123",
          submittedAt: "2026-05-23T09:00:00Z",
          state: "CHANGES_REQUESTED",
        },
        {
          userLogin: "alien8d",
          commitId: "abc123",
          submittedAt: "2026-05-23T10:00:00Z",
          state: "APPROVED",
        },
      ],
    });
    expect(v).toEqual({ admit: true, reason: "ce_approved_on_head" });
  });

  it("latest non-COMMENTED review wins (latest is CHANGES_REQUESTED → block)", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "plan",
      prAuthorLogin: "lyra-bot",
      reviews: [
        {
          userLogin: "alien8d",
          commitId: "abc123",
          submittedAt: "2026-05-23T09:00:00Z",
          state: "APPROVED",
        },
        {
          userLogin: "alien8d",
          commitId: "abc123",
          submittedAt: "2026-05-23T10:00:00Z",
          state: "CHANGES_REQUESTED",
        },
      ],
    });
    expect(v.admit).toBe(false);
    if (!v.admit) {
      expect(v.reason).toBe("ce_review_requested_changes");
    }
  });

  it("COMMENTED review does NOT dismiss a prior APPROVED", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "plan",
      prAuthorLogin: "lyra-bot",
      reviews: [
        {
          userLogin: "alien8d",
          commitId: "abc123",
          submittedAt: "2026-05-23T09:00:00Z",
          state: "APPROVED",
        },
        {
          userLogin: "alien8d",
          commitId: "abc123",
          submittedAt: "2026-05-23T10:00:00Z",
          state: "COMMENTED",
        },
      ],
    });
    expect(v).toEqual({ admit: true, reason: "ce_approved_on_head" });
  });

  it("ignores reviews by non-CE actors", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "plan",
      prAuthorLogin: "lyra-bot",
      reviews: [
        {
          userLogin: "someone-else",
          commitId: "abc123",
          submittedAt: "2026-05-23T10:00:00Z",
          state: "APPROVED",
        },
      ],
    });
    expect(v.admit).toBe(false);
    if (!v.admit) {
      expect(v.reason).toBe("no_ce_review_on_head");
    }
  });

  it("handles epoch-ms timestamps interchangeably", () => {
    const v = evaluatePlanPrReviewGate({
      ...baseInputs,
      kind: "plan",
      prAuthorLogin: "lyra-bot",
      reviews: [
        {
          userLogin: "alien8d",
          commitId: "abc123",
          submittedAt: 1000,
          state: "CHANGES_REQUESTED",
        },
        {
          userLogin: "alien8d",
          commitId: "abc123",
          submittedAt: 2000,
          state: "APPROVED",
        },
      ],
    });
    expect(v).toEqual({ admit: true, reason: "ce_approved_on_head" });
  });
});

describe("defaultMergeQueueRule — ruleset shape", () => {
  it("matches sage3c's main1 merge-queue posture (cycle 322.4)", () => {
    const r = defaultMergeQueueRule();
    expect(r.type).toBe("merge_queue");
    expect(r.parameters.merge_method).toBe("SQUASH");
    expect(r.parameters.grouping_strategy).toBe("ALLGREEN");
    expect(r.parameters.max_entries_to_build).toBe(5);
    expect(r.parameters.check_response_timeout_minutes).toBe(60);
  });

  it("returns a fresh object each call (caller may mutate without poisoning shared state)", () => {
    const a = defaultMergeQueueRule();
    const b = defaultMergeQueueRule();
    expect(a).not.toBe(b);
    expect(a.parameters).not.toBe(b.parameters);
  });
});

describe("defaultMainRulesetShape — Ruleset A reference", () => {
  it("targets main and is enforced", () => {
    const r = defaultMainRulesetShape("momentiq-ai/scratch");
    expect(r.name).toBe("main1");
    expect(r.target).toBe("branch");
    expect(r.enforcement).toBe("active");
    expect(r.conditions.ref_name.include).toEqual(["refs/heads/main"]);
  });

  it("includes deletion, non_fast_forward, required_linear_history, pull_request, required_status_checks, merge_queue rules", () => {
    const r = defaultMainRulesetShape("momentiq-ai/scratch");
    const types = new Set(r.rules.map((rr) => rr.type));
    expect(types.has("deletion")).toBe(true);
    expect(types.has("non_fast_forward")).toBe(true);
    expect(types.has("required_linear_history")).toBe(true);
    expect(types.has("pull_request")).toBe(true);
    expect(types.has("required_status_checks")).toBe(true);
    expect(types.has("merge_queue")).toBe(true);
  });

  it("accepts additional required-status contexts", () => {
    const r = defaultMainRulesetShape("scratch", {
      additionalRequiredContexts: ["agent-critic", "branch-protection-audit"],
    });
    const rsc = r.rules.find((rr) => rr.type === "required_status_checks");
    expect(rsc?.type).toBe("required_status_checks");
    if (rsc?.type === "required_status_checks") {
      const ctxs = rsc.parameters.required_status_checks.map((c) => c.context);
      expect(ctxs).toEqual(["agent-critic", "branch-protection-audit"]);
    }
  });
});

describe("defaultCeReviewRulesetShape — Ruleset B (CE bypass lane)", () => {
  it("contains exactly one rule — the pull_request review rule", () => {
    const r = defaultCeReviewRulesetShape("scratch");
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]?.type).toBe("pull_request");
    if (r.rules[0]?.type === "pull_request") {
      expect(r.rules[0].parameters.required_approving_review_count).toBe(1);
      expect(r.rules[0].parameters.require_code_owner_review).toBe(true);
    }
  });

  it("declares one Team bypass actor with pull_request scope", () => {
    const r = defaultCeReviewRulesetShape("scratch");
    expect(r.bypass_actors).toHaveLength(1);
    expect(r.bypass_actors[0]?.actor_type).toBe("Team");
    expect(r.bypass_actors[0]?.bypass_mode).toBe("pull_request");
  });

  it("accepts a chief-engineers team id at construction time", () => {
    const r = defaultCeReviewRulesetShape("scratch", { chiefEngineerTeamId: 999 });
    expect(r.bypass_actors[0]?.actor_id).toBe(999);
  });

  it("null team id is the pre-team-creation sentinel", () => {
    const r = defaultCeReviewRulesetShape("scratch");
    expect(r.bypass_actors[0]?.actor_id).toBeNull();
  });
});

describe("top-level barrel — re-exports the merge-queue surface", () => {
  it("classifyPrKindFromFiles is reachable via index.ts", () => {
    expect(fromBarrel).toBe(classifyPrKindFromFiles);
  });

  it("defaultMergeQueueRule is reachable via index.ts", () => {
    expect(defaultMqFromBarrel).toBe(defaultMergeQueueRule);
  });
});
