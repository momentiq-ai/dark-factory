// packages/cli/src/onboard/seeders/index.ts
//
// Seeder interface + orchestrator for cycle 15 Phase C's deterministic
// docs-as-code renderers (ADR, cycle-1 bootstrap, runbook, agent-review
// config).
//
// Each seeder takes a RepoAnalysis (Phase A) plus orchestration context and
// emits a list of FilePlan entries (Phase B's per-file discriminated union)
// for the applyPlan writer to consume.
//
// Phase C seeders ONLY emit `emit` or `skip` entries — the `merge` action is
// exclusively Phase B's CLAUDE.md / AGENTS.md handler. `cmdOnboard`
// (Task 4.5) wires Phase B's LLM-emitted plan + Phase C's seeder output
// into a single merged ScaffoldPlan via `mergeScaffoldPlan`.
import type { FilePlan } from "../scaffold-schema.js";
import type { RepoAnalysis } from "../schema.js";

import { adrSeeder } from "./adr.js";
import { cycle1BootstrapSeeder } from "./cycle1-bootstrap.js";
import { runbookSeeder } from "./runbook.js";
import { agentReviewConfigSeeder } from "./agent-review-config.js";

export type { FilePlan } from "../scaffold-schema.js";

/**
 * Input to a Phase C seeder.
 *
 * - `analysis`: the Phase A `RepoAnalysis` (the deterministic source of truth).
 * - `existingAdrs` / `existingCycleDocs` / `existingRunbooks`: filenames
 *   already present in the target tree (basenames, not full paths). Used by
 *   seeders to auto-increment numeric prefixes and skip on slug collision.
 *   `cmdOnboard` populates these by scanning the target tree before fan-out.
 * - `now`: a wallclock injected so tests can pin the date deterministically.
 * - `profile`: resolved critic profile for the target repo (the
 *   `agent-review-config` seeder uses this to pick `local.canonical.json`
 *   vs `cloud.canonical.json`). Optional with default "local" so the prose
 *   seeders' unit tests need not specify the field; production callers
 *   (`cmdOnboard`) always set it explicitly to the resolved profile.
 */
export interface SeederInput {
  readonly analysis: RepoAnalysis;
  readonly existingAdrs: readonly string[];
  readonly existingCycleDocs?: readonly string[];
  readonly existingRunbooks?: readonly string[];
  readonly now: Date;
  readonly profile?: "local" | "cloud";
}

export interface Seeder {
  readonly name: string;
  seed(input: SeederInput): Promise<FilePlan[]>;
}

/**
 * Run every seeder in parallel, isolating individual failures to stderr so a
 * single broken seeder does NOT block the rest of the merge. Phase C seeders
 * are non-critical (their outputs augment Phase B's plan) — the orchestrator
 * resolves to `[]` for any seeder that throws and concatenates the survivors.
 */
export async function runSeeders(
  input: SeederInput,
  seeders: readonly Seeder[],
): Promise<FilePlan[]> {
  const results = await Promise.all(
    seeders.map(async (s) => {
      try {
        return await s.seed(input);
      } catch (e) {
        process.stderr.write(
          `df onboard seeder ${s.name} failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        return [];
      }
    }),
  );
  return results.flat();
}

export { adrSeeder } from "./adr.js";
export { cycle1BootstrapSeeder } from "./cycle1-bootstrap.js";
export { runbookSeeder } from "./runbook.js";
export { agentReviewConfigSeeder } from "./agent-review-config.js";

/**
 * The canonical seeder set wired into `cmdOnboard` (Task 4.5). Order is
 * presentation-only — `runSeeders` runs them concurrently.
 */
export const ALL_SEEDERS_DEFAULT: readonly Seeder[] = [
  adrSeeder,
  cycle1BootstrapSeeder,
  runbookSeeder,
  agentReviewConfigSeeder,
];
