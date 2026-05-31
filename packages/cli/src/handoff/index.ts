// Agent handoff protocol — shared core (Cycle 12 — Issue-anchored).
//
// This module is the single source of mechanism for the four handoff
// verbs, consumed by BOTH the `df handoff`/`df accept`/`df rehydrate`/
// `df handoffs` CLI subcommands (src/cli.ts) AND the
// `df_handoff`/`df_accept`/`df_rehydrate`/`df_handoffs` MCP tools
// (src/mcp/tools/handoff.ts).
//
// It is a faithful TypeScript port of the Phase 12.1 bash scripts in
// dark-factory-platform (.claude/skills/handoff/scripts/*.sh) — the
// battle-tested source of truth for behaviour. Cycle 12 supersedes
// Cycle 8: the anchor object changed from a PR comment to a dedicated
// GitHub Issue body, the verb shape became
// `df handoff [issue] [--link <ref>]... [--unlink <ref>]... [--new]`,
// and the lifecycle is upsert-on-handoff / close-on-accept (Commitment
// 10). The four verb names are unchanged.
//
// GitHub access shells out to `gh` exactly as the bash did. The `gh`
// runner is INJECTABLE (default = real `gh`) so the MCP tools, which
// run in-process over an in-memory transport, can be tested
// hermetically without a PATH stub or the network — mirroring how
// review-bypass takes `_internalRunReview`.
//
// Design source of truth (in dark-factory-platform):
//   docs/roadmap/cycles/cycle12-agent-handoff-v2-issue-anchor.md
//   docs/superpowers/specs/2026-05-30-agent-handoff-v2-issue-anchor-design.md

import { spawn } from "node:child_process";

const MAX_BUFFER = 64 * 1024 * 1024;

export const MARKER_OPEN = "<!-- agent-context:v1 -->";
export const MARKER_CLOSE = "<!-- /agent-context:v1 -->";
export const HANDOFF_LABEL = "handoff";

/** Closed-handoff lookback window for no-arg /rehydrate tier 2 (spec §4.4). */
export const REHYDRATE_CLOSED_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Errors + IO shims.
// ---------------------------------------------------------------------------

/**
 * Raised by the core for every operator-facing refusal/abort (the bash
 * `die`). Carries an optional `savedNotePath` so the CLI can echo where a
 * composed note was preserved when a push/gate blocked it.
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
// upsert path pipes a body to `gh issue edit … --body-file -` on the
// child's STDIN. `promisify(execFile)`'s `input` option is silently
// dropped (it's a `*Sync` / `child_process.exec`-only option), which
// would send an EMPTY body to `--body-file -` (and hang the child
// waiting on EOF). `spawn` lets us write + end stdin deterministically.
// Resolves a non-zero `code` instead of rejecting, so callers branch on
// `code` uniformly (no try/catch noise).
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
// Issue-number validation (bash require_issue_number).
//
// Die if an issue identifier is set but not a positive integer — so the
// value is always safe to interpolate anywhere and a malicious
// `/rehydrate '42; rm -rf'` can't produce a copy-pastable injectable
// command. Empty/undefined is allowed (the no-arg paths resolve later).
// ---------------------------------------------------------------------------

export function requireIssueNumber(issue: string | undefined): void {
  if (issue === undefined || issue === "") return; // empty allowed
  // Reject 0, leading zero, and anything non-digit.
  if (!/^[1-9][0-9]*$/.test(issue)) {
    throw new HandoffError(
      `issue must be a positive integer (got: '${issue}').`,
    );
  }
}

// ---------------------------------------------------------------------------
// Argv safety (bash require_safe_args).
//
// Defense-in-depth: refuse any argv token containing a character outside the
// allow-list (alphanumeric, /, #, :, ., ,, @, -, _, ?, =, %, +, ~, and
// whitespace). The .md slash-command entrypoints pass `"$ARGUMENTS"` as ONE
// quoted token; the CLI splits it itself and the MCP tools receive typed
// strings — but a payload like `42; rm -rf /` or `$(rm -rf /)` is rejected
// here regardless of input path.
// ---------------------------------------------------------------------------

const SAFE_ARG_PATTERN = /^[a-zA-Z0-9_/#:.,@?=%+~ -]*$/;

export function requireSafeArgs(...args: string[]): void {
  for (const arg of args) {
    if (!SAFE_ARG_PATTERN.test(arg)) {
      throw new HandoffError(
        "argument contains disallowed characters: refusing for safety (allowed: alphanumeric / # : . , @ - _ ? = % + ~ space).",
      );
    }
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

/**
 * Scrub a single string (used for linked PR/issue titles fetched live
 * from `gh pr view --json title`). Mirrors `scrubSecrets`'s refusal
 * contract: no value echo on match. Returns true = clean, false =
 * matched (and logs the refusal).
 */
export function scrubSecretsInString(
  s: string,
  label: string,
  deps: HandoffDeps,
): boolean {
  if (SECRET_PATTERN.test(s)) {
    deps.log(
      `aborted: secret-shaped content in ${label} — rephrase the source (e.g. \`gh pr edit <N> --title …\`) so the handoff body stays scrubable. (No value echo — see SKILL.md § Security rule.)`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Marker validation (bash validate_note_markers + validate_latest_block).
// ---------------------------------------------------------------------------

/**
 * A well-formed agent-context block has an open marker that precedes a
 * close marker. Guards against posting a malformed/partial note. Used by
 * /handoff against the operator's stdin note (single-block by
 * construction).
 */
export function validateNoteMarkers(body: string): boolean {
  const open = body.indexOf(MARKER_OPEN);
  const close = body.indexOf(MARKER_CLOSE);
  return open >= 0 && close >= 0 && open < close;
}

/**
 * Validate that the LAST agent-context block in a body is well-formed.
 * Used by /accept against the issue body (which may carry past blocks
 * from prior /handoff runs). Semantics must match the LATEST-block
 * extractor (`extractLinkedItems` + the rehydrate reasoning extractor)
 * so accept never closes a handoff whose reasoning artifact rehydrate
 * would fail to display.
 */
export function validateLatestBlock(body: string): boolean {
  const lines = body.split("\n");
  let lastOpen = 0; // 1-based; 0 = not seen
  let lastClose = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes(MARKER_OPEN)) lastOpen = i + 1;
    if (line.includes(MARKER_CLOSE)) lastClose = i + 1;
  }
  return lastOpen > 0 && lastClose > lastOpen;
}

// ---------------------------------------------------------------------------
// Control-char strip for display (bash `tr -d '\000-\010\013-\037\177'`).
//
// The issue body is operator-influenceable text. Strip control/ESC bytes
// (keep TAB \t = \x09 and LF \n = \x0a) so a hostile body can't drive
// the terminal via ANSI escapes when displayed.
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, "");
}

// ---------------------------------------------------------------------------
// Repo helpers (bash current_branch).
// ---------------------------------------------------------------------------

async function currentBranch(deps: HandoffDeps): Promise<string> {
  const res = await deps.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (res.code !== 0) return "HEAD";
  return res.stdout.trim() || "HEAD";
}

/** Open PR number for a branch, or undefined. `--state open` only. */
async function openPrForBranch(
  deps: HandoffDeps,
  branch: string,
): Promise<{ number: string; title: string } | undefined> {
  const res = await deps.gh([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number,title",
  ]);
  if (res.code !== 0) return undefined;
  const raw = res.stdout.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
  const first = parsed[0] as { number?: number; title?: string };
  if (typeof first?.number !== "number") return undefined;
  return {
    number: String(first.number),
    title: typeof first.title === "string" ? first.title : "",
  };
}

