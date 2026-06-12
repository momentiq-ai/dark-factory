// Cycle 21 — Evidence-Gated Validation Routes (momentiq-ai/dark-factory#185).
//
// The route-runner generalizes the `.husky/pre-commit` Docker build-evidence
// shim (the #141 pattern) beyond Docker. Given the armed routes + changed
// paths, it runs each armed route's producer command and writes per-SHA
// `QualityGateEvidence` keyed by `routeId` under `gateResults`, honoring the
// SAME 0/1/2 exit-code contract as the shim:
//
//   - exit 0 → "green"      — the route passed.
//   - exit 1 → "block"      — the route failed; the gate blocks (the
//                             evidence's `exitCode !== 0` is the deterministic
//                             block condition `enforceVerificationRoutes`
//                             already checks).
//   - exit 2 → "soft-skip"  — the route's tool is unreachable in THIS
//                             environment (e.g. no docker socket / no browser);
//                             the skip is recorded (NOT silently dropped) and
//                             surfaced as `requiresHumanJudgment`. The exit
//                             code stays 2 (non-zero) so the gate does not
//                             treat a soft-skip as a pass.
//
// This is the shared producer the DFP `/verify` skill drives (and the
// generalization the DFP `.husky/pre-commit` hook adopts off its Docker-only
// shim). Browser/UI (playwright) routes are local-only in v1 (they need a
// browser + the Doppler validation-user session); hosted re-execution is a
// v2 item (ADR 2026-06 § Roadmap to v2).
import type { LoadedConfig } from "../policy/config.js";
import { matchAnyGlob } from "../glob.js";
import { planRoutes, type RoutePlanner } from "../policy/gate.js";
import { runQualityGates } from "./quality-gates.js";
import { perShaQualityGatePath } from "./per-sha.js";
import { resolveArtifactRoot } from "../paths.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  isVerifyRouteCommand,
  parseQualityGateEvidence,
  type QualityGateEvidence,
  type VerificationRoute,
} from "@momentiq/dark-factory-schemas";

// The exit-code contract, as a discriminated outcome the caller can branch
// on without re-deriving it from the raw code.
export type RouteOutcome = "green" | "block" | "soft-skip";

export interface RouteRunResult {
  routeId: string;
  command: string;
  exitCode: number;
  outcome: RouteOutcome;
  // True only for the soft-skip (exit 2) outcome — mirrors the #141 shim's
  // "tool unreachable → requiresHumanJudgment" fallback. Consumers route
  // this to a `requiresHumanJudgment` finding rather than a hard block.
  requiresHumanJudgment: boolean;
}

export interface RouteRunSummary {
  // Routes whose producer command actually ran (armed ∩ has-command ∩ not
  // suppressed), with their outcome.
  ran: RouteRunResult[];
  // The exclusive route id that suppressed the command routes, if any
  // (e.g. a docs-only change suppresses production routes — nothing runs).
  suppressedBy?: string;
}

export interface RunRoutesOptions {
  loaded: LoadedConfig;
  commit: string;
  changedPaths: readonly string[];
  cwd?: string;
  signal?: AbortSignal;
  // Cycle 21 (#184) — optional additive planner. The route-runner produces
  // evidence for the PLANNED set (table floor ∪ planner additions), so the
  // producer and the gate (`enforceVerificationRoutes`) arm the same routes.
  planner?: RoutePlanner;
  // Cycle 21 (#186) — when supplied, stamp the diff hash on the per-SHA
  // evidence so `enforceVerificationRoutes` can reject the evidence if it is
  // later replayed under a different diff. The producer half of the binding.
  diffHash?: string;
  // Cycle 22 (#192) — `df verify --route <id>`: narrow the run to a single
  // route. Filters the ARMED set (table floor ∪ planner, post-suppression),
  // NOT the raw table — so a route the diff did not trigger produces nothing
  // even under an explicit `--route`, keeping the producer consistent with
  // the no-arg run and with what `enforceVerificationRoutes` gates. An id
  // that is not in the armed set simply runs nothing (the CLI command is
  // responsible for the "unknown route" vs "not triggered" diagnostic).
  routeFilter?: string;
}

/**
 * Classify a process exit code into the 0/1/2 route contract. Any code other
 * than 0/1/2 (e.g. a spawn error of -1, or a SIGKILL) is treated as a block:
 * an indeterminate producer result must fail closed, never pass.
 */
export function classifyExit(exitCode: number): RouteOutcome {
  if (exitCode === 0) return "green";
  if (exitCode === 2) return "soft-skip";
  return "block";
}

