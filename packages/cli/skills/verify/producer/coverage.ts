/**
 * Fail-closed coverage logic for the reusable Evidence-Gated Validation
 * **playwright (UI) route** producer (momentiq-ai/dark-factory#193).
 *
 * Generalized from the dark-factory-dashboard dogfood producer (Cycle 21 PR-4).
 * This module is pure, importable, and unit-tested without a browser, so the
 * load-bearing rule — *a changed UI path that maps to no capture surface BLOCKS
 * the route* — cannot regress.
 *
 * A `web/**`/`*.tsx` change arms the route; this module decides, per changed
 * path, whether a capture surface exists. If a changed *product-UI* path has no
 * surface, it lands in `uncovered` and the producer fails closed — so the gate
 * cannot be satisfied by rendering only an unaffected surface.
 *
 * This is a CONSUMER REFERENCE FILE: copy it into your repo alongside the
 * producer spec and own it. It has no Dark Factory / vendor dependency.
 */

export interface UiSurface {
  /** URL path to navigate (relative to baseURL). */
  path: string;
  /** Filesystem-safe slug for the evidence subdir. */
  slug: string;
  /** A role+name the surface MUST expose (structural floor assertion). */
  requiredHeading: RegExp;
  /**
   * Source-path globs this surface is the evidence for. A changed path
   * matching one of these is "covered" by this surface's capture.
   */
  covers: readonly string[];
}

export interface CoveragePartition {
  /** Surfaces armed because a changed path matches their `covers`. */
  armed: UiSurface[];
  /** Changed UI paths with no mapped surface (the fail-closed set). */
  uncovered: string[];
  /**
   * True when the route is armed (the change touched the trigger surface) but
   * NO surface was armed AND nothing is uncovered — i.e. the change is
   * harness/non-UI only (e.g. an edit to the gate logic or the producer config
   * itself). In that case the producer captures ALL surfaces as a regression
   * smoke so the route still produces real ARIA + after evidence and cannot be
   * passed with zero captures (the harness-only bypass — symmetric to the
   * false-positive hole).
   */
  smokeAllSurfaces: boolean;
}

/**
 * Translate a glob (`**`, `*`, literal route-group `(group)` dirs) to a RegExp.
 * `**` matches across `/`; `*` matches within a path segment. Anchored.
 *
 * Built by scanning the glob (no placeholder char) so `**` and `*` are expanded
 * cleanly; everything else is regex-escaped — including the parentheses in
 * Next.js route groups, which we want treated as literals.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*"; // ** → any chars including /
        i++;
      } else {
        pattern += "[^/]*"; // * → any chars except /
      }
      continue;
    }
    pattern += ch.replace(/[.+^${}()|[\]\\]/, "\\$&"); // escape one metachar
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * Partition changed UI paths into the surfaces they arm and the paths that map
 * to NO surface (the fail-closed set). `nonSurfaceGlobs` are harness / non-UI
 * files that are exempt from the coverage requirement.
 *
 * Empty `changed` (e.g. a manual run with the env unset) arms every surface so
 * the producer still captures evidence; the gate's real armed-by-diff semantics
 * come from the changed-paths the route script computes.
 */
export function partitionChangedPaths(
  changed: readonly string[],
  surfaces: readonly UiSurface[],
  nonSurfaceGlobs: readonly string[],
): CoveragePartition {
  if (changed.length === 0) {
    // No changed-path signal (e.g. a manual run with the env unset) — arm all
    // surfaces so the producer still captures evidence.
    return { armed: [...surfaces], uncovered: [], smokeAllSurfaces: false };
  }
  const armed = new Set<UiSurface>();
  const uncovered: string[] = [];
  for (const path of changed) {
    if (matchesAny(path, nonSurfaceGlobs)) continue; // harness/non-UI — skip.
    const matched = surfaces.filter((s) => matchesAny(path, s.covers));
    if (matched.length === 0) {
      uncovered.push(path);
      continue;
    }
    for (const s of matched) armed.add(s);
  }
  // Harness-only change (the route is armed by a web/** edit, but every changed
  // path is a non-surface harness/config/gate-logic file): capture ALL surfaces
  // as a regression smoke so the route NEVER passes with zero evidence. This
  // closes the harness-only bypass — a change to the gate logic itself still
  // produces real ARIA + after captures.
  const smokeAllSurfaces = armed.size === 0 && uncovered.length === 0;
  return {
    armed: smokeAllSurfaces ? [...surfaces] : [...armed],
    uncovered,
    smokeAllSurfaces,
  };
}