/** Ensure the handoff label exists (idempotent; never fatal). Gray per spec §4.1. */
async function ensureLabel(deps: HandoffDeps): Promise<void> {
  await deps.gh([
    "label",
    "create",
    HANDOFF_LABEL,
    "--description",
    "Agent handoff (Cycle 12 protocol)",
    "--color",
    "cccccc",
  ]);
  // Ignore failure (already exists) — bash used `|| true`.
}

// ---------------------------------------------------------------------------
// @me login cache (bash me_login + ME_LOGIN_CACHE).
// ---------------------------------------------------------------------------

let MeLoginCache: string | undefined;

/**
 * The real GitHub login behind `@me`. Cached so repeated callers share
 * one API hit. Used to evaluate the "assignees == [@me]" predicate.
 */
export async function meLogin(deps: HandoffDeps): Promise<string> {
  if (MeLoginCache !== undefined && MeLoginCache !== "") return MeLoginCache;
  const res = await deps.gh(["api", "user", "--jq", ".login"]);
  if (res.code !== 0) {
    throw new HandoffError(
      "could not determine @me's login (gh api user failed) — run 'gh auth status'.",
    );
  }
  const login = res.stdout.trim();
  if (login === "") {
    throw new HandoffError(
      "could not determine @me's login (gh api user failed) — run 'gh auth status'.",
    );
  }
  MeLoginCache = login;
  return login;
}

/** Test-only: clear the meLogin cache between vitest cases. */
export function _resetMeLoginCacheForTest(): void {
  MeLoginCache = undefined;
}

// ---------------------------------------------------------------------------
// Assignees predicates (bash assignees_status + assignees_other_csv).
// ---------------------------------------------------------------------------

export type AssigneesStatus = "empty" | "me" | "other";

/**
 * Classify an issue's assignees set against @me.
 *   empty  → no assignees      (available on the stack)
 *   me     → exactly [@me]     (same-actor update / close-failure retry)
 *   other  → any non-empty set ≠ [@me] (refuse/abort per §4.1, §4.3 step 4)
 */
export function assigneesStatus(
  assignees: ReadonlyArray<{ login: string }>,
  meLoginValue: string,
): AssigneesStatus {
  if (assignees.length === 0) return "empty";
  if (assignees.length === 1 && assignees[0]?.login === meLoginValue) {
    return "me";
  }
  return "other";
}

/** Comma-joined list of non-@me assignees (for refuse messages). */
export function assigneesOtherCsv(
  assignees: ReadonlyArray<{ login: string }>,
  meLoginValue: string,
): string {
  return assignees
    .map((a) => a.login)
    .filter((l) => l !== meLoginValue)
    .join(",");
}

// ---------------------------------------------------------------------------
// Body splicing (bash splice_agent_context_block).
// ---------------------------------------------------------------------------

/**
 * Splice an agent-context block into an existing issue body.
 * If oldBody contains the markers (one or more blocks), the FIRST open
 * marker through the LAST close marker is replaced by newBlock in-place
 * (idempotent for the normal one-block case; fixes operator-error
 * multi-blocks). If markers absent, newBlock is appended (preserving any
 * operator-added text). Body text outside the markers is preserved.
 */
export function spliceAgentContextBlock(
  oldBody: string,
  newBlock: string,
): string {
  const lines = oldBody.split("\n");
  let firstOpen = -1;
  let lastClose = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (firstOpen < 0 && line.includes(MARKER_OPEN)) firstOpen = i;
    if (line.includes(MARKER_CLOSE)) lastClose = i;
  }
  if (firstOpen < 0 || lastClose < 0 || lastClose < firstOpen) {
    // No well-formed marker pair — append (preserves operator-added text).
    if (oldBody.length === 0) return newBlock;
    const sep = oldBody.endsWith("\n") ? "\n" : "\n\n";
    return `${oldBody}${sep}${newBlock}`;
  }
  const pre = lines.slice(0, firstOpen);
  const post = lines.slice(lastClose + 1);
  const newBlockLines = newBlock.split("\n");
  return [...pre, ...newBlockLines, ...post].join("\n");
}

// ---------------------------------------------------------------------------
// Link-ref canonicalization + resolution
// (bash canonicalize_link_ref + resolve_link_ref).
// ---------------------------------------------------------------------------

export interface CanonicalLinkRef {
  /** "" = no type hint (bare number); "pr" or "issue" otherwise. */
  readonly kind: "" | "pr" | "issue";
  readonly display: string;
}

/**
 * Canonicalize a link ref to (kind, display) WITHOUT any gh fetch.
 * Used by --unlink (which doesn't need to fetch a title — it just needs
 * to match an existing entry's canonical display ref).
 */
export function canonicalizeLinkRef(ref: string): CanonicalLinkRef {
  let kind: "" | "pr" | "issue" = "";
  let working = ref;
  if (working.startsWith("pr:")) {
    kind = "pr";
    working = working.slice("pr:".length);
  } else if (working.startsWith("issue:")) {
    kind = "issue";
    working = working.slice("issue:".length);
  }

  // URL forms
  const pullM = working.match(
    /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/,
  );
  if (pullM) {
    return { kind: "pr", display: `${pullM[1]}#${pullM[2]}` };
  }
  const issueM = working.match(
    /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/(\d+)/,
  );
  if (issueM) {
    return { kind: "issue", display: `${issueM[1]}#${issueM[2]}` };
  }

  // owner/repo#N
  if (working.includes("#")) {
    const hashIdx = working.indexOf("#");
    const ownerRepo = working.slice(0, hashIdx);
    const number = working.slice(hashIdx + 1);
    return { kind, display: `${ownerRepo}#${number}` };
  }

  // bare number
  return { kind, display: `#${working}` };
}

export interface ResolvedLinkRef {
  readonly kind: "pr" | "issue";
  readonly display: string;
  readonly title: string;
}

interface ResolvedRefParts {
  kind: "" | "pr" | "issue";
  ownerRepo: string;
  number: string;
  display: string;
}

function parseRefForResolve(ref: string): ResolvedRefParts {
  let kind: "" | "pr" | "issue" = "";
  let working = ref;
  if (working.startsWith("pr:")) {
    kind = "pr";
    working = working.slice("pr:".length);
  } else if (working.startsWith("issue:")) {
    kind = "issue";
    working = working.slice("issue:".length);
  }

  const pullM = working.match(
    /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/,
  );
  if (pullM) {
    return {
      kind: "pr",
      ownerRepo: pullM[1] ?? "",
      number: pullM[2] ?? "",
      display: `${pullM[1]}#${pullM[2]}`,
    };
  }
  const issueM = working.match(
    /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/(\d+)/,
  );
  if (issueM) {
    return {
      kind: "issue",
      ownerRepo: issueM[1] ?? "",
      number: issueM[2] ?? "",
      display: `${issueM[1]}#${issueM[2]}`,
    };
  }
  if (working.includes("#")) {
    const hashIdx = working.indexOf("#");
    const ownerRepo = working.slice(0, hashIdx);
    const number = working.slice(hashIdx + 1);
    return { kind, ownerRepo, number, display: `${ownerRepo}#${number}` };
  }
  return { kind, ownerRepo: "", number: working, display: `#${working}` };
}

