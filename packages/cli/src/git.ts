import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type { ChangedFile, ChangedFileStatus, CommitMetadata } from "@momentiq/dark-factory-schemas";

const runFile = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

async function git(
  args: string[],
  options: { cwd?: string; input?: string } = {},
): Promise<string> {
  try {
    const { stdout } = await runFile("git", args, {
      cwd: options.cwd,
      maxBuffer: MAX_BUFFER,
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    return stdout;
  } catch (err) {
    const e = err as Error & { stderr?: string; code?: number };
    const detail = e.stderr ? `: ${e.stderr.trim()}` : "";
    throw new Error(`git ${args.join(" ")} failed${detail}`);
  }
}

// Read a file's contents at a specific git ref. Returns null if the file
// does not exist at that ref (caller decides how to handle — e.g., the
// commit being reviewed is the one that introduces the file).
export async function gitShowFile(
  ref: string,
  path: string,
  cwd: string = process.cwd(),
): Promise<string | null> {
  try {
    return await git(["show", `${ref}:${path}`], { cwd });
  } catch (err) {
    // git show fails for missing-at-ref; we don't want to differentiate
    // missing-file from missing-ref here — both mean "no baseline".
    const msg = (err as Error).message;
    if (/does not exist|exists on disk, but not in|fatal: ambiguous argument/.test(msg)) {
      return null;
    }
    throw err;
  }
}

export async function repoRoot(cwd: string = process.cwd()): Promise<string> {
  const out = await git(["rev-parse", "--show-toplevel"], { cwd });
  return out.trim();
}

export async function gitCommonDir(cwd: string = process.cwd()): Promise<string> {
  const out = await git(["rev-parse", "--git-common-dir"], { cwd });
  const trimmed = out.trim();
  if (trimmed.startsWith("/")) return trimmed;
  return `${await repoRoot(cwd)}/${trimmed}`;
}

export async function gitDir(cwd: string = process.cwd()): Promise<string> {
  const out = await git(["rev-parse", "--git-dir"], { cwd });
  const trimmed = out.trim();
  if (trimmed.startsWith("/")) return trimmed;
  return `${await repoRoot(cwd)}/${trimmed}`;
}

export async function currentBranch(cwd: string = process.cwd()): Promise<string> {
  const out = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  return out.trim();
}

export async function resolveCommit(ref: string, cwd: string = process.cwd()): Promise<string> {
  const out = await git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
  return out.trim();
}

export async function commitParent(sha: string, cwd: string = process.cwd()): Promise<string> {
  const out = await git(["rev-list", "--parents", "-n", "1", sha], { cwd });
  const parts = out.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`commit ${sha} has no parent (root or shallow)`);
  }
  return parts[1] ?? "";
}

// Issues #181 / #182 — count the parent pointers recorded INSIDE the commit
// object, independent of graft/shallow state. `git cat-file -p <sha>` prints
// the raw object: a header block (`tree`, zero-or-more `parent`, `author`,
// `committer`, optional `gpgsig` continuation lines) terminated by a blank
// line, then the free-form commit message. We count `parent ` lines in the
// HEADER ONLY.
//
// Why this is the discriminator a shallow checkout needs: `git rev-list
// --parents` (used by `commitParent`) and `%P` (used by `commitMetadata`)
// both RESPECT the shallow graft — on a `fetch-depth: 1` merge commit they
// report zero parents because the graft severs the history at that boundary.
// `cat-file -p` reads the object's literal bytes and bypasses the graft, so
// it sees the TRUE in-object parent count. A genuine root commit records 0
// in-object parents; a shallow-boundary commit records ≥1 but those parents
// are not reachable in the partial clone. That gap is exactly what
// `safeParentOrThrow` keys on to distinguish a legit root from a masked
// shallow boundary.
//
// Two load-bearing parsing properties (see the column-0 + blank-line guards):
//   1. Stop at the first blank line — the message body is rendered at column
//      0, so a body line like "parent commit was reverted" must NOT count.
//   2. Anchor on start-of-line — gpgsig continuation lines are space-indented
//      (" wsFcB...") and so already safe, but the anchor makes the intent
//      explicit and robust to other indented header continuations.
export async function parentsInObject(
  sha: string,
  cwd: string = process.cwd(),
): Promise<number> {
  const out = await git(["cat-file", "-p", sha], { cwd });
  let count = 0;
  for (const line of out.split("\n")) {
    if (line === "") break; // end of header block; message body follows
    if (line.startsWith("parent ")) count++;
  }
  return count;
}

