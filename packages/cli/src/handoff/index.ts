// Agent handoff protocol — shared core (Cycle 8 Phase 8.2).
//
// This module is the single source of mechanism for the four handoff
// verbs, consumed by BOTH the `df handoff`/`df accept`/`df rehydrate`/
// `df handoffs` CLI subcommands (src/cli.ts) AND the
// `df_handoff`/`df_accept`/`df_rehydrate`/`df_handoffs` MCP tools
// (src/mcp/tools/handoff.ts) — the same split `runDoctor` (src/doctor.ts)
// uses to back `df doctor` and the `df_doctor` tool.
//
// It is a faithful TypeScript port of the dogfooded Phase 8.1 bash
// scripts (.claude/skills/handoff/scripts/*.sh in dark-factory-platform).
// The judgment layer (when to hand off, what to write, the security rule)
// lives in the skill / the two MCP prompts; this is the deterministic
// mechanism: marker-bounded PR-comment upsert, the secret-scrub, native
// baton (handoff label + assignee + PR timeline), and live-state-first
// rehydration.
//
// GitHub access shells out to `gh` exactly as the bash did (the repo's
// other GitHub touch points — git.ts, the Python services — talk to
// git/gh the same way). The `gh` runner is INJECTABLE (default = real
// `gh`) so the MCP tools, which run in-process over an in-memory
// transport, can be tested hermetically without a PATH stub or the
// network — mirroring how review-bypass takes `_internalRunReview`.
//
// Design source of truth:
//   docs/superpowers/specs/2026-05-29-agent-handoff-protocol-design.md
//   (in dark-factory-platform — Phase 8.1's spec).

import { spawn } from "node:child_process";

const MAX_BUFFER = 64 * 1024 * 1024;

export const MARKER_OPEN = "<!-- agent-context:v1 -->";
export const MARKER_CLOSE = "<!-- /agent-context:v1 -->";
export const HANDOFF_LABEL = "handoff";

// ---------------------------------------------------------------------------
// Errors + IO shims.
// ---------------------------------------------------------------------------

/**
 * Raised by the core for every operator-facing refusal/abort (the bash
 * `die`). Carries an optional `savedNotePath` so the CLI can echo where a
 * composed note was preserved when a push/gate blocked it (Decision D5 —
 * the reasoning is the precious artifact and is never discarded).
 */
export class HandoffError extends Error {
  readonly savedNotePath: string | undefined;
  constructor(message: string, savedNotePath?: string) {
    super(message);
    this.name = "HandoffError";
    this.savedNotePath = savedNotePath;
  }
}

/** Result of a `gh`/`git` invocation. `code === 0` is success. */
export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run `gh <args>`. Default impl shells out; injectable for tests. */
export type GhRunner = (
  args: readonly string[],
  options?: { input?: string },
) => Promise<ExecResult>;

/** Run `git <args>`. Default impl shells out; injectable for tests. */
export type GitRunner = (args: readonly string[]) => Promise<ExecResult>;

// We use `spawn` (not `execFile`/`promisify`) specifically because the
// upsert path pipes a JSON body to `gh api … --input -` on the child's
// STDIN. `promisify(execFile)`'s `input` option is silently dropped (it's a
// `*Sync` / `child_process.exec`-only option), which would send an EMPTY
// body to `--input -` (and hang the child waiting on EOF). `spawn` lets us
// write + end stdin deterministically. Resolves a non-zero `code` instead
// of rejecting, so callers branch on `code` uniformly (no try/catch noise).
function defaultExec(
  bin: string,
  args: readonly string[],
  options: { input?: string } = {},
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolvePromise) => {
    const child = spawn(bin, [...args], {
      stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk.toString("utf8");
      else overflow = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString("utf8");
    });
    // ENOENT (bin not on PATH) → surface code 127 (command-not-found) so
    // requireTools can tell "not installed" from "ran but failed".
    child.on("error", (err) => {
      resolvePromise({
        code: 127,
        stdout: "",
        stderr: (err as Error).message,
      });
    });
    child.on("close", (code) => {
      resolvePromise({
        code: overflow ? 1 : (code ?? 1),
        stdout,
        stderr,
      });
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // EPIPE if the child exits before reading stdin — non-fatal; the
        // close handler reports the real exit code.
      });
      child.stdin.end(options.input);
    }
  });
}

