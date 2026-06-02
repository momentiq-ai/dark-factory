// packages/cli/src/handoff/real-clients.ts
//
// Production spawn-based implementations of the GhClient + GitClient + Clock
// ports. Tests use the queue-based FakeGhClient/FakeGitClient/FixedClock
// from tests/handoff/fixtures/stubs/ (Task 8) — these clients are exercised
// end-to-end by the verb tests (Tasks 17-20) and live-smoke (Task 32).
//
// The spawn pattern mirrors the Cycle 8 v1 defaultExec in index.ts:50-120,
// consolidated here as the home for the production clients. Two deliberate
// divergences from v1:
//
//   1. v1 resolves {code:127} on ENOENT and a separate requireTools() layer
//      translates 127 → HandoffError. The standalone clients here throw
//      HandoffError DIRECTLY from exec() on ENOENT — there is no
//      requireTools wrapper in the hexagonal seam. Consequence:
//      currentBranch/isDirty/issueUnassignMe still swallow non-zero exit
//      codes (their intended behavior), but throw if gh/git is entirely
//      absent — which is the correct distinction (missing binary ≠ "clean
//      tree"/"not assigned"). v1 is deleted in Task 22.
//   2. The bash-side issueUnassignMe was idempotent on "not assigned"
//      stderr (handoff.sh, the `*"not assigned"*` case). Mirrored here.
//
// HandoffError is imported as a VALUE (since we throw it); everything else
// is type-only. ports.ts re-exports HandoffError from ./index.js for the
// Tasks 11-22 window — Task 22 inverts that to put the class here in ports.

import { spawn } from "node:child_process";

import { HandoffError } from "./ports.js";
import type {
  Clock,
  GhClient,
  GitClient,
  IssueCreated,
  IssueListItem,
  IssueView,
  IssueViewSlim,
  PrView,
} from "./ports.js";

const MAX_BUFFER = 64 * 1024 * 1024;

interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn helper. Resolves with {code, stdout, stderr} regardless of process
 * exit status. Rejects ONLY on spawn-time errors — and an ENOENT (binary
 * not on PATH) is translated into a HandoffError with an actionable
 * "install …" message so the operator sees the fix path, not a raw Node
 * error.
 *
 * SECURITY: this uses `child_process.spawn` with an argument-array form
 * (no shell, no string interpolation). NOT `child_process.exec` — the
 * local helper is named `exec` because it returns an ExecResult, not
 * because it shells out. There is no shell process; arguments go
 * directly to the child binary, so shell metacharacters in user input
 * are inert. The bin name itself is a fixed literal ("gh"/"git").
 *
 * `spawn` (not `execFile`/`promisify`) is mandatory: some calls pipe a
 * body to `--body-file -` on the child's STDIN. promisify(execFile)'s
 * `input` option is silently dropped (it's exec-only), which would send
 * EMPTY input and hang the child waiting on EOF.
 */
function exec(
  bin: string,
  args: readonly string[],
  options: { input?: string } = {},
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
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
    child.on("error", (err) => {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        reject(
          new HandoffError(
            bin === "gh"
              ? "gh not found — install GitHub CLI and run 'gh auth login'."
              : `${bin} not found — install ${bin}.`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      resolve({
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

function gh(
  args: readonly string[],
  options: { input?: string } = {},
): Promise<ExecResult> {
  return exec("gh", args, options);
}

function git(args: readonly string[]): Promise<ExecResult> {
  return exec("git", args);
}

/** Throw HandoffError with stderr text on non-zero exit; return on ok. */
function expectOk(result: ExecResult, context: string): ExecResult {
  if (result.code !== 0) {
    const stderr = result.stderr.trim() || "(no stderr)";
    throw new HandoffError(`${context} failed (exit ${result.code}): ${stderr}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// SpawnGhClient — 14 methods covering every gh verb pattern the bash uses.
// ---------------------------------------------------------------------------

export class SpawnGhClient implements GhClient {
  async authStatus(): Promise<void> {
    const r = await gh(["auth", "status"]);
    if (r.code !== 0) {
      throw new HandoffError(
        "gh not authenticated — run 'gh auth login'.",
      );
    }
  }

  async apiUserLogin(): Promise<string> {
    const r = expectOk(
      await gh(["api", "user", "--jq", ".login"]),
      "gh api user",
    );
    const login = r.stdout.trim();
    if (!login) {
      throw new HandoffError(
        "could not determine @me's login (gh api user returned empty) — run 'gh auth status'.",
      );
    }
    return login;
  }

  async ensureHandoffLabel(): Promise<void> {
    // Idempotent: never fatal. gh returns non-zero if the label exists.
    await gh([
      "label",
      "create",
      "handoff",
      "--description",
      "Agent handoff (Cycle 12 protocol)",
      "--color",
      "cccccc",
    ]);
  }

  async issueView(
    num: number,
    opts: { repo?: string } = {},
  ): Promise<IssueView> {
    const args = ["issue", "view", String(num)];
    if (opts.repo) args.push("--repo", opts.repo);
    args.push(
      "--json",
      "number,title,body,state,assignees,labels,updatedAt,closedAt,url",
    );
    const r = expectOk(await gh(args), `gh issue view ${num}`);
    return JSON.parse(r.stdout) as IssueView;
  }

  async issueViewSlim(
    num: number,
    opts: { repo?: string } = {},
  ): Promise<IssueViewSlim> {
    const args = ["issue", "view", String(num)];
    if (opts.repo) args.push("--repo", opts.repo);
    args.push("--json", "state,assignees,updatedAt");
    const r = expectOk(await gh(args), `gh issue view ${num} (slim)`);
    return JSON.parse(r.stdout) as IssueViewSlim;
  }

  async issueList(opts: {
    state: "open" | "closed";
    assignee?: "@me" | string;
    search?: string;
  }): Promise<readonly IssueListItem[]> {
    const args = [
      "issue",
      "list",
      "--label",
      "handoff",
      "--state",
      opts.state,
    ];
    if (opts.assignee) args.push("--assignee", opts.assignee);
    if (opts.search) args.push("--search", opts.search);
    args.push(
      "--json",
      "number,title,assignees,body,createdAt,updatedAt,closedAt",
    );
    const r = expectOk(await gh(args), "gh issue list");
    return JSON.parse(r.stdout) as IssueListItem[];
  }

  async issueCreate(opts: {
    title: string;
    bodyMd: string;
    label: string;
  }): Promise<IssueCreated> {
    const args = [
      "issue",
      "create",
      "--title",
      opts.title,
      "--label",
      opts.label,
      "--body-file",
      "-",
    ];
    const r = await gh(args, { input: opts.bodyMd });
    if (r.code !== 0) {
      throw new HandoffError(
        `gh issue create failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim() || "(no output)"}`,
      );
    }
    // gh issue create prints the URL on stdout (last non-empty line).
    const lines = r.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const url = lines[lines.length - 1] ?? "";
    const match = url.match(/\/issues\/(\d+)\b/);
    if (!match) {
      throw new HandoffError(
        `could not parse issue number from \`gh issue create\` output: ${r.stdout.trim()}`,
      );
    }
    return { number: Number(match[1]), url };
  }

  async issueEditBody(num: number, bodyMd: string): Promise<void> {
    const args = ["issue", "edit", String(num), "--body-file", "-"];
    const r = await gh(args, { input: bodyMd });
    if (r.code !== 0) {
      throw new HandoffError(
        `gh issue edit ${num} --body-file failed (exit ${r.code}): ${r.stderr.trim() || "(no stderr)"}`,
      );
    }
  }

  async issueAddLabel(num: number, label: string): Promise<void> {
    expectOk(
      await gh(["issue", "edit", String(num), "--add-label", label]),
      `gh issue edit ${num} --add-label ${label}`,
    );
  }

  async issueAssignMe(num: number): Promise<void> {
    expectOk(
      await gh(["issue", "edit", String(num), "--add-assignee", "@me"]),
      `gh issue edit ${num} --add-assignee @me`,
    );
  }

  async issueUnassignMe(num: number): Promise<void> {
    // Bash parity: handoff.sh treats "not assigned" stderr as idempotent
    // success (same case-arm in the shell version). Mirror that here so
    // /handoff on a PR that's no longer assigned to @me is a no-op rather
    // than an error.
    const r = await gh([
      "issue",
      "edit",
      String(num),
      "--remove-assignee",
      "@me",
    ]);
    if (r.code !== 0) {
      const stderr = r.stderr;
      if (
        /not assigned/i.test(stderr) ||
        /could not assign/i.test(stderr) ||
        /cannot remove/i.test(stderr)
      ) {
        return; // idempotent no-op
      }
      throw new HandoffError(
        `gh issue edit ${num} --remove-assignee @me failed: ${stderr.trim() || "(no stderr)"}`,
      );
    }
  }

  async issueClose(num: number): Promise<void> {
    expectOk(
      await gh(["issue", "close", String(num)]),
      `gh issue close ${num}`,
    );
  }

  async prView(num: number, opts: { repo?: string } = {}): Promise<PrView> {
    const args = ["pr", "view", String(num)];
    if (opts.repo) args.push("--repo", opts.repo);
    args.push(
      "--json",
      "state,mergeStateStatus,reviewDecision,statusCheckRollup,title",
    );
    const r = expectOk(await gh(args), `gh pr view ${num}`);
    return JSON.parse(r.stdout) as PrView;
  }

  async prListByHead(
    branch: string,
  ): Promise<ReadonlyArray<{ number: number; title: string }>> {
    const r = expectOk(
      await gh([
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,title",
      ]),
      `gh pr list --head ${branch}`,
    );
    return JSON.parse(r.stdout) as Array<{ number: number; title: string }>;
  }
}

// ---------------------------------------------------------------------------
// SpawnGitClient — currentBranch + isDirty.
// ---------------------------------------------------------------------------

export class SpawnGitClient implements GitClient {
  async currentBranch(): Promise<string> {
    const r = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    // Non-zero (e.g., not in a repo) → fall back to "HEAD" so callers
    // get a stable string rather than an exception. ENOENT (git missing)
    // still throws from exec().
    return r.code === 0 ? r.stdout.trim() || "HEAD" : "HEAD";
  }

  async isDirty(): Promise<boolean> {
    const unstaged = await git(["diff", "--quiet"]);
    if (unstaged.code !== 0) return true;
    const staged = await git(["diff", "--cached", "--quiet"]);
    return staged.code !== 0;
  }
}

// ---------------------------------------------------------------------------
// SystemClock — wall clock for format_age + create-title date.
// ---------------------------------------------------------------------------

export class SystemClock implements Clock {
  nowEpoch(): number {
    return Math.floor(Date.now() / 1000);
  }

  todayYmd(): string {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
}
