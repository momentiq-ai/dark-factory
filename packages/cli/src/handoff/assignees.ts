// packages/cli/src/handoff/assignees.ts
//
// Assignees status + me-login cache. PORT FROM dark-factory-platform
// .claude/skills/handoff/scripts/lib.sh@a6f711b lines 32-41 (me_login + cache),
// 88-103 (assignees_status + assignees_other_csv).

import type { GhClient } from "./ports.js";

/**
 * Classification of an issue's assignees set against @me:
 *   - "empty"  → no assignees      (available on the stack)
 *   - "me"     → exactly [@me]     (same-actor update / close-failure retry)
 *   - "other"  → any non-empty set ≠ [@me] (refuse/abort per §4.1, §4.3 step 4)
 *
 * Note: "[@me, @me]" (a duplicated @me — defensive against GitHub returning
 * duplicates) classifies as "other" because cardinality must be 1 for "me".
 */
export type ClaimStatus = "empty" | "me" | "other";

/**
 * Classify an assignees array. PORT FROM bash assignees_status (lib.sh:88-96):
 *   count == 0           → "empty"
 *   count == 1 && [@me]  → "me"
 *   otherwise            → "other"
 */
export function assigneesStatus(
  assignees: ReadonlyArray<{ login: string }>,
  meLogin: string,
): ClaimStatus {
  if (assignees.length === 0) return "empty";
  // Length-checked, but TS with noUncheckedIndexedAccess needs the explicit
  // binding to narrow `assignees[0]` from `T | undefined` to `T`.
  const first = assignees[0];
  if (assignees.length === 1 && first !== undefined && first.login === meLogin) return "me";
  return "other";
}

/**
 * Comma-joined list of assignees with @me filtered out. Used by refuse-
 * messages ("currently assigned to @<csv>"). Preserves input order.
 * PORT FROM bash assignees_other_csv (lib.sh:99-103).
 */
export function assigneesOtherCsv(
  assignees: ReadonlyArray<{ login: string }>,
  meLogin: string,
): string {
  return assignees
    .map((a) => a.login)
    .filter((l) => l !== meLogin)
    .join(",");
}

/**
 * Cache for the @me login lookup. PORT FROM bash me_login + ME_LOGIN_CACHE
 * (lib.sh:34-41). One API hit per process; cached across repeated callers.
 */
export class MeLoginCache {
  private cache: string | undefined;
  async resolve(gh: GhClient): Promise<string> {
    if (this.cache === undefined) {
      this.cache = await gh.apiUserLogin();
    }
    return this.cache;
  }
}