// Issues #181 / #182 — fail-loud parent resolver shared by every packet /
// verify call site (`rebind.ts`, `commands/verify.ts`). Replaces the old
// blanket `try { commitParent } catch { return "" }` that masked a shallow-
// clone boundary as a true root commit:
//
//   - True root (`parentsInObject === 0`): the commit genuinely has no
//     parent. Return "" so `commitDiff` / `changedFiles` take the
//     `git show <sha>` path (commit-introduces-everything). This is the
//     ONE legitimate empty-parent case.
//
//   - Shallow boundary (`parentsInObject > 0` but `commitParent` couldn't
//     reach the parent): the clone is too shallow. THROW with a "deepen the
//     clone (fetch-depth: 0)" remediation. Returning "" here is the #182 bug:
//     it makes the packet diff against the empty tree = the WHOLE repo, which
//     blows past every vendor's context window and silently shrinks the
//     critic quorum to whichever adapter has the largest window.
//
// We do NOT key on `git rev-parse --is-shallow-repository` (it reports `true`
// even at `fetch-depth: 2`, where the parent IS reachable and the diff is
// correct) — the in-object-parent-count vs. reachable-parent gap is the
// precise signal.
export class ShallowParentError extends Error {
  constructor(public readonly sha: string) {
    super(
      `commit ${sha} records a parent in its object but the parent is not ` +
        `present in this clone (shallow boundary). The review packet would ` +
        `otherwise diff against the empty tree and send the ENTIRE repository ` +
        `to the critics, overflowing their context windows. Deepen the clone ` +
        `(set \`fetch-depth: 0\` on actions/checkout, or run ` +
        `\`git fetch --unshallow\`) so the parent commit is reachable.`,
    );
    this.name = "ShallowParentError";
  }
}

export async function safeParentOrThrow(
  sha: string,
  cwd: string = process.cwd(),
): Promise<string> {
  try {
    return await commitParent(sha, cwd);
  } catch (err) {
    // commitParent threw — either a true root (0 in-object parents, legit) or
    // a shallow boundary (≥1 in-object parent, not reachable). Disambiguate
    // via the graft-independent in-object count.
    let inObject: number;
    try {
      inObject = await parentsInObject(sha, cwd);
    } catch {
      // cat-file itself failed (e.g. the object is genuinely missing) — that
      // is a different fault than a shallow boundary; surface the original
      // commitParent error rather than mislabeling it "deepen the clone".
      throw err;
    }
    if (inObject === 0) return ""; // true root commit
    throw new ShallowParentError(sha);
  }
}

export async function commitMetadata(sha: string, cwd: string = process.cwd()): Promise<CommitMetadata> {
  // ASCII Unit Separator (0x1F) is reserved as a delimiter in git pretty-format output.
  const sep = "\x1f";
  const out = await git(
    [
      "show",
      "--no-patch",
      `--pretty=format:%H${sep}%P${sep}%an${sep}%ae${sep}%aI${sep}%s${sep}%b`,
      sha,
    ],
    { cwd },
  );
  const fields = out.split(sep);
  if (fields.length < 7) {
    throw new Error(`unexpected git show output for ${sha}`);
  }
  const parents = (fields[1] ?? "").trim().split(/\s+/).filter(Boolean);
  return {
    sha: (fields[0] ?? "").trim(),
    parent: parents[0] ?? "",
    author: fields[2] ?? "",
    email: fields[3] ?? "",
    timestamp: fields[4] ?? "",
    subject: fields[5] ?? "",
    body: (fields[6] ?? "").trimEnd(),
  };
}

export async function commitStat(
  parent: string,
  sha: string,
  cwd: string = process.cwd(),
): Promise<string> {
  if (!parent) {
    return git(["show", "--stat", "--format=", sha], { cwd });
  }
  return git(["diff", "--stat", `${parent}..${sha}`], { cwd });
}

export async function commitDiff(
  parent: string,
  sha: string,
  cwd: string = process.cwd(),
): Promise<string> {
  if (!parent) {
    return git(["show", "--patch", "--format=", sha], { cwd });
  }
  return git(["diff", "--patch", "--no-color", `${parent}..${sha}`], { cwd });
}

interface NumstatEntry {
  added: number | "binary";
  deleted: number | "binary";
  path: string;
  oldPath?: string;
}