/**
 * Resolve a link ref to (kind, display, title). PR-first resolution per
 * spec §3 (a bare 42 is a PR if it resolves; else tried as an issue).
 * Cross-repo `owner/repo#N` supported. A `pr:N` / `issue:N` prefix
 * short-circuits auto-detection. Refuses handoff-labeled issue targets
 * (no link-cycles between handoff issues).
 */
export async function resolveLinkRef(
  ref: string,
  deps: HandoffDeps,
): Promise<ResolvedLinkRef> {
  // Project URLs: explicitly refused per spec §3 (deferred to Phase 12.2).
  const projectsM = ref.match(/^https?:\/\/[^/]+\/.*\/projects\//);
  if (projectsM) {
    throw new HandoffError(
      `link ref '${ref}': GitHub project-item linkage is DEFERRED to Phase 12.2 (spec §3 / OQ-12.7). For Phase 12.1, link PRs and issues only.`,
    );
  }

  const parts = parseRefForResolve(ref);

  if (parts.number === "" || !/^[0-9]+$/.test(parts.number)) {
    throw new HandoffError(
      `link ref '${ref}' is not a number, owner/repo#N, or supported URL (pull/issues).`,
    );
  }
  if (!/^[1-9][0-9]*$/.test(parts.number)) {
    throw new HandoffError(
      `link ref '${ref}' must reference a positive integer (got '${parts.number}').`,
    );
  }

  const viewArgs: string[] = [];
  if (parts.ownerRepo) viewArgs.push("--repo", parts.ownerRepo);

  let title = "";
  let kind: "pr" | "issue" | undefined;

  // PR-first (bash order is load-bearing — case 33).
  if (parts.kind === "" || parts.kind === "pr") {
    const prRes = await deps.gh([
      "pr",
      "view",
      parts.number,
      ...viewArgs,
      "--json",
      "title",
      "--jq",
      ".title",
    ]);
    if (prRes.code === 0) {
      const t = prRes.stdout.trim();
      if (t !== "") {
        title = t;
        kind = "pr";
      }
    }
  }

  if (title === "" && (parts.kind === "" || parts.kind === "issue")) {
    const issueRes = await deps.gh([
      "issue",
      "view",
      parts.number,
      ...viewArgs,
      "--json",
      "title,labels",
    ]);
    if (issueRes.code === 0) {
      let parsed: { title?: string; labels?: Array<{ name?: string }> };
      try {
        parsed = JSON.parse(issueRes.stdout);
      } catch {
        parsed = {};
      }
      const labels = (parsed.labels ?? []).map((l) => l.name);
      if (labels.includes(HANDOFF_LABEL)) {
        throw new HandoffError(
          `refusing to link handoff issue ${parts.display} (no link-cycles between handoff issues).`,
        );
      }
      kind = "issue";
      title = typeof parsed.title === "string" ? parsed.title : "";
    }
  }

  if (title === "" || kind === undefined) {
    const where = parts.ownerRepo || "this repo";
    throw new HandoffError(
      `ref '${ref}' not found as PR or Issue in ${where}.`,
    );
  }

  return { kind, display: parts.display, title };
}

// ---------------------------------------------------------------------------
// Linked-items extraction (bash extract_linked_items).
// ---------------------------------------------------------------------------

/**
 * Extract the `- (pr|issue) <ref> — <title>` entries from the LATEST
 * agent-context block's `**Linked work items:**` section. Returns one
 * entry per element (no trailing newline). Outputs nothing when there's
 * no well-formed marker block or no linked-items section within it.
 */
export function extractLinkedItems(body: string): readonly string[] {
  const lines = body.split("\n");
  let lastOpen = -1;
  let lastClose = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.includes(MARKER_OPEN)) lastOpen = i;
    if (line.includes(MARKER_CLOSE)) lastClose = i;
  }
  if (lastOpen < 0 || lastClose <= lastOpen) return [];
  const out: string[] = [];
  let inBlk = false;
  for (let i = lastOpen; i <= lastClose; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("**Linked work items:**")) {
      inBlk = true;
      continue;
    }
    if (!inBlk) continue;
    if (/^- (pr|issue) /.test(line)) {
      out.push(line);
      continue;
    }
    if (/^_None linked\._/.test(line)) continue;
    if (/^\s*$/.test(line)) continue;
    // Anything else ends the section.
    inBlk = false;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Age + ISO helpers (bash format_age + normalize_iso + iso_to_epoch).
// ---------------------------------------------------------------------------

/** Coarse relative age string: "just now" / "Nm ago" / "Nh ago" / "Nd ago". */
export function formatAge(epochSec: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - epochSec;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Normalize an ISO-8601 timestamp to the canonical `YYYY-MM-DDTHH:MM:SSZ`
 * form. Strip fractional seconds; treat any numeric offset as already UTC.
 */
export function normalizeIso(s: string): string {
  return s
    .replace(/\.[0-9]+(Z|[+-][0-9]{2}:?[0-9]{2})?$/, (_, suffix) => suffix ?? "")
    .replace(/[+-][0-9]{2}:?[0-9]{2}$/, "Z");
}

/**
 * Convert an ISO-8601 timestamp to epoch seconds. Returns undefined on
 * parse failure — callers must distinguish "before cutoff" from
 * "unparseable" (the rehydrate tier-2 path treats unparseable as
 * "skip with a warn", NEVER as "pre-cutoff", which would silently
 * default to "don't fall back").
 */
export function isoToEpoch(s: string): number | undefined {
  const norm = normalizeIso(s);
  if (norm === "") return undefined;
  const ms = Date.parse(norm);
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 1000);
}

// ---------------------------------------------------------------------------
// Shared do_rehydrate (bash do_rehydrate).
//
// Used by runRehydrate (strict=false; per-item annotated, exit 0 on
// partial unreachability) AND by runAccept step 3 (strict=true; any
// unreachable aborts the chain so the issue stays on the stack).
// ---------------------------------------------------------------------------

interface IssueViewForRehydrate {
  number: number;
  title: string;
  state: string;
  assignees: Array<{ login: string }>;
  labels: Array<{ name: string }>;
  closedAt: string | null;
  updatedAt: string;
  body: string;
}

/**
 * Result of doRehydrate. `text` is the pre-rendered stdout block (live
 * state header + linked items + reasoning); `hasUnreachable` is true iff
 * at least one linked work item was unreachable (informational for
 * strict=false; promoted to a hard error in strict=true).
 */
export interface RehydrateResult {
  readonly issue: string;
  readonly text: string;
  readonly hasUnreachable: boolean;
}

