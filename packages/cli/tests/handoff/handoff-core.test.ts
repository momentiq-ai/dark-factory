// Hermetic tests for the agent handoff protocol core (Cycle 12 — Issue-anchored).
//
// The TypeScript analog of the dogfooded Phase 12.1 bash test suite
// (.claude/skills/handoff/tests/test_handoff.sh in dark-factory-platform).
// The bash stubbed `gh`/`git` on PATH; here we inject `gh`/`git` runners
// (the core's load-bearing testability decision) and assert CONTROL FLOW
// — which gh calls happen in what sequence — without any network.
//
// This file is the BASELINE for the Cycle 12 verb tests. The detailed
// per-verb case set (Phase 12.3 scaffold tests) will inherit the
// fixtures + helpers here.
//
// The fixtures use key-SHAPED values (AKIA…, sk-ant-…, AWS_SECRET_ACCESS_KEY=)
// not real secrets, so neither this file nor the source trips the repo's
// own secrets-scan — same discipline the bash fixtures used.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  HandoffError,
  REHYDRATE_CLOSED_WINDOW_DAYS,
  _execForTest,
  _resetMeLoginCacheForTest,
  assigneesStatus,
  canonicalizeLinkRef,
  extractLinkedItems,
  formatAge,
  isoToEpoch,
  requireIssueNumber,
  requireSafeArgs,
  runAccept,
  runHandoff,
  runHandoffs,
  runRehydrate,
  scrubSecrets,
  spliceAgentContextBlock,
  stripControlChars,
  validateLatestBlock,
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

// ---------------------------------------------------------------------------
// Test plumbing: makeGh helper + standard fake git runner.
// ---------------------------------------------------------------------------

interface Call {
  readonly bin: "gh" | "git";
  readonly args: readonly string[];
  readonly input?: string;
}

function makeGh(
  handler: (args: readonly string[], options?: { input?: string }) => ExecResult,
): GhRunner {
  return async (args, options) => {
    return handler(args, options);
  };
}

function makeGit(
  handler: (args: readonly string[]) => ExecResult = () => OK,
): GitRunner {
  return async (args) => handler(args);
}

function makeDeps(
  gh: GhRunner,
  git: GitRunner = makeGit(),
): { deps: HandoffDeps; calls: Call[]; logs: string[] } {
  const calls: Call[] = [];
  const logs: string[] = [];
  const wrappedGh: GhRunner = async (args, options) => {
    calls.push({
      bin: "gh",
      args,
      ...(options?.input !== undefined ? { input: options.input } : {}),
    });
    return gh(args, options);
  };
  const wrappedGit: GitRunner = async (args) => {
    calls.push({ bin: "git", args });
    return git(args);
  };
  return {
    deps: { gh: wrappedGh, git: wrappedGit, log: (l) => logs.push(l) },
    calls,
    logs,
  };
}