export const defaultGh: GhRunner = (args, options) =>
  defaultExec("gh", args, options ?? {});
export const defaultGit: GitRunner = (args) => defaultExec("git", args);

/**
 * Test-only: the real spawn-backed runner, exposed so a test can drive a
 * REAL subprocess (e.g. `cat`) and pin that `options.input` is actually
 * delivered to the child's stdin. The hermetic gh/git fakes can't catch a
 * regression where async `input` is silently dropped (the bug this spawn
 * impl fixes); a real-subprocess round-trip can. Not part of the public API.
 */
export const _execForTest = defaultExec;

/** A single line of operator feedback (stderr in the bash). */
export type Logger = (line: string) => void;

export interface HandoffDeps {
  readonly gh: GhRunner;
  readonly git: GitRunner;
  /** Operator-facing log/warn sink (bash wrote these to stderr). */
  readonly log: Logger;
}

export function defaultDeps(log: Logger = () => {}): HandoffDeps {
  return { gh: defaultGh, git: defaultGit, log };
}

// ---------------------------------------------------------------------------
// Tool preflight (bash require_tools).
// ---------------------------------------------------------------------------

export async function requireTools(deps: HandoffDeps): Promise<void> {
  const ghVersion = await deps.gh(["--version"]);
  if (ghVersion.code === 127) {
    throw new HandoffError(
      "gh not found — install GitHub CLI and run 'gh auth login'.",
    );
  }
  const auth = await deps.gh(["auth", "status"]);
  if (auth.code !== 0) {
    throw new HandoffError("gh not authenticated — run 'gh auth login'.");
  }
}

// ---------------------------------------------------------------------------
// PR-number validation (bash require_pr_number).
//
// Die if a PR identifier is set but not a positive integer — so the value
// is always safe to interpolate anywhere (incl. the printed
// `gh pr checkout <pr>` footer) and a malicious `/rehydrate '42; rm -rf'`
// can't produce a copy-pastable injectable command. Empty/undefined is
// allowed (the no-PR /handoff path resolves/creates the PR later).
// ---------------------------------------------------------------------------

export function requirePrNumber(pr: string | undefined): void {
  if (pr === undefined || pr === "") return; // empty allowed
  // Reject 0, leading zero, and anything non-digit.
  if (!/^[1-9][0-9]*$/.test(pr)) {
    throw new HandoffError(`PR must be a positive integer (got: '${pr}').`);
  }
}

// ---------------------------------------------------------------------------
// Secret-scrub (bash scrub_secrets + SECRET_PATTERNS).
//
// Conservative-but-real — a false refusal the author rephrases beats a
// leaked credential. Covers: key/secret assignment var-names; GitHub/Slack/
// AWS token shapes; LLM-provider keys (OpenAI sk-/sk-proj-, Anthropic
// sk-ant-, Google AIza); credentialed connection strings (scheme://u:p@h);
// well-known credential FILE PATHS; and PEM blocks (`-----BEGIN`, avoiding
// the full literal so this file stays clean against the repo's own
// secrets-scan). The scrub is a BACKSTOP for these known shapes; the
// author (guided by the prompts/skill) is the primary control.
// ---------------------------------------------------------------------------

// Mirrors lib.sh's SECRET_PATTERNS, translated to a JS regex with the `i`
// flag. `[[:space:]]` → `\s`. The leading alternative matches a
// secret-bearing variable NAME anywhere before an assignment, so embedded
// forms (`AWS_SECRET_ACCESS_KEY=` / `GITHUB_TOKEN=` / `DB_PASSWORD=`) are
// caught, not only a bare keyword-then-equals.
const SECRET_PATTERN =
  /[A-Za-z0-9_]*(?:api[_-]?key|secret|token|passwd|password|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*\s*[:=]\s*[^\s]|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@|\.(?:aws\/credentials|kube\/config|ssh\/id_[a-z0-9]+|codex\/auth\.json|config\/gcloud|docker\/config\.json|netrc|npmrc|pgpass|dockercfg)|-----BEGIN/i;

export interface ScrubResult {
  readonly clean: boolean;
  /** 1-based line numbers that matched (never the matched content). */
  readonly lines: readonly number[];
}

/**
 * Scan a note body for secret-shaped content. Returns the matching LINE
 * NUMBERS only — never the matched content (echoing it would re-surface
 * the secret in terminal/scrollback/logs). Detection is decoupled from
 * line formatting so a formatting hiccup can never cause a MISSED secret.
 */
export function scrubSecrets(body: string): ScrubResult {
  const lines = body.split("\n");
  const matched: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (SECRET_PATTERN.test(lines[i] ?? "")) {
      matched.push(i + 1);
    }
  }
  return { clean: matched.length === 0, lines: matched };
}