async function numstat(
  parent: string,
  sha: string,
  cwd: string,
): Promise<Map<string, NumstatEntry>> {
  const args = parent
    ? ["diff", "--numstat", "-z", `${parent}..${sha}`]
    : ["show", "--numstat", "--format=", "-z", sha];
  const out = await git(args, { cwd });
  const map = new Map<string, NumstatEntry>();
  if (!out) return map;
  let i = 0;
  const tokens = out.split("\0");
  while (i < tokens.length) {
    const line = tokens[i++];
    if (line === undefined || line === "") continue;
    const match = /^(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const addedStr = match[1] ?? "0";
    const deletedStr = match[2] ?? "0";
    let path = match[3] ?? "";
    let oldPath: string | undefined;
    if (path === "") {
      oldPath = tokens[i++];
      path = tokens[i++] ?? "";
    }
    const entry: NumstatEntry = {
      added: addedStr === "-" ? "binary" : Number(addedStr),
      deleted: deletedStr === "-" ? "binary" : Number(deletedStr),
      path,
      ...(oldPath !== undefined ? { oldPath } : {}),
    };
    map.set(path, entry);
  }
  return map;
}

export async function changedFiles(
  parent: string,
  sha: string,
  cwd: string = process.cwd(),
  options: { maxBytes?: number; readContent?: boolean } = {},
): Promise<ChangedFile[]> {
  const args = parent
    ? ["diff", "--name-status", "-z", `${parent}..${sha}`]
    : ["show", "--name-status", "--format=", "-z", sha];
  const out = await git(args, { cwd });
  const stats = await numstat(parent, sha, cwd);
  const files: ChangedFile[] = [];
  if (!out) return files;
  const tokens = out.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (status === undefined || status === "") continue;
    const code = (status.charAt(0) ?? "X") as ChangedFileStatus;
    let oldPath: string | undefined;
    let path: string;
    if (code === "R" || code === "C") {
      oldPath = tokens[i++];
      path = tokens[i++] ?? "";
    } else {
      path = tokens[i++] ?? "";
    }
    if (!path) continue;
    const stat = stats.get(path);
    const isBinary = stat?.added === "binary" || stat?.deleted === "binary";
    const file: ChangedFile = {
      path,
      status: code,
      ...(oldPath !== undefined ? { oldPath } : {}),
    };
    if (code === "D") {
      file.omittedReason = "missing";
      files.push(file);
      continue;
    }
    if (isBinary) {
      file.omittedReason = "binary";
      files.push(file);
      continue;
    }
    if (options.readContent !== false) {
      try {
        const sizeOut = await git(["cat-file", "-s", `${sha}:${path}`], { cwd });
        const bytes = Number(sizeOut.trim());
        file.bytes = bytes;
        if (options.maxBytes !== undefined && bytes > options.maxBytes) {
          file.omittedReason = "too_large";
        } else {
          const content = await git(["show", `${sha}:${path}`], { cwd });
          file.content = content;
          file.contentHash = sha256(content);
        }
      } catch {
        file.omittedReason = "missing";
      }
    }
    files.push(file);
  }
  return files;
}

// Cycle 332 — push-delta variant of `changedFiles`. Differs from the
// per-commit walker above in three respects:
//   1. Status discovery uses `git diff --name-status --find-renames
//      --find-copies -z BASE..HEAD`. The rename / copy detection flags
//      (`-M` / `-C`) are REQUIRED — without them git only emits R*/C*
//      status records when `diff.renames=copies` is set in the repo's
//      git config, and CI's fresh `actions/checkout@v4` workspace
//      cannot rely on that. A rename push without the flags surfaces
//      as a delete + add and the Phase 2 rename/copy carry-forward
//      never fires (cycle doc Mechanism B step 3, ratified Phase 1).
//   2. The parser HARD-ERRORS on an `X` status. `X` is git's "unknown"
//      sentinel and the cache writer aborts the run rather than make a
//      guess. Per cycle doc Mechanism B step 3.
//   3. `U` (unmerged) is treated as `M` (re-evaluate) by the caller; the
//      parser preserves the `U` code so telemetry can surface it.
export class UnknownGitStatusError extends Error {
  constructor(public readonly statusRaw: string) {
    super(
      `unknown git status code; refusing to make a cache decision (raw=${JSON.stringify(statusRaw)})`,
    );
    this.name = "UnknownGitStatusError";
  }
}

export async function pushDeltaChangedFiles(
  base: string,
  head: string,
  cwd: string = process.cwd(),
): Promise<ChangedFile[]> {
  const args = base
    ? [
        "diff",
        "--name-status",
        "--find-renames",
        "--find-copies",
        "-z",
        `${base}..${head}`,
      ]
    : [
        "show",
        "--no-patch",
        "--pretty=",
        "--name-status",
        "--find-renames",
        "--find-copies",
        "-z",
        head,
      ];
  const out = await git(args, { cwd });
  return parsePushDeltaNameStatus(out);
}