beforeEach(() => {
  _resetMeLoginCacheForTest();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helper tests — pure functions (no harness).
// ---------------------------------------------------------------------------

describe("scrubSecrets", () => {
  it("clean prose passes", () => {
    expect(scrubSecrets("just prose, no secrets").clean).toBe(true);
  });

  it("AWS access key id is refused AND the matched value is NOT in the output", () => {
    const body = "ok\nleftover: AKIAIOSFODNN7EXAMPLE\n";
    const r = scrubSecrets(body);
    expect(r.clean).toBe(false);
    expect(r.lines).toEqual([2]);
    // Security regression guard: the result carries ONLY line numbers, never matched content.
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("GitHub personal/installation token shape", () => {
    expect(scrubSecrets(`ghp_${"a".repeat(36)}`).clean).toBe(false);
  });

  it("Slack token shape", () => {
    expect(scrubSecrets("xoxb-abc-def-ghi").clean).toBe(false);
  });

  it("OpenAI / Anthropic / Google provider keys", () => {
    expect(scrubSecrets("sk-ant-api03-FAKEKEYvalue0123456789abcdef").clean).toBe(false);
    expect(scrubSecrets("sk-proj-FAKEKEYvalue0123456789").clean).toBe(false);
    expect(scrubSecrets("AIzaFAKEKEYvalue0123456789abcdef").clean).toBe(false);
  });

  it("credentialed connection string (postgres://u:p@h)", () => {
    expect(
      scrubSecrets("postgres://admin:hunter2@db.internal:5432/app").clean,
    ).toBe(false);
  });

  it("credential file path (.aws/credentials)", () => {
    expect(
      scrubSecrets("the app key lives in ~/.aws/credentials on the box").clean,
    ).toBe(false);
  });

  it("env-var secret name (AWS_SECRET_ACCESS_KEY=val)", () => {
    expect(
      scrubSecrets("AWS_SECRET_ACCESS_KEY=FAKEsecretvalueEXAMPLE0123456789").clean,
    ).toBe(false);
    expect(scrubSecrets("GITHUB_TOKEN=x").clean).toBe(false);
    expect(scrubSecrets("DB_PASSWORD=x").clean).toBe(false);
  });

  it("PEM block (-----BEGIN)", () => {
    expect(scrubSecrets("-----BEGIN RSA blah").clean).toBe(false);
  });

  it("happy-path setup-step body passes", () => {
    const body = `${MARK_O}\nwhy: rephrased the trap as a SETUP STEP (no values)\n${MARK_C}`;
    expect(scrubSecrets(body).clean).toBe(true);
  });
});

describe("validateNoteMarkers + validateLatestBlock", () => {
  it("well-formed single-block body (open + close on separate lines) passes both", () => {
    // Both validators require open and close on DIFFERENT lines (the bash
    // uses NR for line indices); a single-line block is correctly refused.
    const b = `${MARK_O}\nx\n${MARK_C}`;
    expect(validateNoteMarkers(b)).toBe(true);
    expect(validateLatestBlock(b)).toBe(true);
  });

  it("single-line block (markers on same line) refused by validateLatestBlock", () => {
    // The latest-block extractor scans by line; same-line markers can't
    // form a multi-line block, so accept refuses such a note as malformed.
    const b = `${MARK_O} x ${MARK_C}`;
    // validateNoteMarkers uses character-position; that's looser.
    expect(validateNoteMarkers(b)).toBe(true);
    expect(validateLatestBlock(b)).toBe(false);
  });

  it("missing markers refused by both", () => {
    expect(validateNoteMarkers("no markers")).toBe(false);
    expect(validateLatestBlock("no markers")).toBe(false);
  });

  it("reversed markers (close before open) refused", () => {
    expect(validateNoteMarkers(`${MARK_C} ${MARK_O}`)).toBe(false);
  });

  it("multi-block: validateLatestBlock checks the LAST block", () => {
    // Two valid blocks → valid (last block OK).
    const twoOk = `${MARK_O}\nfirst\n${MARK_C}\nstuff\n${MARK_O}\nsecond\n${MARK_C}\n`;
    expect(validateLatestBlock(twoOk)).toBe(true);
    // Old valid block + dangling open at end → invalid (last open has no close after it).
    const danglingOpen = `${MARK_O}\nold\n${MARK_C}\nstuff\n${MARK_O}\nmid\n`;
    expect(validateLatestBlock(danglingOpen)).toBe(false);
  });
});

describe("spliceAgentContextBlock", () => {
  it("replaces existing block in place, preserves text outside", () => {
    const oldBody = `intro text\n${MARK_O}\nold inner\n${MARK_C}\noutro text\n`;
    const newBlock = `${MARK_O}\nNEW INNER\n${MARK_C}`;
    const r = spliceAgentContextBlock(oldBody, newBlock);
    expect(r).toContain("intro text");
    expect(r).toContain("NEW INNER");
    expect(r).toContain("outro text");
    expect(r).not.toContain("old inner");
  });

  it("multi-block: replaces FIRST open through LAST close (single new block)", () => {
    const oldBody = `${MARK_O}\nold1\n${MARK_C}\nmid text\n${MARK_O}\nold2\n${MARK_C}\n`;
    const newBlock = `${MARK_O}\nNEW\n${MARK_C}`;
    const r = spliceAgentContextBlock(oldBody, newBlock);
    expect(r).toContain("NEW");
    expect(r).not.toContain("old1");
    expect(r).not.toContain("old2");
    expect(r).not.toContain("mid text");
  });

  it("no markers in old body → appends with separator", () => {
    const oldBody = "preamble text";
    const newBlock = `${MARK_O}\nbody\n${MARK_C}`;
    const r = spliceAgentContextBlock(oldBody, newBlock);
    expect(r.startsWith("preamble text")).toBe(true);
    expect(r).toContain(MARK_O);
    expect(r).toContain("body");
  });

  it("empty old body → returns the new block as-is", () => {
    const newBlock = `${MARK_O}\nbody\n${MARK_C}`;
    expect(spliceAgentContextBlock("", newBlock)).toBe(newBlock);
  });
});

describe("canonicalizeLinkRef", () => {
  it("bare number → empty kind, #N display", () => {
    expect(canonicalizeLinkRef("103")).toEqual({ kind: "", display: "#103" });
  });

  it("pr:N → kind=pr, #N display", () => {
    expect(canonicalizeLinkRef("pr:103")).toEqual({ kind: "pr", display: "#103" });
  });

  it("issue:N → kind=issue, #N display", () => {
    expect(canonicalizeLinkRef("issue:91")).toEqual({ kind: "issue", display: "#91" });
  });

  it("owner/repo#N → kind empty (no type hint), full display", () => {
    expect(canonicalizeLinkRef("momentiq-ai/dark-factory#59")).toEqual({
      kind: "",
      display: "momentiq-ai/dark-factory#59",
    });
  });

  it("pull URL → kind=pr, owner/repo#N display", () => {
    expect(
      canonicalizeLinkRef("https://github.com/momentiq-ai/dark-factory/pull/103"),
    ).toEqual({ kind: "pr", display: "momentiq-ai/dark-factory#103" });
  });

  it("issues URL → kind=issue, owner/repo#N display", () => {
    expect(
      canonicalizeLinkRef("https://github.com/momentiq-ai/dark-factory-platform/issues/91"),
    ).toEqual({ kind: "issue", display: "momentiq-ai/dark-factory-platform#91" });
  });
});

describe("extractLinkedItems", () => {
  it("finds entries in the LATEST agent-context block", () => {
    const body = `${MARK_O}
**Linked work items:**
- pr #103 — old title
- issue #91 — old issue
${MARK_C}
some text
${MARK_O}
**Linked work items:**
- pr #200 — new title
- issue momentiq-ai/dark-factory#59 — cross-repo
${MARK_C}
`;
    const items = extractLinkedItems(body);
    expect(items).toEqual([
      "- pr #200 — new title",
      "- issue momentiq-ai/dark-factory#59 — cross-repo",
    ]);
  });

  it("ignores entries outside the markers", () => {
    const body = `stray text outside
- pr #999 — should NOT be picked
${MARK_O}
**Linked work items:**
- pr #200 — real entry
${MARK_C}
`;
    const items = extractLinkedItems(body);
    expect(items).toEqual(["- pr #200 — real entry"]);
  });

  it("empty body → empty list", () => {
    expect(extractLinkedItems("")).toEqual([]);
  });

  it("body without markers → empty list", () => {
    expect(extractLinkedItems("nothing to see here")).toEqual([]);
  });
});

describe("formatAge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00Z"));
  });

  it("just now (< 60s)", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatAge(now - 30)).toBe("just now");
  });

  it("Nm ago (< 1h)", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatAge(now - 300)).toBe("5m ago");
  });

  it("Nh ago (< 1d)", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatAge(now - 2 * 3600)).toBe("2h ago");
  });

  it("Nd ago (>= 1d)", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatAge(now - 3 * 86400)).toBe("3d ago");
  });
});

