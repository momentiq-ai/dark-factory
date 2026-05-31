import { describe, it, expect } from "vitest";
import {
  canonicalizeLinkRef,
  extractLinkedItems,
  formatLinkEntry,
  resolveLinkRef,
} from "../../src/handoff/links.js";
import { HandoffError, type GhClient, type PrView, type IssueView } from "../../src/handoff/ports.js";

const MARK_O = "<!-- agent-context:v1 -->";
const MARK_C = "<!-- /agent-context:v1 -->";

// Minimal GhClient stub — only prView + issueView are exercised by resolveLinkRef.
// Other methods throw "not called" to surface unintended calls.
function ghStub(opts: {
  prTitle?: string;
  prState?: PrView["state"];
  issueTitle?: string;
  issueLabels?: string[];
  prThrows?: boolean;
  issueThrows?: boolean;
}): GhClient {
  return {
    authStatus: async () => {},
    apiUserLogin: async () => "alien8d",
    ensureHandoffLabel: async () => {},
    issueViewSlim: async () => { throw new Error("issueViewSlim not expected"); },
    issueList: async () => [],
    issueCreate: async () => ({ number: 999, url: "https://github.com/o/r/issues/999" }),
    issueEditBody: async () => {},
    issueAddLabel: async () => {},
    issueAssignMe: async () => {},
    issueUnassignMe: async () => {},
    issueClose: async () => {},
    prListByHead: async () => [],
    prView: async (num) => {
      if (opts.prThrows) throw new Error("gh pr view failed");
      return {
        title: opts.prTitle ?? `PR ${num}`,
        state: opts.prState ?? "OPEN",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        statusCheckRollup: [],
      };
    },
    issueView: async (num) => {
      if (opts.issueThrows) throw new Error("gh issue view failed");
      return {
        number: num,
        title: opts.issueTitle ?? `issue ${num}`,
        body: "",
        state: "OPEN",
        assignees: [],
        labels: (opts.issueLabels ?? []).map((n) => ({ name: n })),
        updatedAt: "2026-05-30T00:00:00Z",
        closedAt: null,
      };
    },
  };
}

describe("links — canonicalizeLinkRef (no fetch)", () => {
  it("bare number → kind='', display='#N'", () => {
    expect(canonicalizeLinkRef("103")).toEqual({ kind: "", display: "#103" });
  });
  it("owner/repo#N → kind='', display='owner/repo#N'", () => {
    expect(canonicalizeLinkRef("momentiq-ai/dark-factory#59")).toEqual({
      kind: "",
      display: "momentiq-ai/dark-factory#59",
    });
  });
  it("pr:N prefix → kind='pr', display='#N'", () => {
    expect(canonicalizeLinkRef("pr:103")).toEqual({ kind: "pr", display: "#103" });
  });
  it("issue:N prefix → kind='issue', display='#N'", () => {
    expect(canonicalizeLinkRef("issue:91")).toEqual({ kind: "issue", display: "#91" });
  });
  it("URL /pull/ → kind='pr', display='owner/repo#N'", () => {
    expect(
      canonicalizeLinkRef("https://github.com/m/r/pull/103?tab=files"),
    ).toEqual({ kind: "pr", display: "m/r#103" });
  });
  it("URL /issues/ → kind='issue', display='owner/repo#N'", () => {
    expect(
      canonicalizeLinkRef("https://github.com/m/r/issues/91"),
    ).toEqual({ kind: "issue", display: "m/r#91" });
  });
  it("URL /pull/ with trailing path → kind='pr', display='owner/repo#N'", () => {
    expect(
      canonicalizeLinkRef("https://github.com/m/r/pull/103/files"),
    ).toEqual({ kind: "pr", display: "m/r#103" });
  });
});

