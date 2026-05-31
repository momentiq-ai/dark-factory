// packages/cli/src/handoff/ports.ts
//
// Hexagonal ports: GhClient + GitClient + Clock. All side-effecting verbs
// take these as parameters; tests inject queue-based fakes (see
// tests/handoff/fixtures/stubs/), production uses real-clients.ts which
// spawns gh/git.
//
// The GhClient surface is fine-grained per gh idiom (one method per gh
// verb pattern the bash uses) so the test fake can ordinal-key responses
// per-method, mirroring bash's _bump_counter + STUB_ISSUE_BODY_N seam.
// The verb impl is constrained to call these in the SAME ORDER the bash
// did — drift/race tests assert that order (see advisor finding #2).
//
// HandoffError is the SINGLE class identity used across every v2 throw
// site (verbs + ports + clients). Defined here (the lowest leaf in the
// handoff module graph) so the new public surface (./index.js, Task 23)
// can re-export from here without a cycle. The v1 monolith used to own
// this class — Task 22 inverted the re-export when the v1 index.ts was
// deleted, so this is now the canonical definition.

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

// ---------------------------------------------------------------------------
// GhClient — every gh call the bash verbs make. Fine-grained per gh verb
// pattern so the test fake's ordinal-keyed queue can mirror bash's
// _bump_counter + STUB_ISSUE_BODY_N seam from .claude/skills/handoff/tests/
// bin/gh@a6f711b.
// ---------------------------------------------------------------------------

export interface IssueView {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "OPEN" | "CLOSED";
  readonly assignees: ReadonlyArray<{ readonly login: string }>;
  readonly labels: ReadonlyArray<{ readonly name: string }>;
  readonly updatedAt: string; // ISO-8601
  readonly closedAt: string | null;
}

/**
 * Subset of IssueView fields for drift/race checks (assignees + state +
 * updatedAt; body omitted). Separate seam from issueView so the fake's
 * ordinal counters split: _body-bearing_ vs _drift-only_ calls increment
 * independently (mirrors bash's `issue_view_body` vs `issue_view` counter
 * namespaces in tests/bin/gh).
 */
export interface IssueViewSlim {
  readonly state: "OPEN" | "CLOSED";
  readonly assignees: ReadonlyArray<{ readonly login: string }>;
  readonly updatedAt: string;
  /** body is optional — the drift check may skip it. */
  readonly body?: string;
}

export interface PrView {
  readonly title: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly mergeStateStatus: string;
  readonly reviewDecision: string;
  readonly statusCheckRollup: ReadonlyArray<{
    readonly conclusion?: string;
    readonly state?: string;
    readonly status?: string;
  }>;
}

export interface IssueListItem {
  readonly number: number;
  readonly title: string;
  readonly assignees: ReadonlyArray<{ readonly login: string }>;
  readonly body?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly closedAt?: string;
}

export interface IssueCreated {
  readonly number: number;
  readonly url: string;
}

export interface GhClient {
  /** `gh auth status` — throws on non-zero. */
  authStatus(): Promise<void>;
  /** `gh api user --jq .login` */
  apiUserLogin(): Promise<string>;
  /** `gh label create handoff …` (idempotent — failure not fatal) */
  ensureHandoffLabel(): Promise<void>;
  /** `gh issue view <n> --json <full set>` — full IssueView (body included) */
  issueView(num: number, opts?: { repo?: string }): Promise<IssueView>;
  /** Same fields minus body (separate seam for drift checks). */
  issueViewSlim(num: number, opts?: { repo?: string }): Promise<IssueViewSlim>;
  /** `gh issue list --label handoff --state <s> ...` */
  issueList(opts: {
    state: "open" | "closed";
    assignee?: "@me" | string;
    search?: string;
  }): Promise<readonly IssueListItem[]>;
  /** `gh issue create --title <t> --body-file - --label handoff` */
  issueCreate(opts: { title: string; bodyMd: string; label: string }): Promise<IssueCreated>;
  /** `gh issue edit <n> --body-file -` */
  issueEditBody(num: number, bodyMd: string): Promise<void>;
  /** `gh issue edit <n> --add-label <l>` */
  issueAddLabel(num: number, label: string): Promise<void>;
  /** `gh issue edit <n> --add-assignee @me` */
  issueAssignMe(num: number): Promise<void>;
  /** `gh issue edit <n> --remove-assignee @me` — idempotent; throws only on REAL gh errors. */
  issueUnassignMe(num: number): Promise<void>;
  /** `gh issue close <n>` */
  issueClose(num: number): Promise<void>;
  /** `gh pr view <n> --json state,mergeStateStatus,reviewDecision,statusCheckRollup,title` */
  prView(num: number, opts?: { repo?: string }): Promise<PrView>;
  /** `gh pr list --head <branch> --state open --json number,title` */
  prListByHead(branch: string): Promise<ReadonlyArray<{ number: number; title: string }>>;
}

// ---------------------------------------------------------------------------
// GitClient — current branch + dirty check.
// ---------------------------------------------------------------------------

export interface GitClient {
  /** `git rev-parse --abbrev-ref HEAD` — returns "HEAD" on detached. */
  currentBranch(): Promise<string>;
  /** True iff `git diff --quiet` OR `git diff --cached --quiet` returns non-zero. */
  isDirty(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Clock — wall-clock for format_age + iso cutoff + create-title date.
// Injected so format_age tests can pin "now" deterministically (the bash
// stub couldn't, which is why its tests never assert exact ages).
// ---------------------------------------------------------------------------

export interface Clock {
  /** Epoch seconds (Unix). */
  nowEpoch(): number;
  /** YYYY-MM-DD in UTC. */
  todayYmd(): string;
}