describe("isoToEpoch", () => {
  it("valid Z-suffix", () => {
    const e = isoToEpoch("2026-05-30T12:00:00Z");
    expect(typeof e).toBe("number");
    expect(e).toBeGreaterThan(0);
  });

  it("valid fractional seconds", () => {
    const e = isoToEpoch("2026-05-30T12:00:00.123Z");
    expect(typeof e).toBe("number");
  });

  it("valid numeric offset", () => {
    const e = isoToEpoch("2026-05-30T12:00:00+00:00");
    expect(typeof e).toBe("number");
  });

  it("garbage → undefined (NEVER 0 — the bash explicitly notes this)", () => {
    expect(isoToEpoch("not a date")).toBeUndefined();
    expect(isoToEpoch("")).toBeUndefined();
  });
});

describe("assigneesStatus", () => {
  it("empty → 'empty'", () => {
    expect(assigneesStatus([], "alice")).toBe("empty");
  });

  it("[@me] → 'me'", () => {
    expect(assigneesStatus([{ login: "alice" }], "alice")).toBe("me");
  });

  it("[@other] → 'other'", () => {
    expect(assigneesStatus([{ login: "bob" }], "alice")).toBe("other");
  });

  it("[@me, @other] (multi-assignee collision) → 'other'", () => {
    expect(
      assigneesStatus([{ login: "alice" }, { login: "bob" }], "alice"),
    ).toBe("other");
  });
});