describe("links — resolveLinkRef (with GhClient stub)", () => {
  it("PR-first: resolves bare number as PR when pr view succeeds", async () => {
    const gh = ghStub({ prTitle: "deploy spec" });
    expect(await resolveLinkRef("103", gh)).toEqual({
      kind: "pr",
      display: "#103",
      title: "deploy spec",
    });
  });

  it("Falls back to issue when pr view fails", async () => {
    const gh = ghStub({ prThrows: true, issueTitle: "vendor degradation" });
    expect(await resolveLinkRef("91", gh)).toEqual({
      kind: "issue",
      display: "#91",
      title: "vendor degradation",
    });
  });

  it("pr:N short-circuits to PR lookup", async () => {
    const gh = ghStub({ prTitle: "explicit PR" });
    const r = await resolveLinkRef("pr:42", gh);
    expect(r.kind).toBe("pr");
    expect(r.title).toBe("explicit PR");
  });

  it("issue:N short-circuits PR lookup (kind='issue', prView not called)", async () => {
    const prViewCalls: number[] = [];
    const gh: GhClient = {
      ...ghStub({ issueTitle: "explicit issue" }),
      prView: async (num) => {
        prViewCalls.push(num);
        throw new Error("prView should not be called for issue: prefix");
      },
    };
    const r = await resolveLinkRef("issue:42", gh);
    expect(r.kind).toBe("issue");
    expect(prViewCalls).toHaveLength(0);
  });

  it("refuses to link a handoff-labeled issue (no link-cycles)", async () => {
    const gh = ghStub({
      prThrows: true,
      issueLabels: ["handoff"],
      issueTitle: "another handoff",
    });
    await expect(resolveLinkRef("issue:999", gh)).rejects.toThrow(/no link-cycles/);
  });

  it("project URL refused with deferred-to-12.2 message", async () => {
    const gh = ghStub({});
    await expect(
      resolveLinkRef("https://github.com/orgs/m/projects/3", gh),
    ).rejects.toThrow(/deferred to Phase 12\.2/i);
  });

  it("project URL (per-repo) refused with deferred-to-12.2 message", async () => {
    const gh = ghStub({});
    await expect(
      resolveLinkRef("https://github.com/m/r/projects/3", gh),
    ).rejects.toThrow(/deferred to Phase 12\.2/i);
  });

  it("non-number / non-URL ref → clear error", async () => {
    const gh = ghStub({});
    await expect(resolveLinkRef("garbage", gh)).rejects.toThrow(
      /not a number, owner\/repo#N, or supported URL/,
    );
  });

  it("ref 0 → positive-integer error", async () => {
    const gh = ghStub({});
    await expect(resolveLinkRef("0", gh)).rejects.toThrow(/positive integer/);
  });

  it("ref with leading zero → positive-integer error", async () => {
    const gh = ghStub({});
    await expect(resolveLinkRef("042", gh)).rejects.toThrow(/positive integer/);
  });

  it("cross-repo via owner/repo#N → uses repo override on gh", async () => {
    let capturedOpts: { repo?: string } | undefined;
    const gh: GhClient = {
      ...ghStub({ prTitle: "x" }),
      prView: async (num, opts) => {
        capturedOpts = opts;
        return {
          title: "cross-repo PR",
          state: "OPEN",
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          statusCheckRollup: [],
        };
      },
    };
    const r = await resolveLinkRef("momentiq-ai/dark-factory#59", gh);
    expect(r).toEqual({
      kind: "pr",
      display: "momentiq-ai/dark-factory#59",
      title: "cross-repo PR",
    });
    expect(capturedOpts).toEqual({ repo: "momentiq-ai/dark-factory" });
  });

  it("both PR and issue lookup fail → 'not found' error", async () => {
    const gh = ghStub({ prThrows: true, issueThrows: true });
    await expect(resolveLinkRef("42", gh)).rejects.toThrow(
      /not found as PR or Issue in this repo/,
    );
  });

  it("bare-ref PR-fail → issue-with-handoff-label → refused (full chain)", async () => {
    // PR lookup fails (e.g., gh treats N as not a PR), falls through to issue lookup,
    // which returns a handoff-labeled issue → link-cycle refusal raises.
    const gh = ghStub({
      prThrows: true,
      issueLabels: ["handoff"],
      issueTitle: "another handoff",
    });
    await expect(resolveLinkRef("999", gh)).rejects.toThrow(/no link-cycles/);
  });
});

describe("links — extractLinkedItems (in-marker scoping)", () => {
  it("returns empty when no marker block", () => {
    expect(extractLinkedItems("body without markers")).toEqual([]);
  });
  it("returns entries from inside the LATEST marker block", () => {
    const body =
      `**Linked work items:**\n- pr #999 — STALE outside\n\n` +
      `${MARK_O}\n**Linked work items:**\n- pr #103 — canonical\n- issue #91 — degradation\n${MARK_C}`;
    expect(extractLinkedItems(body)).toEqual([
      "- pr #103 — canonical",
      "- issue #91 — degradation",
    ]);
  });
  it("skips '_None linked._' line", () => {
    const body = `${MARK_O}\n**Linked work items:**\n_None linked._\n${MARK_C}`;
    expect(extractLinkedItems(body)).toEqual([]);
  });
  it("returns empty when in-marker block has no Linked work items section", () => {
    const body = `${MARK_O}\nreasoning only\n${MARK_C}`;
    expect(extractLinkedItems(body)).toEqual([]);
  });
  it("a non-item, non-blank line terminates the section (bash parity)", () => {
    // Bash awk: `if (inblk==1) inblk=0` — arbitrary prose ends the section, so
    // anything after `- other random line` (including `- issue #91 — also ok`)
    // is dropped. `_None linked._` and blank lines are still skipped (they
    // match earlier branches), but arbitrary text terminates. The TS port
    // preserves this exactly to keep parity with the bash extractor (the
    // discriminating constraint for Task 21 parity snapshots).
    const body =
      `${MARK_O}\n**Linked work items:**\n- pr #103 — ok\n- other random line\n- issue #91 — also ok\n${MARK_C}`;
    expect(extractLinkedItems(body)).toEqual(["- pr #103 — ok"]);
  });
});

describe("links — formatLinkEntry", () => {
  it("formats as '- <kind> <display> — <title>'", () => {
    expect(formatLinkEntry({ kind: "pr", display: "#103", title: "deploy" })).toBe(
      "- pr #103 — deploy",
    );
  });
  it("preserves tabs in title (no \\x1e delimiter — JS doesn't need it)", () => {
    expect(
      formatLinkEntry({ kind: "pr", display: "#503", title: "title with\ttab" }),
    ).toBe("- pr #503 — title with\ttab");
  });
  it("cross-repo display preserved verbatim", () => {
    expect(
      formatLinkEntry({ kind: "issue", display: "owner/repo#91", title: "cross" }),
    ).toBe("- issue owner/repo#91 — cross");
  });
});
