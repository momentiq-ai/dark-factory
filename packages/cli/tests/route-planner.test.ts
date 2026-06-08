// Cycle 21 — Evidence-Gated Validation Routes (momentiq-ai/dark-factory#184).
//
// The additive route planner: the deterministic path-glob table is the
// floor; a planner hook may only ADD routes, never remove one the table
// armed. The monotonicity is the whole point — a (future, LLM-backed)
// planner can only ever INCREASE the evidence burden, so it can never
// weaken the gate. v1 ships the table + the additive hook (interface +
// default no-op) and the additive-only invariant under test.
import { describe, expect, it } from "vitest";

import { planRoutes, tableArmedRoutes } from "../src/policy/gate.js";
import type { VerificationRoute } from "@momentiq/dark-factory-schemas";

const TF: VerificationRoute = {
  id: "terraform",
  trigger: ["infra/terraform/**"],
  command: "df verify --route terraform",
  evidencePath: "agent-reviews/quality-gates/${sha}.json",
  category: "infra",
  evidenceKind: "terraform",
};
const TEST: VerificationRoute = {
  id: "targeted-test",
  trigger: ["services/*/src/**"],
  command: "df verify --route targeted-test",
  evidencePath: "agent-reviews/quality-gates/${sha}.json",
  category: "test",
  evidenceKind: "test",
};
const DOCS: VerificationRoute = {
  id: "docs-only",
  trigger: ["**/*.md", "docs/**"],
  command: null,
  evidencePath: null,
  category: "docs",
  exclusive: true,
  evidenceKind: "none",
};
const TABLE: VerificationRoute[] = [TF, TEST, DOCS];

describe("tableArmedRoutes (the deterministic floor)", () => {
  it("arms only routes whose triggers match a changed path", () => {
    const armed = tableArmedRoutes(["infra/terraform/main.tf"], TABLE);
    expect(armed.map((r) => r.id)).toEqual(["terraform"]);
  });

  it("arms multiple routes for a multi-class change", () => {
    const armed = tableArmedRoutes(
      ["infra/terraform/main.tf", "services/worker/src/x.ts"],
      TABLE,
    );
    expect(armed.map((r) => r.id).sort()).toEqual(["targeted-test", "terraform"]);
  });

  it("arms nothing when no path matches", () => {
    expect(tableArmedRoutes(["unrelated/file.go"], TABLE)).toEqual([]);
  });
});

describe("planRoutes — additive-only invariant (#184)", () => {
  it("returns the table-armed set unchanged when no planner hook is supplied", () => {
    const armed = tableArmedRoutes(["infra/terraform/main.tf"], TABLE);
    const planned = planRoutes(["infra/terraform/main.tf"], TABLE);
    expect(planned.map((r) => r.id)).toEqual(armed.map((r) => r.id));
  });

  it("INVARIANT: tableArmed is always a subset of planned, for any planner output", () => {
    // An adversarial planner that tries to DROP a table-armed route and
    // ADD an unrelated one. The additive contract must defeat the drop:
    // the table's routes survive regardless of what the planner returns.
    const adversarialPlanner = (): VerificationRoute[] => [TEST]; // tries to replace, not add
    const changed = ["infra/terraform/main.tf"]; // arms `terraform` from the table
    const armed = tableArmedRoutes(changed, TABLE);
    const planned = planRoutes(changed, TABLE, adversarialPlanner);

    const plannedIds = new Set(planned.map((r) => r.id));
    for (const r of armed) {
      expect(plannedIds.has(r.id)).toBe(true); // tableArmed ⊆ planned
    }
    // And the planner's addition rode along too.
    expect(plannedIds.has("targeted-test")).toBe(true);
  });

  it("ADDS planner routes to the armed set, de-duplicated by id", () => {
    const extra: VerificationRoute = {
      id: "generated-artifact",
      trigger: ["never-matches/**"],
      command: "df verify --route generated-artifact",
      evidencePath: "agent-reviews/quality-gates/${sha}.json",
      category: "generated",
      evidenceKind: "test",
    };
    const planner = (): VerificationRoute[] => [extra];
    const planned = planRoutes(["infra/terraform/main.tf"], TABLE, planner);
    expect(planned.map((r) => r.id).sort()).toEqual(
      ["generated-artifact", "terraform"].sort(),
    );
  });

  it("de-dupes when the planner returns a route the table already armed (table wins; no double-count)", () => {
    // The planner re-proposing `terraform` must not produce two entries.
    const planner = (): VerificationRoute[] => [TF];
    const planned = planRoutes(["infra/terraform/main.tf"], TABLE, planner);
    expect(planned.filter((r) => r.id === "terraform")).toHaveLength(1);
  });

  it("a planner returning [] cannot shrink the armed set (no-op floor preserved)", () => {
    const emptyPlanner = (): VerificationRoute[] => [];
    const armed = tableArmedRoutes(["services/worker/src/x.ts"], TABLE);
    const planned = planRoutes(["services/worker/src/x.ts"], TABLE, emptyPlanner);
    expect(planned.map((r) => r.id)).toEqual(armed.map((r) => r.id));
  });

  it("PROPERTY: for random planner outputs, planned ⊇ tableArmed always holds", () => {
    const universe: VerificationRoute[] = [TF, TEST, DOCS];
    const changedSets = [
      ["infra/terraform/main.tf"],
      ["services/worker/src/x.ts"],
      ["docs/readme.md"],
      ["infra/terraform/main.tf", "services/api/src/y.ts"],
      ["nothing/here.go"],
    ];
    for (const changed of changedSets) {
      for (let mask = 0; mask < 1 << universe.length; mask++) {
        const plannerOut = universe.filter((_, i) => (mask >> i) & 1);
        const planner = (): VerificationRoute[] => plannerOut;
        const armed = tableArmedRoutes(changed, TABLE);
        const planned = planRoutes(changed, TABLE, planner);
        const plannedIds = new Set(planned.map((r) => r.id));
        for (const r of armed) {
          expect(plannedIds.has(r.id)).toBe(true);
        }
      }
    }
  });
});