describe("requireIssueNumber", () => {
  it("positive integer OK", () => {
    expect(() => requireIssueNumber("42")).not.toThrow();
  });

  it("empty/undefined OK (no-arg path resolves later)", () => {
    expect(() => requireIssueNumber(undefined)).not.toThrow();
    expect(() => requireIssueNumber("")).not.toThrow();
  });

  it("0 refused", () => {
    expect(() => requireIssueNumber("0")).toThrow(/positive integer/);
  });

  it("leading zero refused", () => {
    expect(() => requireIssueNumber("0042")).toThrow(/positive integer/);
  });

  it("non-numeric refused", () => {
    expect(() => requireIssueNumber("abc")).toThrow(/positive integer/);
  });

  it("injection payload refused", () => {
    expect(() => requireIssueNumber("42; echo PWNED")).toThrow(
      /positive integer/,
    );
  });
});

describe("requireSafeArgs", () => {
  it("clean ref tokens OK", () => {
    expect(() =>
      requireSafeArgs("42", "--link", "momentiq-ai/dark-factory#59"),
    ).not.toThrow();
    expect(() =>
      requireSafeArgs("https://github.com/o/r/pull/103?tab=files"),
    ).not.toThrow();
  });

  it("semicolon refused", () => {
    expect(() => requireSafeArgs("42; rm -rf /")).toThrow(
      /disallowed characters/,
    );
  });

  it("backtick refused", () => {
    expect(() => requireSafeArgs("foo`pwd`bar")).toThrow(
      /disallowed characters/,
    );
  });

  it("dollar-sign refused", () => {
    expect(() => requireSafeArgs("$(rm -rf /)")).toThrow(
      /disallowed characters/,
    );
  });
});

describe("stripControlChars", () => {
  it("removes ESC/control bytes but keeps tab + newline", () => {
    const dirty = `a\x1b[31mRED\tkeep\nline`;
    const clean = stripControlChars(dirty);
    expect(clean).not.toContain("\x1b");
    expect(clean).toContain("\t");
    expect(clean).toContain("\n");
    expect(clean).toContain("RED");
  });
});