/**
 * Run every armed route's producer command and write per-SHA
 * `QualityGateEvidence` (keyed by routeId under `gateResults`). Pure
 * orchestration over `runQualityGates` (the per-command producer) — it does
 * not change `runQualityGates`' evidence shape; it iterates routes, applies
 * exclusive-route suppression, classifies the 0/1/2 outcome, and stamps the
 * diff hash.
 */
export async function runRoutes(options: RunRoutesOptions): Promise<RouteRunSummary> {
  const { loaded, commit, changedPaths } = options;
  const table = loaded.config.validation.verificationRoutes ?? [];
  if (table.length === 0) return { ran: [] };

  // Arm routes via the additive planner (table floor ∪ planner additions,
  // de-duped by id) — the SAME set `enforceVerificationRoutes` gates.
  const armed = planRoutes(changedPaths, table, options.planner);

  // Exclusive-route suppression — identical rule to enforceVerificationRoutes
  // step 2: an exclusive route fires only when EVERY changed path matches its
  // trigger; when it fires, the command routes are suppressed (nothing to
  // produce — the suppression itself is the gate decision).
  let suppressedBy: VerificationRoute | undefined;
  for (const route of armed) {
    if (!route.exclusive) continue;
    if (changedPaths.every((p) => matchAnyGlob(p, route.trigger))) {
      suppressedBy = route;
      break;
    }
  }
  let active = suppressedBy
    ? armed.filter((r) => r === suppressedBy)
    : armed.filter((r) => !r.exclusive);

  // Cycle 22 (#192) — `--route <id>` narrows the armed set. Applied AFTER
  // suppression so a docs-only-suppressed run still produces nothing under an
  // explicit `--route`, matching the gate.
  if (options.routeFilter !== undefined) {
    active = active.filter((r) => r.id === options.routeFilter);
  }

  // Cycle 22 (#192) — recursion guard. `df verify` is the route ORCHESTRATOR,
  // not a per-route producer: spawning a route whose command is itself a
  // `df verify` invocation (an un-overridden default placeholder) would
  // re-enter `df verify` → runRoutes → spawn it again, forever. Fail fast with
  // an actionable error BEFORE spawning anything, rather than recursing. Runs
  // after the routeFilter so `df verify --route X` on an un-overridden X is
  // caught too. Suppression-only routes (command null) are exempt.
  for (const r of active) {
    if (r.command !== null && isVerifyRouteCommand(r.command)) {
      throw new Error(
        `route "${r.id}" still has the placeholder command \`${r.command}\`; ` +
          `override it in .agent-review/config.json with your toolchain's ` +
          `producer (\`df verify\` is the route orchestrator, not a per-route ` +
          `producer — see DEFAULT_VERIFICATION_ROUTES).`,
      );
    }
  }

  const ran: RouteRunResult[] = [];
  for (const route of active) {
    if (options.signal?.aborted) break;
    if (route.command === null) {
      // Suppression-only route (e.g. the active docs-only route) has no
      // producer — nothing to run.
      continue;
    }
    const evidence = await runQualityGates({
      loaded,
      commit,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      commands: [route.command],
      routeId: route.id,
    });
    const result = evidence.gateResults?.[route.id];
    const exitCode = result?.exitCode ?? -1;
    const outcome = classifyExit(exitCode);
    ran.push({
      routeId: route.id,
      command: route.command,
      exitCode,
      outcome,
      requiresHumanJudgment: outcome === "soft-skip",
    });
  }

  // Cycle 21 (#186) — stamp the diff hash on the per-SHA evidence file so
  // `enforceVerificationRoutes` can detect a same-SHA / different-diff replay.
  // Done as a post-pass read-modify-write (runQualityGates owns the evidence
  // shape; this only adds the binding field) so the producer's evidence
  // contract is untouched. Skipped when no diffHash was supplied OR no
  // command route ran (no evidence file to stamp).
  if (options.diffHash !== undefined && ran.length > 0) {
    await stampDiffHash(loaded, commit, options.diffHash);
  }

  return {
    ran,
    ...(suppressedBy !== undefined ? { suppressedBy: suppressedBy.id } : {}),
  };
}

async function stampDiffHash(
  loaded: LoadedConfig,
  commit: string,
  diffHash: string,
): Promise<void> {
  const root = await resolveArtifactRoot(loaded);
  const path = perShaQualityGatePath(root, loaded.config.git.artifactDir, commit);
  if (!existsSync(path)) return;
  let evidence: QualityGateEvidence;
  try {
    evidence = parseQualityGateEvidence(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return;
  }
  if (evidence.commit !== commit) return;
  const updated: QualityGateEvidence = { ...evidence, diffHash };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
}
