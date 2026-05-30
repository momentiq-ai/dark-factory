// Hermetic tests for the agent handoff protocol core (Cycle 8 Phase 8.2).
//
// The TypeScript analog of the dogfooded Phase 8.1 bash test suite
// (.claude/skills/handoff/tests/test_handoff.sh — 29 hermetic cases). The
// bash stubbed `gh`/`git` on PATH; here we inject `gh`/`git` runners (the
// core's load-bearing testability decision) and assert CONTROL FLOW — which
// mutating calls happen — exactly as the bash did. No network, no PATH stub.
//
// The fixtures use key-SHAPED values (AKIA…, sk-ant-…, AWS_SECRET_ACCESS_KEY=)
// not real secrets, so neither this file nor the source trips the repo's own
// secrets-scan — same discipline the bash fixtures used.

import { describe, expect, it } from "vitest";

import {
  HandoffError,
  _execForTest,
  runAccept,
  runHandoff,
  runHandoffs,
  runRehydrate,
  scrubSecrets,
  requirePrNumber,
  stripControlChars,
  validateNoteMarkers,
  type ExecResult,
  type GhRunner,
  type GitRunner,
  type HandoffDeps,
} from "../../src/handoff/index.js";

const MARK_O = "<!-- agent-context:v1 -->";
const MARK_C = "<!-- /agent-context:v1 -->";

function note(body = "why: chose path 1"): string {
  return `${MARK_O}\n\n**Branch:** feature/x\n\n${body}\n${MARK_C}\n`;
}

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };
function out(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: "" };
}
function fail(code = 1, stderr = "boom"): ExecResult {
  return { code, stdout: "", stderr };
}

interface Call {
  readonly bin: "gh" | "git";
  readonly args: readonly string[];
  readonly input?: string;
}

interface HarnessOptions {
  branch?: string;
  /** Open PR number for `pr list --head <branch>`, or "" for none. */
  prForBranch?: string;
  /** headRefName returned by `pr view <n> --json headRefName`. */
  prBranch?: string;
  /** Make `pr view <n> --json headRefName` fail (unverifiable explicit PR). */
  prViewFails?: boolean;
  /** Existing marker comment ids (ascending = oldest→newest). */
  markerIds?: number[];
  /** Body returned for the most-recent marker comment fetch-by-id. */
  commentBody?: string;
  /** Make PATCH fail → 403 fallback to POST. */
  patchFails?: boolean;
  /** Make `git push origin HEAD` fail (gate blocked). */
  pushFails?: boolean;
  /** Make `git diff`/`git diff --cached` report dirty (non-zero). */
  dirty?: boolean;
  /** Untracked files present (porcelain `??` line). */
  untracked?: boolean;
  /** URL printed by `gh pr create`. */
  createUrl?: string;
  /** Number returned by `pr view <createUrl> --json number`. */
  createdNumber?: string;
  /** Make `gh pr view <n> --json title,...` (rehydrate live state) fail. */
  liveStateFails?: boolean;
  /** Labels returned by `pr view <n> --json labels` (accept). */
  prLabels?: string[];
  /** Make the labels query fail (accept gh error case). */
  labelsQueryFails?: boolean;
  /** Stack JSON for `pr list --label handoff`. */
  stackJson?: string;
  /** Make `gh auth status` fail (unauthenticated). */
  unauthenticated?: boolean;
}

