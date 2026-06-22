// packages/cli/src/worktree-safety.ts
//
// Linked-worktree corruption safety (dark-factory#227).
//
// Root cause (root-caused in dark-factory-platform#93): when commits land
// rapidly across multiple/linked git worktrees, the shared object store's
// loose-object count crosses `gc.auto`'s threshold and git fires a background
// `git gc --auto`. The prune step drops objects that are still referenced ONLY
// by ANOTHER worktree's uncommitted index cache-tree — and that worktree then
// fails every `git status` / `git commit` with `fatal: unable to read <sha>`
// / `invalid sha1 pointer in cache-tree`. (The Dark Factory post-commit hook
// makes this worse: each commit launches a background `df review`, so a
// `git rebase` that replays N commits fans out N background reviewers against
// the shared object store.)
//
// This module ships the validated prevention (`gc.auto = 0`) and the supported
// recovery (`git read-tree HEAD`) so BOTH travel to every consumer via the
// published CLI — consumer repos copy the hooks once and never re-copy them,
// so the fix has to live in the binary, not only the hook docs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

/**
 * Idempotently disable git auto-gc for the repo at `cwd` so a background prune
 * can't corrupt a linked worktree's index (dark-factory#227).
 *
 * - Writes the LOCAL config, which for a linked worktree is the shared
 *   common-dir `config` — one flip protects every worktree of the repo.
 * - No-op when `gc.auto` already resolves to `0` (so the one-time log fires at
 *   most once per repo, on the first hook invocation after adoption).
 * - Failure-tolerant: a lock-contention loss (another worktree racing the same
 *   flip) or a read-only config is swallowed — this is a backstop and must
 *   NEVER block a review/gate.
 * - Opt out with `DF_KEEP_GC_AUTO=1` if you manage gc yourself (you then accept
 *   the linked-worktree prune-race risk; `df doctor --fix-cache-tree` recovers
 *   if it bites).
 *
 * @returns `{ flipped }` — `true` iff this call wrote `gc.auto=0`.
 */
export async function ensureGcAutoDisabled(
  cwd: string = process.cwd(),
  log: (msg: string) => void = (m) => process.stderr.write(m),
): Promise<{ flipped: boolean }> {
  if (process.env["DF_KEEP_GC_AUTO"] === "1") return { flipped: false };

  let current = "";
  try {
    const { stdout } = await runFile("git", ["config", "--get", "gc.auto"], {
      cwd,
    });
    current = stdout.trim();
  } catch {
    // `git config --get` exits 1 when the key is unset → current stays "" and
    // we set it below. Any other failure (not a repo, git missing) makes the
    // set below fail too, and that's swallowed — this is a best-effort backstop.
  }
  if (current === "0") return { flipped: false };

  try {
    await runFile("git", ["config", "gc.auto", "0"], { cwd });
    log(
      "df: disabled git auto-gc (gc.auto=0) to keep linked worktrees safe from " +
        "the prune race (dark-factory#227). Run `git gc` by hand if the repo " +
        "grows; set DF_KEEP_GC_AUTO=1 to opt out.\n",
    );
    return { flipped: true };
  } catch {
    // Lost a race with another worktree's identical flip, or the config is
    // read-only. Either the other writer set it or the operator can — never
    // fail the caller on this.
    return { flipped: false };
  }
}

/** Outcome of an attempted cache-tree recovery. */
export interface CacheTreeRecovery {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Recover a worktree whose index cache-tree references a missing object
 * (dark-factory#227 / the corruption `df doctor`'s `cache_tree_probe` detects)
 * by rebuilding the index from HEAD's tree: `git read-tree HEAD`.
 *
 * DESTRUCTIVE in one specific way: it resets the INDEX to HEAD, so anything
 * that was `git add`-ed but not committed is unstaged. Working-tree file edits
 * are preserved — re-stage them with `git add` afterward.
 *
 * If HEAD's OWN tree object was the one pruned (deeper corruption), this fails;
 * the detail surfaces the git error so the operator can fall back to the
 * last-resort recovery (`git worktree remove --force` + recreate off the
 * remote).
 */
export async function recoverCacheTree(
  repoRoot: string,
): Promise<CacheTreeRecovery> {
  try {
    await runFile("git", ["read-tree", "HEAD"], { cwd: repoRoot });
    return {
      ok: true,
      detail:
        "rebuilt the index from HEAD (`git read-tree HEAD`). Staged changes " +
        "were reset to HEAD; working-tree edits are preserved — re-stage with " +
        "`git add` if needed.",
    };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    return {
      ok: false,
      detail:
        `git read-tree HEAD failed${stderr ? `: ${stderr}` : ""}. HEAD's own ` +
        "tree may be missing; recover with `git worktree remove --force <path>` " +
        "then recreate the worktree off the remote.",
    };
  }
}