describe("REHYDRATE_CLOSED_WINDOW_DAYS", () => {
  it("matches the bash spec value (7d)", () => {
    expect(REHYDRATE_CLOSED_WINDOW_DAYS).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Spawn-runner regression guards (the stdin-input bug the bash bypassed).
// ---------------------------------------------------------------------------

describe("spawn runner (regression guards)", () => {
  it("ACTUALLY delivers options.input to the child's stdin", async () => {
    const payload = "hello-from-stdin\nwith newline";
    const r = await _execForTest("cat", [], { input: payload });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(payload);
  });

  it("surfaces a missing binary as code 127 (not a crash)", async () => {
    const r = await _execForTest("df-no-such-binary-xyz-123", []);
    expect(r.code).toBe(127);
  });
});

// ---------------------------------------------------------------------------
// Verb smoke tests — one happy-path per verb (T3-T6 will add detailed cases).
// ---------------------------------------------------------------------------

describe("runHandoff (happy-path)", () => {
  it("explicit issue, valid open handoff → upserts body + label + unassign", async () => {
    const me = "alice";
    const initialBody = `${MARK_O}\nold body\n**Linked work items:**\n_None linked._\n${MARK_C}\n`;
    let getCount = 0;
    const gh = makeGh((args) => {
      const a = args.join(" ");
      if (a === "--version") return out("gh version 2.0.0\n");
      if (a === "auth status") return OK;
      if (a === "api user --jq .login") return out(`${me}\n`);
      if (a.startsWith("issue view 42 --json state,labels,assignees,body,updatedAt")) {
        // Initial fetch.
        getCount += 1;
        return out(
          JSON.stringify({
            state: "OPEN",
            labels: [{ name: "handoff" }],
            assignees: [],
            body: initialBody,
            updatedAt: "2026-05-30T00:00:00Z",
          }),
        );
      }
      if (a.startsWith("issue view 42 --json state,assignees,body,updatedAt")) {
        // Pre-PATCH race re-fetch.
        return out(
          JSON.stringify({
            state: "OPEN",
            assignees: [],
            body: initialBody,
            updatedAt: "2026-05-30T00:00:00Z",
          }),
        );
      }
      if (a.startsWith("issue edit 42 --body-file")) return OK;
      if (a.startsWith("label create handoff")) return OK;
      if (a.startsWith("issue edit 42 --add-label handoff")) return OK;
      if (a.startsWith("issue edit 42 --remove-assignee @me")) return OK;
      return OK;
    });
    const { deps, calls } = makeDeps(gh);
    const result = await runHandoff({ note: note(), issue: "42" }, deps);
    expect(result.issue).toBe("42");
    expect(result.created).toBe(false);
    // Sequence assertions: at least one body-file edit, then label, then remove-assignee.
    const editIdx = calls.findIndex((c) =>
      c.bin === "gh" && c.args.join(" ").startsWith("issue edit 42 --body-file"),
    );
    const labelIdx = calls.findIndex((c) =>
      c.bin === "gh" &&
      c.args.join(" ").startsWith("issue edit 42 --add-label handoff"),
    );
    const removeIdx = calls.findIndex((c) =>
      c.bin === "gh" &&
      c.args.join(" ").startsWith("issue edit 42 --remove-assignee @me"),
    );
    expect(editIdx).toBeGreaterThan(0);
    expect(labelIdx).toBeGreaterThan(editIdx);
    expect(removeIdx).toBeGreaterThan(editIdx);
    expect(getCount).toBe(1);
  });
});

describe("runAccept (happy-path)", () => {
  it("valid claimable handoff → assign + close (atomic chain runs)", async () => {
    const me = "alice";
    const issueBody = `${MARK_O}\nbody with reasoning\n${MARK_C}\n`;
    const gh = makeGh((args) => {
      const a = args.join(" ");
      if (a === "--version") return out("gh version 2.0.0\n");
      if (a === "auth status") return OK;
      if (a === "api user --jq .login") return out(`${me}\n`);
      // Step 1 validate
      if (a === "issue view 42 --json state,labels,assignees,body,updatedAt") {
        return out(
          JSON.stringify({
            state: "OPEN",
            labels: [{ name: "handoff" }],
            assignees: [],
            body: issueBody,
            updatedAt: "2026-05-30T00:00:00Z",
          }),
        );
      }
      // Step 3 doRehydrate
      if (a === "issue view 42 --json number,title,state,assignees,labels,closedAt,updatedAt,body") {
        return out(
          JSON.stringify({
            number: 42,
            title: "handoff: feature/x",
            state: "OPEN",
            assignees: [],
            labels: [{ name: "handoff" }],
            closedAt: null,
            updatedAt: "2026-05-30T00:00:00Z",
            body: issueBody,
          }),
        );
      }
      // Step 4 drift
      if (a === "issue view 42 --json state,assignees,updatedAt") {
        return out(
          JSON.stringify({
            state: "OPEN",
            assignees: [],
            updatedAt: "2026-05-30T00:00:00Z",
          }),
        );
      }
      // Step 5 assign
      if (a === "issue edit 42 --add-assignee @me") return OK;
      // Step 6 post-assign verify
      if (a === "issue view 42 --json assignees") {
        return out(JSON.stringify({ assignees: [{ login: me }] }));
      }
      // Step 7 close
      if (a === "issue close 42") return OK;
      return OK;
    });
    const { deps, calls } = makeDeps(gh);
    const result = await runAccept({ issue: "42" }, deps);
    expect(result.issue).toBe("42");
    expect(result.rehydrate.text).toContain("LIVE STATE");
    // Atomic ordering: assign BEFORE close.
    const assignIdx = calls.findIndex((c) =>
      c.bin === "gh" && c.args.join(" ") === "issue edit 42 --add-assignee @me",
    );
    const verifyIdx = calls.findIndex((c) =>
      c.bin === "gh" && c.args.join(" ") === "issue view 42 --json assignees",
    );
    const closeIdx = calls.findIndex((c) =>
      c.bin === "gh" && c.args.join(" ") === "issue close 42",
    );
    expect(assignIdx).toBeGreaterThan(0);
    expect(verifyIdx).toBeGreaterThan(assignIdx);
    expect(closeIdx).toBeGreaterThan(verifyIdx);
  });
});

describe("runRehydrate (happy-path)", () => {
  it("explicit issue → text contains LIVE STATE header", async () => {
    const me = "alice";
    const body = `${MARK_O}\nreasoning here\n${MARK_C}\n`;
    const gh = makeGh((args) => {
      const a = args.join(" ");
      if (a === "--version") return out("gh version 2.0.0\n");
      if (a === "auth status") return OK;
      if (a === "api user --jq .login") return out(`${me}\n`);
      if (a === "issue view 42 --json number,title,state,assignees,labels,closedAt,updatedAt,body") {
        return out(
          JSON.stringify({
            number: 42,
            title: "test handoff",
            state: "OPEN",
            assignees: [],
            labels: [{ name: "handoff" }],
            closedAt: null,
            updatedAt: "2026-05-30T00:00:00Z",
            body,
          }),
        );
      }
      return OK;
    });
    const { deps } = makeDeps(gh);
    const r = await runRehydrate({ issue: "42" }, deps);
    expect(r.issue).toBe("42");
    expect(r.text).toContain("LIVE STATE");
    expect(r.text).toContain("reasoning here");
    expect(r.hasUnreachable).toBe(false);
  });
});

describe("runHandoffs (happy-path)", () => {
  it("empty stack → empty rows + the right empty-stack text", async () => {
    const gh = makeGh((args) => {
      const a = args.join(" ");
      if (a === "--version") return out("gh version 2.0.0\n");
      if (a === "auth status") return OK;
      if (a.startsWith("issue list --label handoff --state open --search no:assignee")) {
        return out("[]");
      }
      return OK;
    });
    const { deps } = makeDeps(gh);
    const r = await runHandoffs(deps);
    expect(r.rows).toEqual([]);
    expect(r.text).toContain("handoff stack is empty");
    expect(r.text).toContain("(no open, unassigned issues labeled 'handoff')");
  });

  it("non-empty stack → renders #N · title · age · linked: <none|N items>", async () => {
    const stack = JSON.stringify([
      {
        number: 7,
        title: "older work",
        createdAt: "2026-05-28T00:00:00Z",
        updatedAt: "2026-05-28T00:00:00Z",
        body: "",
      },
      {
        number: 42,
        title: "fix the thing",
        createdAt: "2026-05-29T00:00:00Z",
        updatedAt: "2026-05-29T00:00:00Z",
        body: `${MARK_O}\n**Linked work items:**\n- pr #100 — alpha\n- issue #200 — beta\n${MARK_C}\n`,
      },
    ]);
    const gh = makeGh((args) => {
      const a = args.join(" ");
      if (a === "--version") return out("gh version 2.0.0\n");
      if (a === "auth status") return OK;
      if (a.startsWith("issue list --label handoff --state open --search no:assignee")) {
        return out(stack);
      }
      return OK;
    });
    const { deps } = makeDeps(gh);
    const r = await runHandoffs(deps);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]?.number).toBe(7);
    expect(r.rows[0]?.linkedCount).toBe(0);
    expect(r.rows[1]?.linkedCount).toBe(2);
    expect(r.text).toContain("#7 · older work");
    expect(r.text).toContain("#42 · fix the thing");
    expect(r.text).toContain("linked: none");
    expect(r.text).toContain("linked: 2 items");
  });
});

// ---------------------------------------------------------------------------
// Verb error-path smoke tests (kept minimal — detailed cases land in T3-T6).
// ---------------------------------------------------------------------------

describe("runHandoff (refuse paths)", () => {
  it("empty note body → refuses without any network call", async () => {
    const gh = makeGh((args) => {
      const a = args.join(" ");
      if (a === "--version") return out("gh version 2.0.0\n");
      if (a === "auth status") return OK;
      return OK;
    });
    const { deps, calls } = makeDeps(gh);
    await expect(runHandoff({ note: "   \n" }, deps)).rejects.toThrow(
      /empty note body/,
    );
    // Only the requireTools preflight calls should have fired.
    const apiUserCall = calls.find(
      (c) => c.bin === "gh" && c.args.join(" ").startsWith("api user"),
    );
    expect(apiUserCall).toBeUndefined();
  });

  it("malformed markers → refuses before any gh fetch", async () => {
    const gh = makeGh((args) => {
      const a = args.join(" ");
      if (a === "--version") return out("gh version 2.0.0\n");
      if (a === "auth status") return OK;
      return OK;
    });
    const { deps, calls } = makeDeps(gh);
    await expect(
      runHandoff({ note: "just text, no markers" }, deps),
    ).rejects.toThrow(/marker/);
    const issueCall = calls.find(
      (c) => c.bin === "gh" && c.args.join(" ").startsWith("issue"),
    );
    expect(issueCall).toBeUndefined();
  });

  it("secret-shaped body → refuses with HandoffError; body content NOT echoed", async () => {
    const gh = makeGh((args) => {
      const a = args.join(" ");
      if (a === "--version") return out("gh version 2.0.0\n");
      if (a === "auth status") return OK;
      return OK;
    });
    const { deps, calls, logs } = makeDeps(gh);
    const body = `${MARK_O}\nleftover: AKIAIOSFODNN7EXAMPLE\n${MARK_C}\n`;
    await expect(runHandoff({ note: body, issue: "42" }, deps)).rejects.toThrow(
      HandoffError,
    );
    // No gh issue calls.
    const issueCall = calls.find(
      (c) => c.bin === "gh" && c.args.join(" ").startsWith("issue"),
    );
    expect(issueCall).toBeUndefined();
    // The log line refers to line number only — the matched substring is NOT in the log.
    expect(logs.join("\n")).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("runAccept (refuse paths)", () => {
  it("no issue arg → errors without any mutation", async () => {
    const gh = makeGh((args) => {
      const a = args.join(" ");
      if (a === "--version") return out("gh version 2.0.0\n");
      if (a === "auth status") return OK;
      return OK;
    });
    const { deps } = makeDeps(gh);
    await expect(runAccept({ issue: "" }, deps)).rejects.toThrow(
      HandoffError,
    );
  });

  it("closed handoff → refuses (already accepted)", async () => {
    const gh = makeGh((args) => {
      const a = args.join(" ");
      if (a === "--version") return out("gh version 2.0.0\n");
      if (a === "auth status") return OK;
      if (a === "api user --jq .login") return out("alice\n");
      if (a === "issue view 42 --json state,labels,assignees,body,updatedAt") {
        return out(
          JSON.stringify({
            state: "CLOSED",
            labels: [{ name: "handoff" }],
            assignees: [],
            body: `${MARK_O}\nbody\n${MARK_C}`,
            updatedAt: "2026-05-30T00:00:00Z",
          }),
        );
      }
      return OK;
    });
    const { deps } = makeDeps(gh);
    await expect(runAccept({ issue: "42" }, deps)).rejects.toThrow(
      /already accepted/,
    );
  });
});