function makeHarness(opts: HarnessOptions = {}): {
  deps: HandoffDeps;
  calls: Call[];
  logs: string[];
} {
  const calls: Call[] = [];
  const logs: string[] = [];
  const branch = opts.branch ?? "feature/x";

  const gh: GhRunner = async (args, options) => {
    calls.push({ bin: "gh", args, ...(options?.input ? { input: options.input } : {}) });
    const a = args.join(" ");
    if (a === "--version") return out("gh version 2.0.0\n");
    if (a === "auth status") return opts.unauthenticated ? fail() : OK;
    // pr list --head <branch> ... → open PR number for the branch
    if (a.startsWith("pr list --head")) {
      return out((opts.prForBranch ?? "") === "" ? "" : `${opts.prForBranch}\n`);
    }
    // pr list --label handoff ... → stack JSON
    if (a.startsWith("pr list --label handoff")) {
      return out(opts.stackJson ?? "[]");
    }
    // pr view <n> --json headRefName → branch-mismatch guard
    if (a.includes("--json headRefName")) {
      if (opts.prViewFails) return fail();
      return out(`${opts.prBranch ?? branch}\n`);
    }
    // pr view <n> --json title,... → rehydrate live state
    if (a.includes("--json title,headRefName,mergeStateStatus")) {
      if (opts.liveStateFails) return fail();
      return out(`  some PR\n  branch:    ${branch}\n  mergeable: CLEAN   review: APPROVED\n`);
    }
    // pr view <n> --json labels → accept label check
    if (a.includes("--json labels")) {
      if (opts.labelsQueryFails) return fail();
      return out((opts.prLabels ?? ["handoff"]).join("\n") + "\n");
    }
    // pr view <createUrl> --json number → no-PR re-query
    if (a.includes("--json number")) {
      return out(`${opts.createdNumber ?? "77"}\n`);
    }
    if (a === "pr checks " + numberFrom(a) || a.startsWith("pr checks")) {
      return out("all checks passing\n");
    }
    if (a.startsWith("pr create")) {
      return out(`${opts.createUrl ?? "https://github.com/o/r/pull/77"}\n`);
    }
    // list comments (--slurp wraps pages in an outer array)
    if (a.includes("/comments --paginate --slurp")) {
      const ids = opts.markerIds ?? [];
      const page = ids.map((id) => ({ id, body: `${MARK_O} marked` }));
      return out(JSON.stringify([page]));
    }
    // fetch comment body by id
    if (a.includes("issues/comments/") && a.includes("--jq .body")) {
      return out((opts.commentBody ?? `${MARK_O}\n${MARK_C}`) + "\n");
    }
    // PATCH a comment
    if (a.includes("--method PATCH")) {
      if (opts.patchFails) return fail(1, "HTTP 403");
      return out("https://github.com/o/r/pull/1#issuecomment-patched\n");
    }
    // POST a comment
    if (a.includes("--method POST")) {
      return out("https://github.com/o/r/pull/1#issuecomment-posted\n");
    }
    if (a.startsWith("label create")) return OK;
    if (a.startsWith("pr edit")) return OK;
    return OK;
  };

  const git: GitRunner = async (args) => {
    calls.push({ bin: "git", args });
    const a = args.join(" ");
    if (a === "rev-parse --abbrev-ref HEAD") return out(`${branch}\n`);
    if (a === "diff --quiet") return opts.dirty ? fail() : OK;
    if (a === "diff --cached --quiet") return opts.dirty ? fail() : OK;
    if (a.startsWith("status --porcelain")) {
      return out(opts.untracked ? "?? scratch.txt\n" : "");
    }
    if (a === "push origin HEAD") return opts.pushFails ? fail() : OK;
    return OK;
  };

  return {
    deps: { gh, git, log: (l) => logs.push(l) },
    calls,
    logs,
  };
}

function numberFrom(a: string): string {
  const m = a.match(/pr checks (\d+)/);
  return m?.[1] ?? "";
}

function ghCall(calls: Call[], substr: string): boolean {
  return calls.some((c) => c.bin === "gh" && c.args.join(" ").includes(substr));
}
function gitCall(calls: Call[], substr: string): boolean {
  return calls.some((c) => c.bin === "git" && c.args.join(" ").includes(substr));
}

// ---------------------------------------------------------------------------
// Pure-function unit tests (no harness).
// ---------------------------------------------------------------------------