export async function doRehydrate(
  issue: string,
  strict: boolean,
  deps: HandoffDeps,
): Promise<RehydrateResult> {
  const viewRes = await deps.gh([
    "issue",
    "view",
    issue,
    "--json",
    "number,title,state,assignees,labels,closedAt,updatedAt,body",
  ]);
  if (viewRes.code !== 0) {
    throw new HandoffError(
      `could not derive live state for #${issue} (gh issue view failed) — fix gh/network and retry; do not proceed on the note alone.`,
    );
  }
  let view: IssueViewForRehydrate;
  try {
    view = JSON.parse(viewRes.stdout);
  } catch (err) {
    throw new HandoffError(
      `could not parse issue view JSON for #${issue}: ${(err as Error).message}`,
    );
  }

  const out: string[] = [];
  out.push(
    `=== handoff #${issue} — LIVE STATE (script-derived; this is the truth, not the note) ===`,
  );
  // Title is operator-editable; strip control bytes before printing.
  out.push(`  ${stripControlChars(view.title ?? "")}`);

  if (view.state === "CLOSED") {
    const closedAt = view.closedAt ?? "";
    if (closedAt !== "") {
      const day = closedAt.slice(0, 10);
      out.push(`  state: closed (accepted ${day})`);
    } else {
      out.push(`  state: closed`);
    }
  } else {
    const assignees = (view.assignees ?? []).map((a) => a.login).join(",");
    if (assignees !== "") {
      out.push(`  state: open (assigned ${assignees})`);
    } else {
      out.push(`  state: open (unassigned — on the stack)`);
    }
  }

  const links = extractLinkedItems(view.body ?? "");
  let linkFailures = 0;

  if (links.length > 0) {
    out.push("  --- linked work items ---");
    for (const entry of links) {
      // Entry shape: `- (pr|issue) <ref> — <title>`
      const m = entry.match(/^- (pr|issue) ([^ ]+) — (.*)$/);
      if (!m) {
        // Should be unreachable given extractLinkedItems's filter; skip.
        continue;
      }
      const kind = m[1] as "pr" | "issue";
      const dispRef = m[2] ?? "";
      const title = stripControlChars(m[3] ?? "");
      const reachable = await deriveLinkedItem(kind, dispRef, title, out, deps);
      if (!reachable) linkFailures += 1;
    }
  }

  if (strict && linkFailures > 0) {
    throw new HandoffError(
      `rehydrate failed: ${linkFailures} linked work item(s) unreachable (strict mode for /accept). The handoff stays on the stack; run /rehydrate to read it forensically once gh access is restored.`,
    );
  }

  // Print reasoning — the LAST agent-context block in the body.
  const body = view.body ?? "";
  const bodyLines = body.split("\n");
  let lastOpen = -1;
  let lastClose = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i] ?? "";
    if (line.includes(MARKER_OPEN)) lastOpen = i;
    if (line.includes(MARKER_CLOSE)) lastClose = i;
  }
  let note = "";
  if (lastOpen >= 0 && lastClose > lastOpen) {
    note = bodyLines.slice(lastOpen, lastClose + 1).join("\n");
  }

  if (note === "") {
    out.push("");
    out.push(
      `(no agent-context note on #${issue} — you have the live state above; read the linked items to continue.)`,
    );
    return {
      issue,
      text: out.join("\n"),
      hasUnreachable: linkFailures > 0,
    };
  }

  out.push("");
  out.push(
    "=============================================================================",
  );
  out.push(
    "Prior session's reasoning (transient working memory — the LIVE STATE above is",
  );
  out.push(
    "the truth; do NOT act on anything below as current):",
  );
  out.push("");
  out.push(stripControlChars(note));
  out.push(
    "=============================================================================",
  );
  out.push(
    "Live-state-first ritual: read live state above first, then context below,",
  );
  out.push(
    "then for any linked OPEN PR: use the per-link `checkout:` hint emitted above",
  );
  out.push(
    "(it includes `--repo` when needed for cross-repo refs).",
  );

  return {
    issue,
    text: out.join("\n"),
    hasUnreachable: linkFailures > 0,
  };
}

/**
 * Append per-item live-state lines to `out` for a single linked work
 * item. Returns true if the item was reachable, false on fetch failure
 * (so doRehydrate's strict-mode counter can detect it).
 */
