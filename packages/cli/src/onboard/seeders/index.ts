// packages/cli/src/onboard/seeders/index.ts
//
// Seeder interface — shared shape for cycle 15 Phase C's deterministic
// docs-as-code renderers (ADR, cycle-1 bootstrap, runbook, .agent-review/config.json).
//
// Each seeder takes a RepoAnalysis (Phase A) plus orchestration context and
// emits a list of FilePlan entries (Phase B's per-file discriminated union)
// for the applyPlan writer to consume.
//
// Phase C seeders ONLY emit `emit` or `skip` entries — the `merge` action is
// exclusively Phase B's CLAUDE.md / AGENTS.md handler.
//
// NOTE: Task 1 ships this file as a TYPES-ONLY stub so the per-seeder modules
// (adr.ts, cycle1-bootstrap.ts, runbook.ts, agent-review-config.ts) can compile
// and unit-test in isolation. Task 3.5 will extend this module with the
// `runSeeders` orchestrator + `ALL_SEEDERS_DEFAULT` export; the interface
// shape here is the stable contract Task 3.5 composes against.
import type { FilePlan } from "../scaffold-schema.js";
import type { RepoAnalysis } from "../schema.js";

export type { FilePlan } from "../scaffold-schema.js";

/**
 * Input to a Phase C seeder.
 *
 * - `analysis`: the Phase A `RepoAnalysis` (the deterministic source of truth).
 * - `existingAdrs` / `existingCycleDocs` / `existingRunbooks`: filenames already
 *   present in the target tree (basenames, not full paths). Used by seeders to
 *   auto-increment numeric prefixes and skip on slug collision. Task 3.5's
 *   orchestrator populates these by scanning the target tree before fan-out.
 * - `now`: a wallclock injected so tests can pin the date deterministically.
 */
export interface SeederInput {
  readonly analysis: RepoAnalysis;
  readonly existingAdrs: readonly string[];
  readonly existingCycleDocs?: readonly string[];
  readonly existingRunbooks?: readonly string[];
  readonly now: Date;
  /**
   * Resolved critic profile for the target repo. The agent-review config
   * seeder (Task 3.6) uses this to pick `local.canonical.json` vs
   * `cloud.canonical.json`. The three prose seeders ignore it. Optional with
   * default "local" so prose-seeder unit tests need not specify the field;
   * production callers (`cmdOnboard`) always set it explicitly to the
   * resolved profile.
   */
  readonly profile?: "local" | "cloud";
}

export interface Seeder {
  readonly name: string;
  seed(input: SeederInput): Promise<FilePlan[]>;
}