describe("handoff core — pure helpers", () => {
  it("requirePrNumber accepts positive ints, rejects 0/leading-zero/non-numeric", () => {
    expect(() => requirePrNumber("42")).not.toThrow();
    expect(() => requirePrNumber(undefined)).not.toThrow();
    expect(() => requirePrNumber("")).not.toThrow();
    expect(() => requirePrNumber("0")).toThrow(/positive integer/);
    expect(() => requirePrNumber("0042")).toThrow(/positive integer/);
    expect(() => requirePrNumber("42; echo PWNED")).toThrow(/positive integer/);
    expect(() => requirePrNumber("-1")).toThrow(/positive integer/);
  });

  it("validateNoteMarkers requires open-before-close", () => {
    expect(validateNoteMarkers(`${MARK_O} x ${MARK_C}`)).toBe(true);
    expect(validateNoteMarkers("no markers")).toBe(false);
    expect(validateNoteMarkers(`${MARK_C} ${MARK_O}`)).toBe(false); // reversed
    expect(validateNoteMarkers(MARK_O)).toBe(false); // open only
  });

  it("scrubSecrets refuses key shapes / env-var names / conn strings / cred paths / provider keys, returns line numbers only", () => {
    expect(scrubSecrets("just prose").clean).toBe(true);
    // AWS access key id (line 2)
    const aws = scrubSecrets("ok\nleftover: AKIAIOSFODNN7EXAMPLE\n");
    expect(aws.clean).toBe(false);
    expect(aws.lines).toEqual([2]);
    // env-var secret name
    expect(scrubSecrets("AWS_SECRET_ACCESS_KEY=FAKEvalue0123456789").clean).toBe(false);
    expect(scrubSecrets("GITHUB_TOKEN=x").clean).toBe(false);
    expect(scrubSecrets("DB_PASSWORD=x").clean).toBe(false);
    // connection string
    expect(scrubSecrets("postgres://admin:hunter2@db.internal:5432/app").clean).toBe(false);
    // credential file path
    expect(scrubSecrets("the key lives in ~/.aws/credentials on the box").clean).toBe(false);
    // provider keys
    expect(scrubSecrets("sk-ant-api03-FAKEKEYvalue0123456789abcdef").clean).toBe(false);
    expect(scrubSecrets("AIzaFAKEKEYvalue0123456789abcdef").clean).toBe(false);
    // gh token
    expect(scrubSecrets("ghp_" + "a".repeat(36)).clean).toBe(false);
    // PEM header
    expect(scrubSecrets("-----BEGIN RSA blah").clean).toBe(false);
  });

  it("the spawn-backed runner ACTUALLY delivers options.input to the child's stdin", async () => {
    // Regression guard for the load-bearing upsert path: `gh api --input -`
    // reads the comment body on stdin. `promisify(execFile)` silently drops
    // its `input` option, which would post an EMPTY comment (or hang). The
    // hermetic gh fake can't catch that — it just records the arg. So pin it
    // against a REAL subprocess (`cat` echoes stdin to stdout).
    const payload = JSON.stringify({ body: "hello-from-stdin\nwith newline" });
    const r = await _execForTest("cat", [], { input: payload });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(payload);
  });

  it("the spawn-backed runner surfaces a missing binary as code 127 (not a crash)", async () => {
    const r = await _execForTest("df-no-such-binary-xyz-123", []);
    expect(r.code).toBe(127);
  });

  it("stripControlChars removes ESC/control bytes but keeps tab + newline", () => {
    const dirty = `a\x1b[31mRED\tkeep\nline`;
    const clean = stripControlChars(dirty);
    expect(clean).not.toContain("\x1b");
    expect(clean).toContain("\t");
    expect(clean).toContain("\n");
    expect(clean).toContain("RED");
  });
});

// ---------------------------------------------------------------------------
// runHandoff (put the baton down).
// ---------------------------------------------------------------------------