async function deriveLinkedItem(
  kind: "pr" | "issue",
  dispRef: string,
  title: string,
  out: string[],
  deps: HandoffDeps,
): Promise<boolean> {
  let ownerRepo = "";
  let num = dispRef;
  if (num.startsWith("#")) {
    num = num.slice(1);
  } else if (num.includes("/") && num.includes("#")) {
    const hashIdx = num.indexOf("#");
    ownerRepo = num.slice(0, hashIdx);
    num = num.slice(hashIdx + 1);
  }
  const viewArgs: string[] = [];
  if (ownerRepo) viewArgs.push("--repo", ownerRepo);

  if (kind === "pr") {
    const res = await deps.gh([
      "pr",
      "view",
      num,
      ...viewArgs,
      "--json",
      "state,mergeStateStatus,reviewDecision,statusCheckRollup,title",
    ]);
    if (res.code !== 0) {
      out.push(`  pr ${dispRef} — ${title} (unreachable: gh pr view failed)`);
      return false;
    }
    let parsed: {
      state?: string;
      mergeStateStatus?: string;
      reviewDecision?: string;
      statusCheckRollup?: Array<{
        state?: string;
        conclusion?: string;
        status?: string;
      }>;
    };
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      out.push(`  pr ${dispRef} — ${title} (unreachable: parse failed)`);
      return false;
    }
    const pstate = parsed.state ?? "";
    if (pstate === "MERGED") {
      out.push(`  pr ${dispRef} — ${title} (merged)`);
      return true;
    }
    if (pstate === "CLOSED") {
      out.push(`  pr ${dispRef} — ${title} (closed)`);
      return true;
    }
    const pmerge = parsed.mergeStateStatus ?? "";
    const preview = parsed.reviewDecision ?? "";
    const rollup = parsed.statusCheckRollup ?? [];
    let checksSummary: string;
    if (rollup.length === 0) {
      checksSummary = "no checks";
    } else {
      const buckets = new Map<string, number>();
      for (const r of rollup) {
        const bucket = (r.conclusion ?? r.state ?? "UNKNOWN").toLowerCase();
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      }
      checksSummary = [...buckets.entries()]
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
    }
    out.push(
      `  pr ${dispRef} — ${title} [mergeable: ${pmerge}, review: ${preview}, checks: ${checksSummary}]`,
    );
    if (ownerRepo) {
      out.push(`              checkout: gh pr checkout ${num} --repo ${ownerRepo}`);
    } else {
      out.push(`              checkout: gh pr checkout ${num}`);
    }
    return true;
  }

  // issue
  const res = await deps.gh([
    "issue",
    "view",
    num,
    ...viewArgs,
    "--json",
    "state,assignees,title",
  ]);
  if (res.code !== 0) {
    out.push(`  issue ${dispRef} — ${title} (unreachable: gh issue view failed)`);
    return false;
  }
  let parsed: { state?: string; assignees?: Array<{ login: string }> };
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    out.push(`  issue ${dispRef} — ${title} (unreachable: parse failed)`);
    return false;
  }
  const istate = parsed.state ?? "";
  if (istate === "CLOSED") {
    out.push(`  issue ${dispRef} — ${title} (closed)`);
    return true;
  }
  const ass = (parsed.assignees ?? []).map((a) => a.login).join(",");
  if (ass !== "") {
    out.push(`  issue ${dispRef} — ${title} [open, assigned ${ass}]`);
  } else {
    out.push(`  issue ${dispRef} — ${title} [open]`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// /handoff — put the baton down (spec §4.1).
// ---------------------------------------------------------------------------

export interface HandoffInput {
  /** Composed rehydration note body (with the v1 markers). */
  readonly note: string;
  /** Optional Issue# (positive-integer string). Omit to auto-resolve. */
  readonly issue?: string;
  /** Zero or more --link refs (PR/issue refs: N, owner/repo#N, URL). */
  readonly link?: readonly string[];
  /** Zero or more --unlink refs. */
  readonly unlink?: readonly string[];
  /** --new: force-create a new issue even if @me has an open handoff. */
  readonly new?: boolean;
}

export interface HandoffResult {
  /** The issue the note landed on. */
  readonly issue: string;
  /** html_url of the upserted handoff issue. */
  readonly noteUrl: string;
  /** True iff this call created the issue. */
  readonly created: boolean;
  /** Operator-facing warnings accumulated along the way. */
  readonly warnings: readonly string[];
}

interface IssueViewForHandoff {
  state: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  body: string;
  updatedAt: string;
}

interface NoArgListEntry {
  number: number;
  title: string;
  assignees: Array<{ login: string }>;
  body: string;
}

export async function runHandoff(
  input: HandoffInput,
  deps: HandoffDeps,
): Promise<HandoffResult> {
  requireIssueNumber(input.issue);
  await requireTools(deps);

  const warnings: string[] = [];
  const body = input.note;
  if (!body.trim()) {
    throw new HandoffError("empty note body on stdin — nothing to post.");
  }

  // Validate LATEST block markers (same semantics as accept + rehydrate).
  if (!validateLatestBlock(body)) {
    throw new HandoffError(
      `note is missing/malformed agent-context markers (need ${MARKER_OPEN} … ${MARKER_CLOSE}) — compose per SKILL.md (single block, well-formed).`,
    );
  }

  // Secret-scrub BEFORE any network call.
  const scrub = scrubSecrets(body);
  if (!scrub.clean) {
    deps.log(
      `aborted: secret-shaped content in note:${scrub.lines.join(",")}; rephrase as setup steps (no value echo — see SKILL.md § Security rule).`,
    );
    throw new HandoffError(
      "aborted: secret-shaped content in the note (see above).",
    );
  }

  // Dirty-worktree warning (D4: no push step).
  const unstaged = await deps.git(["diff", "--quiet"]);
  const staged = await deps.git(["diff", "--cached", "--quiet"]);
  if (unstaged.code !== 0 || staged.code !== 0) {
    const w =
      "uncommitted tracked changes in the worktree — they won't be on a linked PR's diff. Commit/push them yourself if part of this work-stream.";
    warnings.push(w);
    deps.log(w);
  }

  // Resolve target issue.
  let issue = input.issue ?? "";
  let createNew = false;
  let existingBody = "";
  let initialUpdatedAt = "";

  if (issue !== "") {
    // Explicit issue path.
    const viewRes = await deps.gh([
      "issue",
      "view",
      issue,
      "--json",
      "state,labels,assignees,body,updatedAt",
    ]);
    if (viewRes.code !== 0) {
      throw new HandoffError(
        `can't verify issue #${issue} (gh issue view failed — does it exist in this repo?).`,
      );
    }
    let view: IssueViewForHandoff;
    try {
      view = JSON.parse(viewRes.stdout);
    } catch (err) {
      throw new HandoffError(
        `could not parse issue view JSON for #${issue}: ${(err as Error).message}`,
      );
    }
    if (view.state === "CLOSED") {
      throw new HandoffError(
        `issue #${issue} is closed — the handoff was already accepted; start a fresh one (run \`/handoff\` with no argument).`,
      );
    }
    const labelNames = (view.labels ?? []).map((l) => l.name);
    const hasHandoffLabel = labelNames.includes(HANDOFF_LABEL);
    existingBody = view.body ?? "";
    if (!hasHandoffLabel) {
      if (existingBody !== "") {
        throw new HandoffError(
          `issue #${issue} is not a handoff issue (no \`${HANDOFF_LABEL}\` label, non-empty body) — start a fresh handoff (\`/handoff\` with no argument), or pre-create an empty issue and apply the \`${HANDOFF_LABEL}\` label first.`,
        );
      }
      // Empty shell — accept; label added later.
    }
    const me = await meLogin(deps);
    const status = assigneesStatus(view.assignees ?? [], me);
    if (status === "other") {
      const others = assigneesOtherCsv(view.assignees ?? [], me);
      throw new HandoffError(
        `issue #${issue} is currently assigned to @${others} — coordinate with them or ask them to re-handoff (which un-assigns).`,
      );
    }
    initialUpdatedAt = view.updatedAt ?? "";
  } else {
    // No-arg path.
    const listRes = await deps.gh([
      "issue",
      "list",
      "--label",
      HANDOFF_LABEL,
      "--state",
      "open",
      "--search",
      "author:@me",
      "--json",
      "number,title,assignees,body",
    ]);
    if (listRes.code !== 0) {
      throw new HandoffError(
        "could not query existing handoffs (`gh issue list` failed) — not creating/updating; re-run when gh recovers.",
      );
    }
    let entries: NoArgListEntry[];
    try {
      entries = JSON.parse(listRes.stdout);
    } catch (err) {
      throw new HandoffError(
        `could not parse handoff list JSON: ${(err as Error).message}`,
      );
    }
    const me = await meLogin(deps);
    const eligible: NoArgListEntry[] = [];
    const others: NoArgListEntry[] = [];
    for (const e of entries) {
      const status = assigneesStatus(e.assignees ?? [], me);
      if (status === "empty" || status === "me") {
        eligible.push(e);
      } else {
        others.push(e);
      }
    }

    const emitOthersAdvisory = (): void => {
      for (const o of others) {
        const otherLogins = (o.assignees ?? [])
          .map((a) => a.login)
          .join(",");
        deps.log(
          `the handoff you created at #${o.number} is now claimed by @${otherLogins} — creating a new handoff. To update #${o.number}'s body coordinate with @${otherLogins}.`,
        );
      }
    };

    if (input.new === true || eligible.length === 0) {
      createNew = true;
      emitOthersAdvisory();
    } else if (eligible.length === 1) {
      const picked = eligible[0]!;
      issue = String(picked.number);
      // Re-fetch via view (list body may lag; need updatedAt for drift check).
      const viewRes2 = await deps.gh([
        "issue",
        "view",
        issue,
        "--json",
        "state,assignees,body,updatedAt",
      ]);
      if (viewRes2.code !== 0) {
        throw new HandoffError(
          `could not fetch state for #${issue} (gh issue view failed) — not PATCHing.`,
        );
      }
      let view2: IssueViewForHandoff;
      try {
        view2 = JSON.parse(viewRes2.stdout);
      } catch (err) {
        throw new HandoffError(
          `could not parse issue view JSON for #${issue}: ${(err as Error).message}`,
        );
      }
      existingBody = view2.body ?? "";
      initialUpdatedAt = view2.updatedAt ?? "";
      deps.log(
        `updated #${issue} instead of creating new — pass \`--new\` to force a new issue.`,
      );
    } else {
      const nums = eligible
        .map((e) => `#${e.number}`)
        .join(",");
      throw new HandoffError(
        `multiple open handoffs owned by you: ${nums} — pick one (\`/handoff <issue>\`) or pass \`--new\` to force a new issue.`,
      );
    }
  }

  // Compute linked-work-items entries via shared extractor.
  const entries: string[] = [];
  if (existingBody !== "") {
    for (const ln of extractLinkedItems(existingBody)) {
      entries.push(ln);
    }
  }

  // Apply --link
  const links = input.link ?? [];
  for (const ref of links) {
    const resolved = await resolveLinkRef(ref, deps);
    if (!scrubSecretsInString(resolved.title, `linked work-item title for ${resolved.display}`, deps)) {
      throw new HandoffError(
        "aborted: linked-item title scrub refused (see above).",
      );
    }
    const newEntry = `- ${resolved.kind} ${resolved.display} — ${resolved.title}`;
    // Dedup by "- <kind> <display> —" prefix.
    const prefix = `- ${resolved.kind} ${resolved.display} —`;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i]?.startsWith(prefix)) {
        entries.splice(i, 1);
      }
    }
    entries.push(newEntry);
  }

  // Apply --unlink
  const unlinks = input.unlink ?? [];
  for (const uref of unlinks) {
    const canon = canonicalizeLinkRef(uref);
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] ?? "";
      const m = e.match(/^- (pr|issue) (\S+) /);
      if (!m) continue;
      const eKind = m[1];
      const eDisp = m[2];
      if (
        eDisp === canon.display &&
        (canon.kind === "" || canon.kind === eKind)
      ) {
        entries.splice(i, 1);
      }
    }
  }

  // Auto-link single matching open PR (only when creating new + no explicit --link).
  if (createNew && links.length === 0) {
    const branch = await currentBranch(deps);
    if (
      branch !== "" &&
      branch !== "HEAD" &&
      branch !== "main" &&
      branch !== "master"
    ) {
      const pr = await openPrForBranch(deps, branch);
      if (pr !== undefined) {
        if (!scrubSecretsInString(pr.title, `auto-linked PR #${pr.number} title`, deps)) {
          throw new HandoffError(
            "aborted: auto-linked PR title scrub refused (see above).",
          );
        }
        entries.push(`- pr #${pr.number} — ${pr.title}`);
      }
    }
  }

  // Compose Linked work items section.
  const linksSectionLines: string[] = ["**Linked work items:**"];
  if (entries.length === 0) {
    linksSectionLines.push("_None linked._");
  } else {
    for (const e of entries) linksSectionLines.push(e);
  }
  const linksSection = linksSectionLines.join("\n");

  // Strip any pre-existing Linked work items section from the operator's
  // note (defensive — the SKILL.md template tells operators not to include
  // one), then insert the script-maintained section right before
  // MARKER_CLOSE.
  const noteStrippedLines: string[] = [];
  const noteLines = body.split("\n");
  {
    let skip = false;
    for (const line of noteLines) {
      if (line.startsWith("**Linked work items:**")) {
        skip = true;
        continue;
      }
      if (skip && /^- (pr|issue) /.test(line)) continue;
      if (skip && /^_None linked\._/.test(line)) continue;
      if (skip && /^\s*$/.test(line)) {
        skip = false;
        continue;
      }
      if (skip) skip = false;
      noteStrippedLines.push(line);
    }
  }

  // Inject the section right before the MARKER_CLOSE line.
  const newBlockLines: string[] = [];
  for (const line of noteStrippedLines) {
    if (line.includes(MARKER_CLOSE)) {
      newBlockLines.push("");
      for (const sl of linksSection.split("\n")) newBlockLines.push(sl);
      newBlockLines.push("");
      newBlockLines.push(line);
    } else {
      newBlockLines.push(line);
    }
  }
  const newBlock = newBlockLines.join("\n");

  // PATCH or CREATE
  let noteUrl = "";
  let created = false;

  if (createNew) {
    const branch = await currentBranch(deps);
    let title: string;
    if (
      branch !== "" &&
      branch !== "HEAD" &&
      branch !== "main" &&
      branch !== "master"
    ) {
      title = `Handoff: ${branch}`;
    } else {
      title = `Handoff: closeout @ ${todayIsoDate()}`;
    }
    // Scrub the generated title — fall back to date-only neutral title on match.
    if (SECRET_PATTERN.test(title)) {
      title = `Handoff: ${todayIsoDate()} (branch name redacted by scrub)`;
      const w =
        "branch name matched the secret-shaped pattern set — using a date-based title instead. Rename the branch if a descriptive title is needed.";
      warnings.push(w);
      deps.log(w);
    }
    await ensureLabel(deps);
    const createRes = await deps.gh(
      [
        "issue",
        "create",
        "--title",
        title,
        "--body-file",
        "-",
        "--label",
        HANDOFF_LABEL,
      ],
      { input: newBlock },
    );
    if (createRes.code !== 0) {
      throw new HandoffError(
        `gh issue create failed: ${createRes.stderr.trim() || `exit ${createRes.code}`}`,
      );
    }
    // gh issue create prints the URL on stdout.
    const createOut = createRes.stdout;
    const urlM = createOut.match(/https?:\/\/\S+/);
    const url = urlM ? urlM[0] : "";
    const numM = createOut.match(/\/issues\/(\d+)/);
    const num = numM?.[1];
    if (num === undefined || num === "") {
      throw new HandoffError(
        `could not parse issue number from \`gh issue create\` output: ${createOut}`,
      );
    }
    issue = num;
    created = true;
    noteUrl = url || `#${issue}`;
    // Remove @me (newly-created issues are unassigned by default —
    // belt-and-braces; ignore "not assigned" errors).
    const rm = await deps.gh([
      "issue",
      "edit",
      issue,
      "--remove-assignee",
      "@me",
    ]);
    if (rm.code !== 0 && !isBenignAssigneeRemovalError(rm.stderr)) {
      const w = `couldn't remove @me from #${issue} (gh error): ${rm.stderr.trim()}.`;
      warnings.push(w);
      deps.log(w);
    }
    deps.log(`created handoff issue #${issue}: ${noteUrl}`);
  } else {
    // PATCH path — race-safety re-fetch.
    const prePatchRes = await deps.gh([
      "issue",
      "view",
      issue,
      "--json",
      "state,assignees,body,updatedAt",
    ]);
    if (prePatchRes.code !== 0) {
      throw new HandoffError(
        "could not re-fetch state for race check (gh error) — not PATCHing.",
      );
    }
    let prePatch: IssueViewForHandoff;
    try {
      prePatch = JSON.parse(prePatchRes.stdout);
    } catch (err) {
      throw new HandoffError(
        `could not parse pre-PATCH view JSON for #${issue}: ${(err as Error).message}`,
      );
    }
    if (prePatch.state !== "OPEN") {
      const msg = `issue #${issue} changed between fetch and intended PATCH — state is now ${prePatch.state} (concurrent \`/accept\` may have closed it). Your note was NOT posted; re-run \`/handoff\` with a fresh target if appropriate.`;
      deps.log(msg);
      throw new HandoffError(msg);
    }
    const me = await meLogin(deps);
    const ppStatus = assigneesStatus(prePatch.assignees ?? [], me);
    if (ppStatus === "other") {
      const others = assigneesOtherCsv(prePatch.assignees ?? [], me);
      const msg = `issue #${issue} changed between fetch and intended PATCH — now assigned to @${others} (concurrent \`/accept\` claimed it). Your note was NOT posted.`;
      deps.log(msg);
      throw new HandoffError(msg);
    }
    if (existingBody !== (prePatch.body ?? "")) {
      const msg = `issue body changed between fetch and intended PATCH — your note was NOT posted. Re-run \`/handoff\` to splice against the new body.`;
      deps.log(msg);
      throw new HandoffError(msg);
    }
    if (
      initialUpdatedAt !== "" &&
      prePatch.updatedAt !== initialUpdatedAt
    ) {
      const w = `note: issue #${issue}.updatedAt changed since initial fetch (state/assignees/body unchanged — likely labels/metadata only). Proceeding.`;
      warnings.push(w);
      deps.log(w);
    }

    const newBody = spliceAgentContextBlock(existingBody, newBlock);
    const editRes = await deps.gh(
      ["issue", "edit", issue, "--body-file", "-"],
      { input: newBody },
    );
    if (editRes.code !== 0) {
      throw new HandoffError(
        "gh issue edit failed — body was NOT patched.",
      );
    }
    await ensureLabel(deps);
    // Label add: hard error on failure (the body PATCH landed, but the
    // issue won't show on /handoffs without the label).
    const addLabelRes = await deps.gh([
      "issue",
      "edit",
      issue,
      "--add-label",
      HANDOFF_LABEL,
    ]);
    if (addLabelRes.code !== 0) {
      throw new HandoffError(
        `body patched but \`${HANDOFF_LABEL}\` label was NOT added (gh error) — issue #${issue} won't show up on /handoffs. Re-run \`/handoff ${issue}\` (idempotent) or add the label manually.`,
      );
    }
    // Remove @me — ignore "not assigned" errors.
    const rm = await deps.gh([
      "issue",
      "edit",
      issue,
      "--remove-assignee",
      "@me",
    ]);
    if (rm.code !== 0 && !isBenignAssigneeRemovalError(rm.stderr)) {
      const w = `couldn't remove @me from #${issue} (gh error): ${rm.stderr.trim()}. Verify the issue is unassigned with \`gh issue view ${issue}\`.`;
      warnings.push(w);
      deps.log(w);
    }
    deps.log(`updated handoff issue #${issue}`);
    // Construct a noteUrl from gh's view (best-effort — use a synthesized
    // form so callers always have something; html_url is not in the JSON
    // we already fetched, but the issue ref is sufficient).
    noteUrl = `#${issue}`;
  }

  return { issue, noteUrl, created, warnings };
}