// Pure parser for `git diff --name-status --find-renames --find-copies
// -z` output. Exposed as a named export so unit tests can feed
// synthetic tokens without spinning a real git repo.
//
// Token layout for a status entry:
//   - <status-token> ("A" | "M" | "D" | "R<score>" | "C<score>" |
//     "T" | "U" | "X" | unknown)
//   - For R*/C*: <oldPath-token> <newPath-token>
//   - Otherwise: <path-token>
//
// We collapse "R100" / "C75" / etc. down to the leading letter so
// downstream code matches by single-character code (and the existing
// ChangedFileStatus enum stays single-letter). The similarity score
// is informational only and is dropped on parse.
export function parsePushDeltaNameStatus(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  if (!out) return files;
  const tokens = out.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const statusRaw = tokens[i++];
    if (statusRaw === undefined || statusRaw === "") continue;
    const leading = statusRaw.charAt(0);
    let code: ChangedFileStatus;
    let oldPath: string | undefined;
    let path: string;
    switch (leading) {
      case "A":
      case "M":
      case "D":
      case "T": {
        code = leading;
        path = tokens[i++] ?? "";
        break;
      }
      case "R":
      case "C": {
        code = leading;
        oldPath = tokens[i++] ?? "";
        path = tokens[i++] ?? "";
        break;
      }
      case "U": {
        code = "U";
        path = tokens[i++] ?? "";
        break;
      }
      case "X":
      default: {
        // Cycle 332 hard-error path. Silently treating "X" as any
        // other code risks mis-keying findings and letting a parser
        // regression corrupt cross-push state.
        throw new UnknownGitStatusError(statusRaw);
      }
    }
    if (!path) continue;
    const file: ChangedFile = { path, status: code };
    if (oldPath !== undefined) file.oldPath = oldPath;
    files.push(file);
  }
  return files;
}

// Check whether a commit / ref is reachable from the current
// repository. Used by review-push's restore-side fetch-depth guard
// to decide whether the cached last_reviewed_head_sha can serve as
// the delta base, or whether to fall back to the content-hash-direct
// path (cycle doc Q3 case 2).
export async function isShaReachable(
  sha: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  try {
    await git(["rev-parse", "--verify", `${sha}^{commit}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

// Check whether a file exists at a given git ref. Used by the
// deletion-clean-coverage carry-forward branch (Q1) where the
// decision is existence-based, not hash-based.
export async function gitFileExists(
  ref: string,
  path: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  try {
    await git(["cat-file", "-e", `${ref}:${path}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

// Read commit message bodies for the commit range `base..head`. Used
// by review-push's trailer-honoring path to walk every commit in the
// delta range and pick up `Critic-Reconsider:` trailers BEFORE the
// failure-mode dispatch (cycle doc Q3).
export async function commitMessagesInRange(
  base: string,
  head: string,
  cwd: string = process.cwd(),
): Promise<string[]> {
  const args = base
    ? ["log", "--format=%B%x00", `${base}..${head}`]
    : ["log", "--format=%B%x00", head];
  const out = await git(args, { cwd });
  if (!out) return [];
  return out
    .split("\0")
    .map((m) => m.replace(/^\n+|\n+$/g, ""))
    .filter((m) => m.length > 0);
}

export function diffHash(diff: string): string {
  return `sha256:${sha256(diff)}`;
}

// Cycle 332 — re-exported under the module-private name as a named
// export so `finding-cache.ts` and tests can use the same canonical
// helper rather than re-implementing crypto. Both consumers MUST go
// through `sha256Hex` / `sha256Tagged` in `finding-cache.ts` (which
// internally call createHash directly) so the on-disk hash format
// stays consistent — exporting the bare helper here is only for
// readability when callers want the un-tagged hex form for an audit
// log.
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface PushUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
  isCreate: boolean;
  isDelete: boolean;
}

export const ZERO_SHA = "0000000000000000000000000000000000000000";

export function parsePrePushUpdates(stdin: string): PushUpdate[] {
  const updates: PushUpdate[] = [];
  for (const rawLine of stdin.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts as [
      string,
      string,
      string,
      string,
    ];
    updates.push({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
      isCreate: remoteSha === ZERO_SHA,
      isDelete: localSha === ZERO_SHA,
    });
  }
  return updates;
}

export async function commitsForPushUpdate(
  update: PushUpdate,
  cwd: string = process.cwd(),
  options: { maxCommits?: number } = {},
): Promise<string[]> {
  if (update.isDelete) return [];
  const args = update.isCreate
    ? ["rev-list", "--reverse", update.localSha, "--not", "--remotes"]
    : ["rev-list", "--reverse", `${update.remoteSha}..${update.localSha}`];
  if (options.maxCommits !== undefined) {
    args.push(`--max-count=${options.maxCommits}`);
  }
  const out = await git(args, { cwd });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