// ---------------------------------------------------------------------------
// Marker validation (bash validate_note_markers).
// ---------------------------------------------------------------------------

/**
 * A well-formed agent-context block has an open marker that precedes a
 * close marker. Guards against posting a malformed/partial note.
 */
export function validateNoteMarkers(body: string): boolean {
  const open = body.indexOf(MARKER_OPEN);
  const close = body.indexOf(MARKER_CLOSE);
  return open >= 0 && close >= 0 && open < close;
}

// ---------------------------------------------------------------------------
// Control-char strip for display (bash `tr -d '\000-\010\013-\037\177'`).
//
// The note body is untrusted PR-comment text. Strip control/ESC bytes
// (keep TAB \t = \x09 and LF \n = \x0a) so a hostile note can't drive the
// terminal via ANSI escapes when displayed.
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

// ---------------------------------------------------------------------------
// gh JSON helpers.
// ---------------------------------------------------------------------------

interface GhComment {
  readonly id: number;
  readonly body: string;
}

/** `gh api repos/{owner}/{repo}/issues/<pr>/comments --paginate` as JSON. */
async function listIssueComments(
  deps: HandoffDeps,
  pr: string,
): Promise<readonly GhComment[]> {
  // --paginate concatenates pages; with `--slurp` gh returns a single
  // array-of-arrays, so we flatten. Without --slurp, multiple pages emit
  // multiple JSON arrays which aren't parseable as one document. We use
  // --slurp for deterministic parsing.
  const res = await deps.gh([
    "api",
    `repos/{owner}/{repo}/issues/${pr}/comments`,
    "--paginate",
    "--slurp",
  ]);
  if (res.code !== 0) {
    throw new HandoffError(
      `gh api (list comments on #${pr}) failed: ${res.stderr.trim() || `exit ${res.code}`}`,
    );
  }
  const raw = res.stdout.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HandoffError(
      `could not parse gh comments JSON for #${pr}: ${(err as Error).message}`,
    );
  }
  // --slurp wraps the per-page arrays in an outer array → flatten one level.
  const flat: GhComment[] = [];
  const pages = Array.isArray(parsed) ? parsed : [];
  for (const page of pages) {
    if (Array.isArray(page)) {
      for (const c of page) flat.push(c as GhComment);
    } else if (page && typeof page === "object") {
      // A non-paginated single page (rare) — gh returned a flat array.
      flat.push(page as GhComment);
    }
  }
  return flat;
}

/**
 * Echo the MOST RECENT marked comment id on a PR, or undefined. There
 * should only ever be one (upsert maintains a single note); if more
 * exist, use the newest and warn. The issues/comments API returns
 * ascending by creation, so the last marked one is newest.
 */
export async function markerCommentId(
  deps: HandoffDeps,
  pr: string,
): Promise<number | undefined> {
  const comments = await listIssueComments(deps, pr);
  const marked = comments.filter((c) => c.body.includes(MARKER_OPEN));
  if (marked.length === 0) return undefined;
  if (marked.length > 1) {
    deps.log(
      "found multiple agent-context comments on this PR (expected 1) — using the most recent.",
    );
  }
  return marked[marked.length - 1]?.id;
}

/**
 * Body of the MOST RECENT marked comment on a PR (undefined if none).
 * Fetched by id so it stays consistent with upsert's most-recent target.
 */
export async function markerCommentBody(
  deps: HandoffDeps,
  pr: string,
): Promise<string | undefined> {
  const id = await markerCommentId(deps, pr);
  if (id === undefined) return undefined;
  const res = await deps.gh([
    "api",
    `repos/{owner}/{repo}/issues/comments/${id}`,
    "--jq",
    ".body",
  ]);
  if (res.code !== 0) return undefined; // non-fatal — caller decides
  return res.stdout.replace(/\n$/, "");
}