function todayIsoDate(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isBenignAssigneeRemovalError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("not assigned") ||
    s.includes("could not assign") ||
    s.includes("cannot remove")
  );
}

// ---------------------------------------------------------------------------
// /accept — take the baton (spec §4.3 atomic chain).
// ---------------------------------------------------------------------------

export interface AcceptInput {
  readonly issue: string;
}

export interface AcceptResult {
  readonly issue: string;
  readonly rehydrate: RehydrateResult;
}

interface IssueViewForAccept {
  state: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  body: string;
  updatedAt: string;
}

export async function runAccept(
  input: AcceptInput,
  deps: HandoffDeps,
): Promise<AcceptResult> {
  const issue = input.issue;
  if (!issue) {
    throw new HandoffError(
      "which one? run /handoffs to see the stack, then /accept <issue>",
    );
  }
  requireIssueNumber(issue);
  await requireTools(deps);

  // ---- step 1: validate (read-only) -------------------------------------
  const viewRes = await deps.gh([
    "issue",
    "view",
    issue,
    "--json",
    "state,labels,assignees,body,updatedAt",
  ]);
  if (viewRes.code !== 0) {
    throw new HandoffError(
      `could not fetch issue #${issue} (gh error) — not mutating.`,
    );
  }
  let view: IssueViewForAccept;
  try {
    view = JSON.parse(viewRes.stdout);
  } catch (err) {
    throw new HandoffError(
      `could not parse issue view JSON for #${issue}: ${(err as Error).message}`,
    );
  }
  if (view.state === "CLOSED") {
    throw new HandoffError(
      `issue #${issue} is closed — the handoff was already accepted.`,
    );
  }
  if (view.state !== "OPEN") {
    throw new HandoffError(
      `issue #${issue} in unexpected state: ${view.state}`,
    );
  }
  const hasHandoffLabel = (view.labels ?? [])
    .map((l) => l.name)
    .includes(HANDOFF_LABEL);
  if (!hasHandoffLabel) {
    throw new HandoffError(
      `issue #${issue} is not a handoff issue (no \`${HANDOFF_LABEL}\` label).`,
    );
  }
  if (!validateLatestBlock(view.body ?? "")) {
    throw new HandoffError(
      `issue #${issue} has no parseable agent-context block in the body (missing, malformed, or reversed markers — or the latest block is malformed) — refusing to accept (and close) a handoff with no reasoning artifact. Use \`/handoff ${issue}\` to add a well-formed note first.`,
    );
  }
  const me = await meLogin(deps);
  const initialAssignees = view.assignees ?? [];
  const initialStatus = assigneesStatus(initialAssignees, me);
  const initialUpdatedAt = view.updatedAt ?? "";

  // ---- step 2: refuse if assigned to @other -----------------------------
  if (initialStatus === "other") {
    const others = assigneesOtherCsv(initialAssignees, me);
    throw new HandoffError(
      `issue #${issue} is currently assigned to @${others} — coordinate with them or ask them to re-handoff (which un-assigns).`,
    );
  }

  // ---- step 3: rehydrate (strict=true; any failure aborts the chain) ---
  let rehydrate: RehydrateResult;
  try {
    rehydrate = await doRehydrate(issue, true, deps);
  } catch (err) {
    if (err instanceof HandoffError) {
      throw new HandoffError(
        `rehydrate failed for #${issue} — leaving on the stack; no mutation.`,
      );
    }
    throw err;
  }

  // ---- step 4: pre-assign drift check -----------------------------------
  const driftRes = await deps.gh([
    "issue",
    "view",
    issue,
    "--json",
    "state,assignees,updatedAt",
  ]);
  if (driftRes.code !== 0) {
    throw new HandoffError(
      `could not re-fetch issue #${issue} for drift check — not mutating.`,
    );
  }
  let drift: { state: string; assignees: Array<{ login: string }>; updatedAt: string };
  try {
    drift = JSON.parse(driftRes.stdout);
  } catch (err) {
    throw new HandoffError(
      `could not parse drift view JSON for #${issue}: ${(err as Error).message}`,
    );
  }
  if (drift.state !== "OPEN") {
    const msg = `issue #${issue} changed between validation and assign — state is now ${drift.state}. Another receiver may have claimed it; re-run \`/accept\` to retry against the new state, or check \`/handoffs\` for the current stack.`;
    deps.log(msg);
    throw new HandoffError(msg);
  }
  const driftStatus = assigneesStatus(drift.assignees ?? [], me);
  if (driftStatus === "other") {
    const msg = `issue #${issue} changed between validation and assign — another receiver may have claimed it; re-run \`/accept\` to retry against the new state, or check \`/handoffs\` for the current stack.`;
    deps.log(msg);
    throw new HandoffError(msg);
  }
  if (drift.updatedAt !== initialUpdatedAt) {
    // Allowed only for the close-failure retry path (initial was @me + drift is @me).
    if (!(initialStatus === "me" && driftStatus === "me")) {
      const msg = `issue #${issue} was edited between validation and assign (initial=${initialStatus}, drift=${driftStatus}) — re-run \`/accept\` to retry against the new state.`;
      deps.log(msg);
      throw new HandoffError(msg);
    }
  }

  // ---- step 5: assign @me ----------------------------------------------
  const assignRes = await deps.gh([
    "issue",
    "edit",
    issue,
    "--add-assignee",
    "@me",
  ]);
  if (assignRes.code !== 0) {
    const msg = `couldn't assign @me on #${issue} (gh error) — leaving on the stack.`;
    deps.log(msg);
    throw new HandoffError(msg);
  }
  deps.log(`accepted #${issue} — assigned to you.`);

  // ---- step 6: post-assign verify --------------------------------------
  const postRes = await deps.gh([
    "issue",
    "view",
    issue,
    "--json",
    "assignees",
  ]);
  if (postRes.code !== 0) {
    const msg = `couldn't verify post-assign state on #${issue} — leaving open + assigned; don't close.`;
    deps.log(msg);
    throw new HandoffError(msg);
  }
  let post: { assignees: Array<{ login: string }> };
  try {
    post = JSON.parse(postRes.stdout);
  } catch (err) {
    throw new HandoffError(
      `could not parse post-assign view JSON for #${issue}: ${(err as Error).message}`,
    );
  }
  const postStatus = assigneesStatus(post.assignees ?? [], me);
  if (postStatus !== "me") {
    const others = assigneesOtherCsv(post.assignees ?? [], me);
    const msg = `collision detected after assign — issue #${issue} now has assignees [${others}]. Do not close. Coordinate with the other receiver(s); the operator may \`gh issue edit ${issue} --remove-assignee <other>\` or hand the baton off explicitly.`;
    deps.log(msg);
    throw new HandoffError(msg);
  }

  // ---- step 7: close (Commitment 10) -----------------------------------
  const closeRes = await deps.gh(["issue", "close", issue]);
  if (closeRes.code !== 0) {
    const msg = `assigned but not closed — re-run \`/accept ${issue}\` to complete the close, or close manually as an operator-acknowledged exception.`;
    deps.log(msg);
    // Recoverable — return without throwing so callers see assigned-not-closed.
    return { issue, rehydrate };
  }
  deps.log(`closed #${issue} — handoff event complete.`);
  return { issue, rehydrate };
}

