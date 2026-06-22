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

// Per-number issue fake for cycle-detection tests (#229): maps issue number →
// { labels, body, title }. prView always throws so resolveLinkRef takes the
// issue path; bodies carry in-marker `**Linked work items:**` sections so
// extractLinkedItems (and thus the cycle walk) sees the handoff→handoff edges.
// `viewed` records the issueView call order so a test can assert the walk
// actually traversed (or did NOT start).
function ghIssueGraph(
  issues: Record<number, { labels?: string[]; body?: string; title?: string }>,
): { gh: GhClient; viewed: number[] } {
  const viewed: number[] = [];
  const gh: GhClient = {
    ...ghStub({ prThrows: true }),
    issueView: async (num) => {
      viewed.push(num);
      const cfg = issues[num];
      if (!cfg) throw new Error(`gh issue view ${num}: not found`);
      return {
        number: num,
        title: cfg.title ?? `issue ${num}`,
        body: cfg.body ?? "",
        state: "OPEN",
        assignees: [],
        labels: (cfg.labels ?? []).map((n) => ({ name: n })),
        updatedAt: "2026-05-30T00:00:00Z",
        closedAt: null,
      };
    },
  };
  return { gh, viewed };
}

// A handoff body whose in-marker linked-items section references the given
// same-repo issue numbers (plus optional extra raw entries, e.g. a PR or a
// cross-repo ref, to prove they're skipped by the walk).
function linkBody(issueNums: number[], extra: string[] = []): string {
  const lines = issueNums
    .map((n) => `- issue #${n} — member ${n}`)
    .concat(extra);
  return `${MARK_O}\n**Linked work items:**\n${lines.join("\n")}\n${MARK_C}`;
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

  it("allows a handoff-labeled issue when there is no source context (#229)", async () => {
    // dark-factory#229 — the historical blanket ban is gone. With no
    // sourceIssue (e.g. `--new`, where the source doesn't exist yet) no cycle
    // is possible, so a handoff-labeled target resolves normally.
    const gh = ghStub({
      prThrows: true,
      issueLabels: ["handoff"],
      issueTitle: "another handoff",
    });
    expect(await resolveLinkRef("issue:999", gh)).toEqual({
      kind: "issue",
      display: "#999",
      title: "another handoff",
    });
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

  it("bare-ref PR-fail → handoff-labeled issue resolves (no blanket ban; #229)", async () => {
    // PR lookup fails (gh treats N as not a PR), falls through to issue lookup
    // which returns a handoff-labeled issue. With no sourceIssue context this
    // now RESOLVES — the blanket ban is replaced by source-aware cycle
    // detection (exercised in the dedicated describe block below).
    const gh = ghStub({
      prThrows: true,
      issueLabels: ["handoff"],
      issueTitle: "another handoff",
    });
    expect(await resolveLinkRef("999", gh)).toEqual({
      kind: "issue",
      display: "#999",
      title: "another handoff",
    });
  });
});

describe("links — resolveLinkRef cycle detection (#229)", () => {
  const HANDOFF = ["handoff"];

  it("allows an acyclic umbrella → member link (member doesn't link back)", async () => {
    // Link master #261 → member #251; #251 has no link back to #261.
    const { gh } = ghIssueGraph({
      251: { labels: HANDOFF, title: "member", body: linkBody([]) },
    });
    expect(await resolveLinkRef("issue:251", gh, { sourceIssue: 261 })).toEqual({
      kind: "issue",
      display: "#251",
      title: "member",
    });
  });

  it("refuses a direct cycle (target already links back to the source)", async () => {
    // Link #251 → #261, but #261 already links #251 → mutual = cycle.
    const { gh } = ghIssueGraph({
      261: { labels: HANDOFF, title: "master", body: linkBody([251]) },
    });
    await expect(
      resolveLinkRef("issue:261", gh, { sourceIssue: 251 }),
    ).rejects.toThrow(/link-cycle back to this handoff \(#251\)/);
  });

  it("refuses a transitive cycle (target → X → source)", async () => {
    // source #100; target #200 links #300; #300 links #100 → closes the cycle.
    const { gh, viewed } = ghIssueGraph({
      200: { labels: HANDOFF, body: linkBody([300]) },
      300: { labels: HANDOFF, body: linkBody([100]) },
    });
    await expect(
      resolveLinkRef("issue:200", gh, { sourceIssue: 100 }),
    ).rejects.toThrow(/link-cycle back to this handoff \(#100\)/);
    expect(viewed).toContain(300); // proves the walk traversed transitively
  });

  it("refuses a direct self-link", async () => {
    const { gh } = ghIssueGraph({
      500: { labels: HANDOFF, body: linkBody([]) },
    });
    await expect(
      resolveLinkRef("issue:500", gh, { sourceIssue: 500 }),
    ).rejects.toThrow(/link-cycle back to this handoff \(#500\)/);
  });

  it("allows a deep acyclic chain (target → A → B, none reach source)", async () => {
    const { gh } = ghIssueGraph({
      200: { labels: HANDOFF, body: linkBody([300]) },
      300: { labels: HANDOFF, body: linkBody([400]) },
      400: { labels: HANDOFF, body: linkBody([]) },
    });
    const r = await resolveLinkRef("issue:200", gh, { sourceIssue: 100 });
    expect(r.display).toBe("#200");
  });

  it("terminates on pre-existing cyclic data (A↔B) without infinite loop", async () => {
    // Defensive: even if the on-disk graph already cycles between two OTHER
    // issues, the visited-set terminates. Source #100 is not in the {200,300}
    // cycle, so the link is allowed and the walk halts.
    const { gh } = ghIssueGraph({
      200: { labels: HANDOFF, body: linkBody([300]) },
      300: { labels: HANDOFF, body: linkBody([200]) },
    });
    const r = await resolveLinkRef("issue:200", gh, { sourceIssue: 100 });
    expect(r.display).toBe("#200");
  });

  it("does NOT walk a non-handoff issue target (no cycle risk)", async () => {
    const { gh, viewed } = ghIssueGraph({
      77: { labels: [], title: "plain issue", body: linkBody([100]) },
    });
    expect(await resolveLinkRef("issue:77", gh, { sourceIssue: 100 })).toEqual({
      kind: "issue",
      display: "#77",
      title: "plain issue",
    });
    expect(viewed).toEqual([77]); // target fetched once; the walk never started
  });

  it("skips PR and cross-repo entries while walking (they can't be handoff cycles)", async () => {
    // #200's linked items include a PR and a cross-repo issue alongside the
    // same-repo member #400 — only #400 is followed; neither extra reaches the
    // source, so the link is allowed.
    const { gh, viewed } = ghIssueGraph({
      200: {
        labels: HANDOFF,
        body: linkBody([400], [
          "- pr #100 — a PR that happens to share the source number",
          "- issue other/repo#100 — cross-repo, not followed",
        ]),
      },
      400: { labels: HANDOFF, body: linkBody([]) },
    });
    const r = await resolveLinkRef("issue:200", gh, { sourceIssue: 100 });
    expect(r.display).toBe("#200");
    expect(viewed).toContain(400);
    expect(viewed).not.toContain(100); // PR/cross-repo #100 entries were skipped
  });

  it("cross-repo handoff TARGET skips the walk (allowed; documented limitation)", async () => {
    let viewedRepo: { repo?: string } | undefined;
    const gh: GhClient = {
      ...ghStub({ prThrows: true }),
      issueView: async (_num, o) => {
        viewedRepo = o;
        return {
          number: 5,
          title: "cross-repo handoff",
          body: linkBody([1]), // even though it "links #1", cross-repo isn't walked
          state: "OPEN",
          assignees: [],
          labels: [{ name: "handoff" }],
          updatedAt: "2026-05-30T00:00:00Z",
          closedAt: null,
        };
      },
    };
    expect(
      await resolveLinkRef("issue:owner/repo#5", gh, { sourceIssue: 1 }),
    ).toEqual({
      kind: "issue",
      display: "owner/repo#5",
      title: "cross-repo handoff",
    });
    expect(viewedRepo).toEqual({ repo: "owner/repo" });
  });

  it("treats an unreachable node mid-walk as a leaf (gh failure ≠ cycle)", async () => {
    // #200 links #999 which gh can't fetch; the walk swallows that and
    // concludes acyclic rather than throwing a non-cycle error.
    const { gh } = ghIssueGraph({
      200: { labels: HANDOFF, body: linkBody([999]) },
      // 999 intentionally absent → issueView throws.
    });
    const r = await resolveLinkRef("issue:200", gh, { sourceIssue: 100 });
    expect(r.display).toBe("#200");
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