/**
 * Upsert the marked comment from a body. Returns the comment html_url.
 * If PATCH fails (e.g. HTTP 403 — the existing note was authored by
 * another identity), fall back to POSTing a fresh note + warn (spec §9).
 */
export async function upsertNote(
  deps: HandoffDeps,
  pr: string,
  body: string,
): Promise<string> {
  const id = await markerCommentId(deps, pr);
  const payload = JSON.stringify({ body });
  if (id !== undefined) {
    const patch = await deps.gh(
      [
        "api",
        "--method",
        "PATCH",
        `repos/{owner}/{repo}/issues/comments/${id}`,
        "--input",
        "-",
        "--jq",
        ".html_url",
      ],
      { input: payload },
    );
    if (patch.code === 0) return patch.stdout.trim();
    deps.log(
      `couldn't edit the existing note (id ${id}) — PATCH failed (commonly HTTP 403: the note was authored by another identity). Posting a fresh note instead.`,
    );
  }
  const post = await deps.gh(
    [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/issues/${pr}/comments`,
      "--input",
      "-",
      "--jq",
      ".html_url",
    ],
    { input: payload },
  );
  if (post.code !== 0) {
    throw new HandoffError(
      `gh api (post note on #${pr}) failed: ${post.stderr.trim() || `exit ${post.code}`}`,
    );
  }
  return post.stdout.trim();
}

/** Ensure the handoff label exists (idempotent; never fatal). */
async function ensureLabel(deps: HandoffDeps): Promise<void> {
  await deps.gh([
    "label",
    "create",
    HANDOFF_LABEL,
    "--description",
    "Work-stream handed off, awaiting pickup (agent handoff protocol)",
    "--color",
    "FBCA04",
  ]);
  // Ignore failure (already exists) — bash used `|| true`.
}

/** Open PR number for a branch, or undefined. `--state open` only. */
async function prForBranch(
  deps: HandoffDeps,
  branch: string,
): Promise<string | undefined> {
  const res = await deps.gh([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ]);
  if (res.code !== 0) return undefined;
  const n = res.stdout.trim();
  return n === "" ? undefined : n;
}

async function currentBranch(deps: HandoffDeps): Promise<string> {
  const res = await deps.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (res.code !== 0) return "HEAD";
  return res.stdout.trim() || "HEAD";
}

// ---------------------------------------------------------------------------
// /handoff — put the baton down.
// ---------------------------------------------------------------------------

export interface HandoffInput {
  /** Composed rehydration note body (with the v1 markers). */
  readonly note: string;
  /** Explicit PR number (optional). Empty/undefined → resolve from branch. */
  readonly pr?: string;
}

export interface HandoffResult {
  readonly pr: string;
  /** html_url of the upserted note comment. */
  readonly noteUrl: string;
  /** True iff `git push origin HEAD` succeeded (false when gate-blocked). */
  readonly pushed: boolean;
  /** True iff a fresh draft PR was opened (NO-PR path). */
  readonly createdDraftPr: boolean;
  /** Operator-facing warnings accumulated along the way. */
  readonly warnings: readonly string[];
}

export async function runHandoff(
  input: HandoffInput,
  deps: HandoffDeps,
): Promise<HandoffResult> {
  await requireTools(deps);
  const warnings: string[] = [];
  const explicitPr = input.pr !== undefined && input.pr !== "";

  const branch = await currentBranch(deps);
  if (branch === "HEAD" && !explicitPr) {
    throw new HandoffError(
      "detached HEAD — pass a PR number: df handoff <pr>",
    );
  }

  let pr = explicitPr ? (input.pr as string) : "";
  if (!pr) {
    pr = (await prForBranch(deps, branch)) ?? "";
  }
  // Validate BEFORE any gh use of the (possibly user-supplied) PR arg.
  requirePrNumber(pr || undefined);

  // Branch-mismatch guard: if a PR was supplied EXPLICITLY and we're not
  // detached, the note would land on that PR while `git push origin HEAD`
  // pushes the CURRENT branch. A failed lookup must NOT silently pass.
  if (explicitPr && branch !== "HEAD") {
    const view = await deps.gh([
      "pr",
      "view",
      pr,
      "--json",
      "headRefName",
      "--jq",
      ".headRefName",
    ]);
    if (view.code !== 0) {
      throw new HandoffError(
        `can't verify PR #${pr} (gh pr view failed — does it exist?); not posting blind.`,
      );
    }
    const prBranch = view.stdout.trim();
    if (prBranch !== branch) {
      throw new HandoffError(
        `PR #${pr} is for branch '${prBranch}' but you're on '${branch}' — refusing: the note would land on #${pr} while 'git push' pushes '${branch}'. Switch to '${prBranch}' or pass the matching PR.`,
      );
    }
  }

  const body = input.note;
  if (!body.trim()) {
    throw new HandoffError("empty note body — nothing to post.");
  }

  // Validate markers BEFORE any network call.
  if (!validateNoteMarkers(body)) {
    throw new HandoffError(
      `note is missing/malformed agent-context markers (need ${MARKER_OPEN} … ${MARKER_CLOSE}) — compose it per the df.handoff prompt / handoff skill.`,
    );
  }

  // Secret-scrub BEFORE any network call (the backstop control).
  const scrub = scrubSecrets(body);
  if (!scrub.clean) {
    deps.log(
      `the note appears to contain secret-shaped content at line(s): ${scrub.lines.join(",")} — refusing to post.`,
    );
    deps.log(
      "rephrase as a SETUP STEP (e.g. 'switch off the prod kube context'), never a secret value/path. See the df.handoff prompt § Security rule.",
    );
    throw new HandoffError(
      "aborted: secret-shaped content in the note (see above).",
    );
  }

  // Dirty-worktree preflight — uncommitted TRACKED changes are NOT pushed
  // by `git push origin HEAD`, so a handoff would label the PR "available"
  // while the next session rehydrates a branch MISSING that work. Refuse.
  // (Untracked files are warned about, not fatal — often scratch.)
  const unstaged = await deps.git(["diff", "--quiet"]);
  const staged = await deps.git(["diff", "--cached", "--quiet"]);
  if (unstaged.code !== 0 || staged.code !== 0) {
    throw new HandoffError(
      "uncommitted changes in the worktree — commit or stash them first, else this handoff drops them (the note points at a branch that won't have your work).",
    );
  }
  const porcelain = await deps.git([
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (
    porcelain.code === 0 &&
    porcelain.stdout.split("\n").some((l) => l.startsWith("??"))
  ) {
    warnings.push(
      "untracked files present — they won't be pushed; commit them too if they're part of this work.",
    );
    deps.log(warnings[warnings.length - 1] as string);
  }

  let noteUrl: string;
  let pushed = false;
  let createdDraftPr = false;

  if (pr) {
    // HAS-PR: post first (the note attaches regardless of the branch tip),
    // then best-effort push.
    noteUrl = await upsertNote(deps, pr, body);
    deps.log(`note posted: ${noteUrl}`);
    if (branch === "HEAD") {
      // Detached HEAD (the explicit-PR escape hatch): can't push a branch.
      const w =
        `detached HEAD — not pushing. Ensure PR #${pr}'s branch already has your commits; the note is posted on #${pr}.`;
      warnings.push(w);
      deps.log(w);
    } else {
      const push = await deps.git(["push", "origin", "HEAD"]);
      if (push.code === 0) {
        pushed = true;
      } else {
        const w =
          "branch tip is NOT on origin (push failed/blocked). Resolve the gate (make df-show COMMIT=HEAD) and push; the note is already saved on the PR.";
        warnings.push(w);
        deps.log(w);
      }
    }
  } else {
    // NO-PR: a PR is required to comment on, so the push is a hard prereq.
    const push = await deps.git(["push", "origin", "HEAD"]);
    if (push.code !== 0) {
      throw new HandoffError(
        "can't open a PR without pushing, and the push failed/was gate-blocked. Resolve the gate (make df-show COMMIT=HEAD) or open a PR manually, then re-run.",
      );
    }
    pushed = true;
    const create = await deps.gh([
      "pr",
      "create",
      "--draft",
      "--fill",
      "--head",
      branch,
    ]);
    if (create.code !== 0) {
      throw new HandoffError(
        `gh pr create failed: ${create.stderr.trim() || `exit ${create.code}`}`,
      );
    }
    const createUrl = create.stdout.trim();
    // Re-query the PR number ROBUSTLY — never parse the bare create output.
    const num = await deps.gh([
      "pr",
      "view",
      createUrl,
      "--json",
      "number",
      "--jq",
      ".number",
    ]);
    if (num.code !== 0) {
      throw new HandoffError(
        `opened a draft PR but couldn't read its number (${num.stderr.trim() || `exit ${num.code}`}).`,
      );
    }
    pr = num.stdout.trim();
    createdDraftPr = true;
    deps.log(`opened draft PR #${pr}`);
    noteUrl = await upsertNote(deps, pr, body);
    deps.log(`note posted: ${noteUrl}`);
  }

  // Put it on the stack: label + leave open (remove self as assignee).
  await ensureLabel(deps);
  const addLabel = await deps.gh([
    "pr",
    "edit",
    pr,
    "--add-label",
    HANDOFF_LABEL,
  ]);
  if (addLabel.code !== 0) {
    const w = `couldn't add the '${HANDOFF_LABEL}' label to #${pr} — the note is posted; add it manually so /handoffs lists it.`;
    warnings.push(w);
    deps.log(w);
  }
  // Putting it DOWN → open on the stack (best-effort; bash used `|| true`).
  await deps.gh(["pr", "edit", pr, "--remove-assignee", "@me"]);

  deps.log(`#${pr} is on the handoff stack (open).`);
  return { pr, noteUrl, pushed, createdDraftPr, warnings };
}

// ---------------------------------------------------------------------------
// /handoffs — list the stack.
// ---------------------------------------------------------------------------

export interface HandoffStackEntry {
  readonly number: number;
  readonly title: string;
  readonly branch: string;
  /** GitHub login of the current owner, or undefined when OPEN. */
  readonly owner: string | undefined;
  readonly updatedAt: string;
}

export interface HandoffsResult {
  readonly entries: readonly HandoffStackEntry[];
}

export async function runHandoffs(deps: HandoffDeps): Promise<HandoffsResult> {
  await requireTools(deps);
  const res = await deps.gh([
    "pr",
    "list",
    "--label",
    HANDOFF_LABEL,
    "--state",
    "open",
    "--json",
    "number,title,headRefName,assignees,updatedAt",
  ]);
  if (res.code !== 0) {
    throw new HandoffError(
      `gh pr list (handoff stack) failed: ${res.stderr.trim() || `exit ${res.code}`}`,
    );
  }
  const raw = res.stdout.trim();
  if (!raw) return { entries: [] };
  let parsed: Array<{
    number: number;
    title: string;
    headRefName: string;
    assignees: Array<{ login: string }>;
    updatedAt: string;
  }>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HandoffError(
      `could not parse gh pr list JSON: ${(err as Error).message}`,
    );
  }
  const entries = parsed
    .slice()
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map((p) => ({
      number: p.number,
      title: p.title,
      branch: p.headRefName,
      owner: p.assignees.length > 0 ? p.assignees[0]?.login : undefined,
      updatedAt: p.updatedAt,
    }));
  return { entries };
}

// ---------------------------------------------------------------------------
// /rehydrate — read-only catch-up. NO ownership change.
// ---------------------------------------------------------------------------

export interface RehydrateInput {
  /** Explicit PR (optional). Empty/undefined → resolve from branch. */
  readonly pr?: string;
}

export interface RehydrateResult {
  readonly pr: string;
  /** Script-derived live state line(s) — the AUTHORITATIVE truth. */
  readonly liveState: string;
  /** `gh pr checks` output (informational; non-zero == checks failing). */
  readonly checks: string;
  /** Most-recent note body, control-chars stripped. undefined if none. */
  readonly note: string | undefined;
  /** The `gh pr checkout <pr>` footer (script-resolved PR number). */
  readonly checkoutHint: string;
}

export async function runRehydrate(
  input: RehydrateInput,
  deps: HandoffDeps,
): Promise<RehydrateResult> {
  await requireTools(deps);
  let pr = input.pr ?? "";
  if (!pr) {
    pr = (await prForBranch(deps, await currentBranch(deps))) ?? "";
  }
  if (!pr) {
    throw new HandoffError(
      "no PR for this branch — pass one: df rehydrate <pr>.",
    );
  }
  requirePrNumber(pr);

  // STEP ZERO — derive LIVE state FIRST (Commitment 5), with
  // SCRIPT-CONTROLLED, fixed commands keyed off the resolved PR. This runs
  // BEFORE the note fetch so a transient comments-API failure can never
  // stop the operator from seeing the authoritative PR state. We never
  // execute commands transcribed from a PR comment (injection vector).
  const view = await deps.gh([
    "pr",
    "view",
    pr,
    "--json",
    "title,headRefName,mergeStateStatus,reviewDecision,statusCheckRollup",
    "--jq",
    '"  \\(.title)\\n  branch:    \\(.headRefName)\\n  mergeable: \\(.mergeStateStatus)   review: \\(.reviewDecision)"',
  ]);
  // The live-state query is AUTHORITATIVE — do NOT suppress its failure (a
  // silent blank would let the operator proceed on the note alone).
  if (view.code !== 0) {
    throw new HandoffError(
      `could not derive live state for #${pr} (gh error) — fix gh/network and retry; do not proceed on the note alone.`,
    );
  }
  const liveState = view.stdout.replace(/\n$/, "");

  const checksRes = await deps.gh(["pr", "checks", pr]);
  // Non-zero == checks failing (informational), not a script error.
  const checks = checksRes.stdout.replace(/\n$/, "");

  // Now fetch the MOST RECENT marked comment (consistent with upsert).
  // Non-fatal: live state is already derived above.
  let note: string | undefined;
  try {
    const raw = await markerCommentBody(deps, pr);
    note = raw !== undefined ? stripControlChars(raw) : undefined;
  } catch {
    note = undefined; // note-fetch failure is context loss, not a hard error
  }

  return {
    pr,
    liveState,
    checks,
    ...(note !== undefined ? { note } : {}),
    checkoutHint: `gh pr checkout ${pr}`,
  } as RehydrateResult;
}

// ---------------------------------------------------------------------------
// /accept — take the baton: claim ownership natively, then rehydrate.
// ---------------------------------------------------------------------------

export interface AcceptInput {
  readonly pr: string;
}

export interface AcceptResult {
  readonly pr: string;
  /** True iff the handoff label was present and removed. */
  readonly removedLabel: boolean;
  readonly warnings: readonly string[];
  /** The contained rehydrate (accept CONTAINS rehydrate). */
  readonly rehydrate: RehydrateResult;
}

export async function runAccept(
  input: AcceptInput,
  deps: HandoffDeps,
): Promise<AcceptResult> {
  await requireTools(deps);
  const pr = input.pr;
  if (!pr) {
    throw new HandoffError(
      "which one? run df handoffs to see the stack, then df accept <pr>.",
    );
  }
  requirePrNumber(pr);

  const warnings: string[] = [];

  const assign = await deps.gh(["pr", "edit", pr, "--add-assignee", "@me"]);
  if (assign.code !== 0) {
    throw new HandoffError(
      `could not assign yourself to #${pr}: ${assign.stderr.trim() || `exit ${assign.code}`}`,
    );
  }

  // Three distinct cases: (a) label-query gh error → say so; (b) label
  // present → remove it; (c) label absent → "wasn't on the stack".
  let removedLabel = false;
  const labelsRes = await deps.gh([
    "pr",
    "view",
    pr,
    "--json",
    "labels",
    "--jq",
    ".labels[].name",
  ]);
  if (labelsRes.code === 0) {
    const labels = labelsRes.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (labels.includes(HANDOFF_LABEL)) {
      const rm = await deps.gh([
        "pr",
        "edit",
        pr,
        "--remove-label",
        HANDOFF_LABEL,
      ]);
      if (rm.code === 0) {
        removedLabel = true;
      } else {
        const w = `couldn't remove the '${HANDOFF_LABEL}' label from #${pr} (gh error) — you're assigned; verify with df handoffs.`;
        warnings.push(w);
        deps.log(w);
      }
    } else {
      const w = `#${pr} wasn't on the handoff stack (no '${HANDOFF_LABEL}' label) — assigning you anyway.`;
      warnings.push(w);
      deps.log(w);
    }
  } else {
    const w = `couldn't check #${pr}'s labels (gh error) — you're assigned; verify the stack with df handoffs.`;
    warnings.push(w);
    deps.log(w);
  }
  deps.log(`accepted #${pr} — assigned to you. Rehydrating…`);

  // accept CONTAINS rehydrate.
  const rehydrate = await runRehydrate({ pr }, deps);
  return { pr, removedLabel, warnings, rehydrate };
}