// ---------------------------------------------------------------------------
// /rehydrate — read-only catch-up (spec §4.4).
// ---------------------------------------------------------------------------

export interface RehydrateInput {
  /** Issue# (optional). Omit for two-tier auto-resolution. */
  readonly issue?: string;
}

export async function runRehydrate(
  input: RehydrateInput,
  deps: HandoffDeps,
): Promise<RehydrateResult> {
  requireIssueNumber(input.issue);
  await requireTools(deps);

  let issue = input.issue ?? "";
  if (issue === "") {
    // Tier 1: most recent open handoff-labeled issue assigned to @me.
    const tier1Res = await deps.gh([
      "issue",
      "list",
      "--label",
      HANDOFF_LABEL,
      "--state",
      "open",
      "--assignee",
      "@me",
      "--json",
      "number,updatedAt",
      "--jq",
      "sort_by(.updatedAt) | reverse | .[0].number // empty",
    ]);
    if (tier1Res.code !== 0) {
      throw new HandoffError(
        "could not query in-flight handoffs (`gh issue list` failed) — re-run when gh recovers.",
      );
    }
    const tier1 = tier1Res.stdout.trim();
    if (tier1 !== "") {
      issue = tier1;
    } else {
      // Tier 2: most recent CLOSED handoff-labeled issue assigned to @me within 7d.
      const tier2Res = await deps.gh([
        "issue",
        "list",
        "--label",
        HANDOFF_LABEL,
        "--state",
        "closed",
        "--assignee",
        "@me",
        "--json",
        "number,closedAt",
        "--jq",
        "sort_by(.closedAt) | reverse | .[0]",
      ]);
      if (tier2Res.code !== 0) {
        throw new HandoffError(
          "could not query closed handoffs (`gh issue list` failed) — re-run when gh recovers.",
        );
      }
      const tier2Raw = tier2Res.stdout.trim();
      if (tier2Raw !== "" && tier2Raw !== "null") {
        let parsed: { number?: number; closedAt?: string | null };
        try {
          parsed = JSON.parse(tier2Raw);
        } catch {
          parsed = {};
        }
        const candNumber = parsed?.number !== undefined ? String(parsed.number) : "";
        const candClosedAt = parsed?.closedAt ?? "";
        if (candNumber !== "" && candClosedAt !== "" && candClosedAt !== null) {
          // UNPARSEABLE timestamp must skip with warn — NEVER pre-cutoff.
          const candEpoch = isoToEpoch(candClosedAt);
          if (candEpoch === undefined) {
            deps.log(
              `could not parse closedAt timestamp '${candClosedAt}' — skipping tier-2 closed-handoff fallback for #${candNumber}.`,
            );
          } else {
            const nowEpoch = Math.floor(Date.now() / 1000);
            const cutoff = nowEpoch - REHYDRATE_CLOSED_WINDOW_DAYS * 86400;
            if (candEpoch >= cutoff) {
              issue = candNumber;
            }
          }
        }
      }
    }
    if (issue === "") {
      throw new HandoffError(
        `no in-flight handoff (open + assigned-to-@me) and no recent closed handoff (within ${REHYDRATE_CLOSED_WINDOW_DAYS}d) — see \`/handoffs\` for the unassigned stack, or \`/handoff\` to start a new one.`,
      );
    }
  }

  return doRehydrate(issue, false, deps);
}