describe("runHandoff", () => {
  it("has-PR with no existing marker → POST + label + unassign", async () => {
    const { deps, calls } = makeHarness({ prForBranch: "42", markerIds: [] });
    const r = await runHandoff({ note: note() }, deps);
    expect(r.pr).toBe("42");
    expect(r.pushed).toBe(true);
    expect(ghCall(calls, "--method POST repos/{owner}/{repo}/issues/42/comments")).toBe(true);
    expect(ghCall(calls, "pr edit 42 --add-label handoff")).toBe(true);
    expect(ghCall(calls, "pr edit 42 --remove-assignee @me")).toBe(true);
  });

  it("has-PR with existing marker → PATCH (idempotent, no POST)", async () => {
    const { deps, calls } = makeHarness({ prForBranch: "42", markerIds: [555] });
    await runHandoff({ note: note() }, deps);
    expect(ghCall(calls, "--method PATCH repos/{owner}/{repo}/issues/comments/555")).toBe(true);
    expect(ghCall(calls, "--method POST")).toBe(false);
  });

  it("no PR → push, create draft, re-query #, comment, label", async () => {
    const { deps, calls } = makeHarness({
      prForBranch: "",
      createUrl: "https://github.com/o/r/pull/77",
      createdNumber: "77",
      markerIds: [],
    });
    const r = await runHandoff({ note: note() }, deps);
    expect(r.createdDraftPr).toBe(true);
    expect(r.pr).toBe("77");
    expect(ghCall(calls, "pr create --draft --fill --head feature/x")).toBe(true);
    expect(ghCall(calls, "pr view https://github.com/o/r/pull/77 --json number")).toBe(true);
    expect(ghCall(calls, "--method POST repos/{owner}/{repo}/issues/77/comments")).toBe(true);
    expect(ghCall(calls, "pr edit 77 --add-label handoff")).toBe(true);
  });

  it("secret-shaped body → refuses, nothing posted (AWS key id)", async () => {
    const { deps, calls } = makeHarness({ prForBranch: "42" });
    const body = `${MARK_O}\nleftover debug line: AKIAIOSFODNN7EXAMPLE\n${MARK_C}\n`;
    await expect(runHandoff({ note: body }, deps)).rejects.toThrow(HandoffError);
    expect(ghCall(calls, "--method POST")).toBe(false);
    expect(ghCall(calls, "--method PATCH")).toBe(false);
  });

  it("connection-string scrub → refuses, no gh api", async () => {
    const { deps, calls } = makeHarness({ prForBranch: "42" });
    const body = `${MARK_O}\nleftover: postgres://admin:hunter2@db.internal:5432/app\n${MARK_C}\n`;
    await expect(runHandoff({ note: body }, deps)).rejects.toThrow(/secret-shaped/);
    expect(ghCall(calls, "--method")).toBe(false);
  });

  it("credential-path scrub → refuses, content not echoed (line number only)", async () => {
    const { deps, calls, logs } = makeHarness({ prForBranch: "42" });
    const body = `${MARK_O}\nthe app key lives in ~/.aws/credentials on the box\n${MARK_C}\n`;
    await expect(runHandoff({ note: body }, deps)).rejects.toThrow(HandoffError);
    expect(ghCall(calls, "--method")).toBe(false);
    expect(logs.join("\n")).not.toContain("credentials"); // line number, not the path
  });

  it("env-var secret-name scrub → refuses, value not echoed", async () => {
    const { deps, calls, logs } = makeHarness({ prForBranch: "42" });
    const body = `${MARK_O}\nAWS_SECRET_ACCESS_KEY=FAKEsecretvalueEXAMPLE0123456789\n${MARK_C}\n`;
    await expect(runHandoff({ note: body }, deps)).rejects.toThrow(HandoffError);
    expect(ghCall(calls, "--method")).toBe(false);
    expect(logs.join("\n")).not.toContain("FAKEsecretvalue");
  });

  it("provider API key (sk-ant-…) → refuses, value not echoed", async () => {
    const { deps, calls, logs } = makeHarness({ prForBranch: "42" });
    const body = `${MARK_O}\nleftover: sk-ant-api03-FAKEKEYvalue0123456789abcdef\n${MARK_C}\n`;
    await expect(runHandoff({ note: body }, deps)).rejects.toThrow(HandoffError);
    expect(ghCall(calls, "--method")).toBe(false);
    expect(logs.join("\n")).not.toContain("sk-ant");
  });

  it("detached HEAD + no PR arg → errors, no network", async () => {
    const { deps, calls } = makeHarness({ branch: "HEAD", prForBranch: "" });
    await expect(runHandoff({ note: note() }, deps)).rejects.toThrow(/detached HEAD/);
    expect(ghCall(calls, "--method")).toBe(false);
  });

  it("detached HEAD + explicit PR → posts note, NO push, warns detached", async () => {
    const { deps, calls } = makeHarness({ branch: "HEAD", markerIds: [] });
    const r = await runHandoff({ note: note(), pr: "55" }, deps);
    expect(r.pushed).toBe(false);
    expect(ghCall(calls, "--method POST repos/{owner}/{repo}/issues/55/comments")).toBe(true);
    expect(gitCall(calls, "push origin")).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/detached HEAD/);
  });

  it("PATCH 403 → falls back to POST a fresh note + warns 'another identity'", async () => {
    const { deps, calls, logs } = makeHarness({
      prForBranch: "42",
      markerIds: [555],
      patchFails: true,
    });
    const r = await runHandoff({ note: note() }, deps);
    expect(r.pr).toBe("42");
    expect(ghCall(calls, "--method PATCH repos/{owner}/{repo}/issues/comments/555")).toBe(true);
    expect(ghCall(calls, "--method POST repos/{owner}/{repo}/issues/42/comments")).toBe(true);
    expect(logs.join("\n")).toMatch(/another identity/i);
  });

  it("has-PR push blocked → note kept + labeled, warns NOT on origin (D5)", async () => {
    const { deps, calls } = makeHarness({ prForBranch: "42", markerIds: [], pushFails: true });
    const r = await runHandoff({ note: note() }, deps);
    expect(r.pushed).toBe(false);
    expect(ghCall(calls, "--method POST repos/{owner}/{repo}/issues/42/comments")).toBe(true);
    expect(ghCall(calls, "pr edit 42 --add-label handoff")).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/NOT on origin/);
  });

  it("no-PR + push blocked → no PR created, clear error (note not lost)", async () => {
    const { deps, calls } = makeHarness({ prForBranch: "", pushFails: true });
    await expect(runHandoff({ note: note() }, deps)).rejects.toThrow(/can't open a PR/);
    expect(ghCall(calls, "pr create")).toBe(false);
  });

  it("explicit PR that can't be verified (gh pr view fails) → die, no post/push", async () => {
    const { deps, calls } = makeHarness({ prViewFails: true });
    await expect(runHandoff({ note: note(), pr: "88" }, deps)).rejects.toThrow(/can't verify/);
    expect(ghCall(calls, "--method")).toBe(false);
    expect(gitCall(calls, "push origin")).toBe(false);
  });

  it("explicit PR on mismatched branch → refused (no post, no push)", async () => {
    const { deps, calls } = makeHarness({ branch: "feature/x", prBranch: "other/y" });
    await expect(runHandoff({ note: note(), pr: "77" }, deps)).rejects.toThrow(/is for branch/);
    expect(ghCall(calls, "--method")).toBe(false);
    expect(gitCall(calls, "push origin")).toBe(false);
  });

  it("PR '0' rejected before any gh mutation", async () => {
    const { deps, calls } = makeHarness({});
    await expect(runHandoff({ note: note(), pr: "0" }, deps)).rejects.toThrow(/positive integer/);
    expect(ghCall(calls, "--method")).toBe(false);
  });

  it("dirty worktree (uncommitted tracked changes) → abort, no post/label", async () => {
    const { deps, calls } = makeHarness({ prForBranch: "42", dirty: true });
    await expect(runHandoff({ note: note() }, deps)).rejects.toThrow(/uncommitted changes/);
    expect(ghCall(calls, "--method")).toBe(false);
    expect(ghCall(calls, "pr edit 42 --add-label")).toBe(false);
  });

  it("untracked files → warns but still posts + labels", async () => {
    const { deps, calls } = makeHarness({ prForBranch: "42", markerIds: [], untracked: true });
    const r = await runHandoff({ note: note() }, deps);
    expect(r.warnings.join(" ")).toMatch(/untracked/i);
    expect(ghCall(calls, "--method POST repos/{owner}/{repo}/issues/42/comments")).toBe(true);
    expect(ghCall(calls, "pr edit 42 --add-label handoff")).toBe(true);
  });

  it("malformed note (no markers) → rejected, nothing posted", async () => {
    const { deps, calls } = makeHarness({ prForBranch: "42" });
    await expect(
      runHandoff({ note: "just some text, no markers" }, deps),
    ).rejects.toThrow(/marker/i);
    expect(ghCall(calls, "--method")).toBe(false);
  });

  it("unauthenticated gh → refuses before any work", async () => {
    const { deps, calls } = makeHarness({ unauthenticated: true });
    await expect(runHandoff({ note: note() }, deps)).rejects.toThrow(/not authenticated/);
    expect(ghCall(calls, "--method")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runRehydrate (read-only catch-up).
// ---------------------------------------------------------------------------

describe("runRehydrate", () => {
  it("derives live state FIRST, fetches newest note by id, read-only", async () => {
    const { deps, calls } = makeHarness({
      markerIds: [900],
      commentBody: `${MARK_O}\nwhy: chose path 1\n${MARK_C}`,
    });
    const r = await runRehydrate({ pr: "42" }, deps);
    expect(r.liveState).toMatch(/mergeable: CLEAN/);
    expect(ghCall(calls, "pr view 42 --json title,headRefName,mergeStateStatus")).toBe(true);
    expect(ghCall(calls, "pr checks 42")).toBe(true);
    expect(ghCall(calls, "issues/comments/900")).toBe(true);
    expect(r.note).toContain("why: chose path 1");
    expect(r.checkoutHint).toBe("gh pr checkout 42");
    // Read-only: no assignee/label mutation.
    expect(ghCall(calls, "pr edit 42 --add-assignee")).toBe(false);
    expect(ghCall(calls, "pr edit 42 --remove-label")).toBe(false);
  });

  it("multiple markers → warns + fetches the most recent (902)", async () => {
    const { deps, calls, logs } = makeHarness({
      markerIds: [901, 902],
      commentBody: `${MARK_O}\nnewest\n${MARK_C}`,
    });
    await runRehydrate({ pr: "42" }, deps);
    expect(logs.join("\n")).toMatch(/multiple agent-context comments/);
    expect(ghCall(calls, "issues/comments/902")).toBe(true);
    expect(ghCall(calls, "issues/comments/901")).toBe(false);
  });

  it("live-state query failure is a HARD error; note not shown", async () => {
    const { deps } = makeHarness({ markerIds: [900], liveStateFails: true });
    await expect(runRehydrate({ pr: "42" }, deps)).rejects.toThrow(/could not derive live state/);
  });

  it("strips control/ESC chars from the displayed note", async () => {
    const { deps } = makeHarness({
      markerIds: [900],
      commentBody: `${MARK_O}\nwhy: chose path 1\x1b[31mEND\n${MARK_C}`,
    });
    const r = await runRehydrate({ pr: "42" }, deps);
    expect(r.note).not.toContain("\x1b");
    expect(r.note).toContain("why: chose path 1");
  });

  it("non-numeric PR arg rejected before any gh call (no injectable footer)", async () => {
    const { deps, calls } = makeHarness({});
    await expect(runRehydrate({ pr: "42; echo PWNED" }, deps)).rejects.toThrow(
      /positive integer/,
    );
    expect(ghCall(calls, "pr view")).toBe(false);
  });

  it("no marker → live state + no-note (undefined note)", async () => {
    const { deps, calls } = makeHarness({ markerIds: [] });
    const r = await runRehydrate({ pr: "42" }, deps);
    expect(r.note).toBeUndefined();
    expect(ghCall(calls, "pr view 42 --json title,headRefName,mergeStateStatus")).toBe(true);
  });

  it("no PR resolvable → clear error", async () => {
    const { deps } = makeHarness({ prForBranch: "" });
    await expect(runRehydrate({}, deps)).rejects.toThrow(/no PR for this branch/);
  });
});

// ---------------------------------------------------------------------------
// runAccept (take the baton).
// ---------------------------------------------------------------------------

describe("runAccept", () => {
  it("assigns @me + removes label + rehydrates (live state shown)", async () => {
    const { deps, calls } = makeHarness({
      markerIds: [900],
      prLabels: ["handoff"],
      commentBody: `${MARK_O}\nwhy\n${MARK_C}`,
    });
    const r = await runAccept({ pr: "42" }, deps);
    expect(r.removedLabel).toBe(true);
    expect(ghCall(calls, "pr edit 42 --add-assignee @me")).toBe(true);
    expect(ghCall(calls, "pr edit 42 --remove-label handoff")).toBe(true);
    expect(r.rehydrate.liveState).toMatch(/mergeable/);
  });

  it("PR not on the stack → assigns + warns, still rehydrates", async () => {
    const { deps, calls, logs } = makeHarness({
      markerIds: [900],
      prLabels: [],
      commentBody: `${MARK_O}\nwhy\n${MARK_C}`,
    });
    const r = await runAccept({ pr: "42" }, deps);
    expect(r.removedLabel).toBe(false);
    expect(ghCall(calls, "pr edit 42 --add-assignee @me")).toBe(true);
    expect(logs.join("\n")).toMatch(/wasn't on the handoff stack/);
  });

  it("label-query gh error → 'couldn't check' (not misreported as off-stack)", async () => {
    const { deps, calls, logs } = makeHarness({
      markerIds: [900],
      labelsQueryFails: true,
      commentBody: `${MARK_O}\nwhy\n${MARK_C}`,
    });
    const r = await runAccept({ pr: "42" }, deps);
    expect(ghCall(calls, "pr edit 42 --add-assignee @me")).toBe(true);
    expect(logs.join("\n")).toMatch(/couldn't check/);
    expect(logs.join("\n")).not.toMatch(/wasn't on the handoff stack/);
  });

  it("no PR arg → errors, no mutation", async () => {
    const { deps, calls } = makeHarness({});
    await expect(runAccept({ pr: "" }, deps)).rejects.toThrow(HandoffError);
    expect(ghCall(calls, "pr edit")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runHandoffs (list the stack).
// ---------------------------------------------------------------------------

describe("runHandoffs", () => {
  it("queries open handoff-labeled PRs and renders OPEN vs owner rows", async () => {
    const stack = JSON.stringify([
      {
        number: 42,
        title: "fix the thing",
        headRefName: "feature/x",
        assignees: [],
        updatedAt: "2026-05-29T00:00:00Z",
      },
      {
        number: 7,
        title: "older work",
        headRefName: "feature/y",
        assignees: [{ login: "alice" }],
        updatedAt: "2026-05-28T00:00:00Z",
      },
    ]);
    const { deps, calls } = makeHarness({ stackJson: stack });
    const { entries } = await runHandoffs(deps);
    expect(ghCall(calls, "pr list --label handoff --state open")).toBe(true);
    // Sorted oldest → newest by updatedAt.
    expect(entries.map((e) => e.number)).toEqual([7, 42]);
    expect(entries[0]?.owner).toBe("alice");
    expect(entries[1]?.owner).toBeUndefined(); // OPEN
  });

  it("empty stack → no entries", async () => {
    const { deps } = makeHarness({ stackJson: "[]" });
    const { entries } = await runHandoffs(deps);
    expect(entries).toEqual([]);
  });
});