// ---------------------------------------------------------------------------
// /handoffs — list the stack (spec §4.2).
// ---------------------------------------------------------------------------

export interface HandoffsRow {
  readonly number: number;
  readonly title: string;
  readonly ageStr: string;
  readonly linkedCount: number;
}

export interface HandoffsResult {
  readonly rows: readonly HandoffsRow[];
  /** Pre-rendered table text for CLI stdout. */
  readonly text: string;
}

interface IssueRowJson {
  number: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  body: string;
}

export async function runHandoffs(deps: HandoffDeps): Promise<HandoffsResult> {
  await requireTools(deps);
  const res = await deps.gh([
    "issue",
    "list",
    "--label",
    HANDOFF_LABEL,
    "--state",
    "open",
    "--search",
    "no:assignee",
    "--json",
    "number,title,createdAt,updatedAt,body",
    "--jq",
    "sort_by(.updatedAt)",
  ]);
  if (res.code !== 0) {
    throw new HandoffError(
      "gh issue list failed — cannot render the handoff stack.",
    );
  }
  const raw = res.stdout.trim();
  if (raw === "" || raw === "[]") {
    return {
      rows: [],
      text: `handoff stack is empty (no open, unassigned issues labeled '${HANDOFF_LABEL}').`,
    };
  }
  let entries: IssueRowJson[];
  try {
    entries = JSON.parse(raw);
  } catch (err) {
    throw new HandoffError(
      `could not parse handoff stack JSON: ${(err as Error).message}`,
    );
  }
  if (entries.length === 0) {
    return {
      rows: [],
      text: `handoff stack is empty (no open, unassigned issues labeled '${HANDOFF_LABEL}').`,
    };
  }

  const rows: HandoffsRow[] = [];
  const textLines: string[] = ["Handoff stack (oldest → newest):"];
  for (const e of entries) {
    const title = stripControlChars(e.title ?? "");
    const linkedCount = extractLinkedItems(e.body ?? "").length;
    const epoch = isoToEpoch(e.updatedAt ?? "");
    const ageStr = epoch !== undefined ? formatAge(epoch) : "?";
    const linked = linkedCount === 0 ? "none" : `${linkedCount} items`;
    rows.push({
      number: e.number,
      title,
      ageStr,
      linkedCount,
    });
    textLines.push(`#${e.number} · ${title} · ${ageStr} · linked: ${linked}`);
  }
  textLines.push("");
  textLines.push("Pick one:  /accept <issue>");
  return { rows, text: textLines.join("\n") };
}
