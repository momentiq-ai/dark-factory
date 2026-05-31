// packages/cli/tests/handoff/rehydrate-core.test.ts
//
// Tests for deriveRehydrateData — the pure-data core of /rehydrate.
//
// These tests target the STRUCTURED data shape. The CLI text rendering
// (Task 10) and the byte-identical bash parity (Task 21) are tested
// separately; here we only assert that the data object is correctly
// populated from gh.issueView + gh.prView calls.
//
// FakeGhClient ordinal-slot reminder: deriveRehydrateData calls issueView
// once for the main handoff issue, and once per linked-issue entry —
// they share the same counter. Tests with linked issues use explicit
// per-ordinal slots (slot 1 = handoff issue, slot 2+ = linked issues).

import { describe, expect, it } from "vitest";

import { HandoffError } from "../../src/handoff/ports.js";
import type { IssueView, PrView } from "../../src/handoff/ports.js";
import { deriveRehydrateData } from "../../src/handoff/rehydrate-core.js";

import { FakeGhClient } from "./fixtures/stubs/fake-gh.js";

const MARK_O = "<!-- agent-context:v1 -->";
const MARK_C = "<!-- /agent-context:v1 -->";

function issueView(overrides: Partial<IssueView> = {}): IssueView {
  return {
    number: 60,
    title: "handoff: feature X",
    body: "",
    state: "OPEN",
    assignees: [],
    labels: [{ name: "handoff" }],
    updatedAt: "2026-05-30T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

function block(linked: string, note = "why: chose path A"): string {
  return `${MARK_O}
**Branch:** feature/x

**Linked work items:**
${linked}

**Reasoning:**
${note}
${MARK_C}
`;
}

function prView(overrides: Partial<PrView> = {}): PrView {
  return {
    title: "fix: thing",
    state: "OPEN",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }],
    ...overrides,
  };
}

describe("deriveRehydrateData — main issue state", () => {
  it("OPEN issue, no assignees, no linked items → on-the-stack stateLine", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(
      issueView({ body: block("_None linked._", "why: do the thing") }),
    );
    const data = await deriveRehydrateData(60, gh);
    expect(data.issueNumber).toBe(60);
    expect(data.title).toBe("handoff: feature X");
    expect(data.stateLine).toBe("open (unassigned — on the stack)");
    expect(data.linkedItems).toEqual([]);
    expect(data.linkFailures).toBe(0);
    expect(data.note).toContain("why: do the thing");
    expect(data.note).toContain(MARK_O);
    expect(data.note).toContain(MARK_C);
  });

  it("OPEN issue, multiple assignees → 'open (assigned a,b)'", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(
      issueView({
        assignees: [{ login: "alien8d" }, { login: "other" }],
        body: block("_None linked._"),
      }),
    );
    const data = await deriveRehydrateData(60, gh);
    expect(data.stateLine).toBe("open (assigned alien8d,other)");
  });

  it("CLOSED issue with closedAt → 'closed (accepted YYYY-MM-DD)'", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(
      issueView({
        state: "CLOSED",
        closedAt: "2026-05-29T18:22:00Z",
        body: block("_None linked._"),
      }),
    );
    const data = await deriveRehydrateData(60, gh);
    expect(data.stateLine).toBe("closed (accepted 2026-05-29)");
  });

  it("CLOSED issue without closedAt → 'closed'", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(
      issueView({
        state: "CLOSED",
        closedAt: null,
        body: block("_None linked._"),
      }),
    );
    const data = await deriveRehydrateData(60, gh);
    expect(data.stateLine).toBe("closed");
  });

  it("issue title with control chars → stripped in title", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(
      issueView({
        title: "handoff:\x1b[31m red \x1b[0m thing\x07",
        body: block("_None linked._"),
      }),
    );
    const data = await deriveRehydrateData(60, gh);
    // ESC (0x1b) and BEL (0x07) stripped; brackets/letters/spaces remain.
    expect(data.title).toBe("handoff:[31m red [0m thing");
  });

  it("gh.issueView throws → HandoffError raised with rehydrate-specific message", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewSlot(1, new Error("network down"));
    await expect(deriveRehydrateData(60, gh)).rejects.toBeInstanceOf(
      HandoffError,
    );
    await expect(deriveRehydrateData(60, gh)).rejects.toThrow(
      /could not derive live state for #60/,
    );
  });
});

describe("deriveRehydrateData — linked PR derivation", () => {
  it("linked PR (OPEN) → state OPEN, checkoutHint same-repo, extra populated", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(
      issueView({ body: block("- pr #103 — deploy spec") }),
    );
    gh.setPrViewDefault(
      103,
      prView({
        title: "deploy spec",
        statusCheckRollup: [
          { conclusion: "SUCCESS" },
          { conclusion: "SUCCESS" },
        ],
      }),
    );
    const data = await deriveRehydrateData(60, gh);
    expect(data.linkedItems.length).toBe(1);
    const item = data.linkedItems[0]!;
    expect(item.kind).toBe("pr");
    expect(item.display).toBe("#103");
    expect(item.title).toBe("deploy spec");
    expect(item.state).toBe("OPEN");
    expect(item.annotation).toBe("");
    expect(item.checkoutHint).toBe("gh pr checkout 103");
    expect(item.extra?.mergeStateStatus).toBe("CLEAN");
    expect(item.extra?.reviewDecision).toBe("APPROVED");
    expect(item.extra?.checksSummary).toBe("2 success");
    expect(data.linkFailures).toBe(0);
  });

  it("linked PR (MERGED) → state MERGED, annotation '(merged)', no checkoutHint", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(
      issueView({ body: block("- pr #117 — handoff v2 spec") }),
    );
    gh.setPrViewDefault(117, prView({ state: "MERGED" }));
    const data = await deriveRehydrateData(60, gh);
    const item = data.linkedItems[0]!;
    expect(item.state).toBe("MERGED");
    expect(item.annotation).toBe("(merged)");
    expect(item.checkoutHint).toBeUndefined();
    expect(item.extra).toBeUndefined();
  });

  it("linked PR (CLOSED, unmerged) → state CLOSED, annotation '(closed)'", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(
      issueView({ body: block("- pr #44 — abandoned attempt") }),
    );
    gh.setPrViewDefault(44, prView({ state: "CLOSED" }));
    const data = await deriveRehydrateData(60, gh);
    const item = data.linkedItems[0]!;
    expect(item.state).toBe("CLOSED");
    expect(item.annotation).toBe("(closed)");
    expect(item.checkoutHint).toBeUndefined();
  });

  it("linked PR that throws → UNREACHABLE + linkFailures incremented", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(
      issueView({ body: block("- pr #999 — vanished") }),
    );
    gh.setPrViewDefault(999, new Error("gh pr view failed"));
    const data = await deriveRehydrateData(60, gh);
    const item = data.linkedItems[0]!;
    expect(item.state).toBe("UNREACHABLE");
    expect(item.annotation).toBe("(unreachable: gh pr view failed)");
    expect(item.checkoutHint).toBeUndefined();
    expect(data.linkFailures).toBe(1);
  });

  it("cross-repo PR link → checkoutHint includes --repo owner/repo", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(
      issueView({
        body: block("- pr momentiq-ai/dark-factory#59 — upstream fix"),
      }),
    );
    gh.setPrViewDefault(59, prView({ title: "upstream fix" }));
    const data = await deriveRehydrateData(60, gh);
    const item = data.linkedItems[0]!;
    expect(item.kind).toBe("pr");
    expect(item.display).toBe("momentiq-ai/dark-factory#59");
    expect(item.state).toBe("OPEN");
    expect(item.checkoutHint).toBe(
      "gh pr checkout 59 --repo momentiq-ai/dark-factory",
    );
  });
});

describe("deriveRehydrateData — linked Issue derivation", () => {
  it("linked Issue (OPEN, unassigned) → annotation '[open]'", async () => {
    const gh = new FakeGhClient();
    // Slot 1 = main handoff issue; slot 2 = linked issue.
    gh.setIssueViewSlot(1, issueView({ body: block("- issue #42 — bug A") }));
    gh.setIssueViewSlot(
      2,
      issueView({
        number: 42,
        title: "bug A",
        labels: [{ name: "bug" }],
        assignees: [],
      }),
    );
    const data = await deriveRehydrateData(60, gh);
    const item = data.linkedItems[0]!;
    expect(item.kind).toBe("issue");
    expect(item.display).toBe("#42");
    expect(item.state).toBe("OPEN");
    expect(item.annotation).toBe("[open]");
    expect(item.extra?.assigneesCsv).toBe("");
  });

  it("linked Issue (OPEN, assigned) → annotation '[open, assigned X]'", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewSlot(1, issueView({ body: block("- issue #42 — bug A") }));
    gh.setIssueViewSlot(
      2,
      issueView({
        number: 42,
        title: "bug A",
        labels: [{ name: "bug" }],
        assignees: [{ login: "someone" }],
      }),
    );
    const data = await deriveRehydrateData(60, gh);
    const item = data.linkedItems[0]!;
    expect(item.annotation).toBe("[open, assigned someone]");
    expect(item.extra?.assigneesCsv).toBe("someone");
  });

  it("linked Issue (CLOSED) → annotation '(closed)'", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewSlot(1, issueView({ body: block("- issue #42 — bug A") }));
    gh.setIssueViewSlot(
      2,
      issueView({
        number: 42,
        title: "bug A",
        state: "CLOSED",
        closedAt: "2026-05-29T00:00:00Z",
        labels: [{ name: "bug" }],
      }),
    );
    const data = await deriveRehydrateData(60, gh);
    const item = data.linkedItems[0]!;
    expect(item.state).toBe("CLOSED");
    expect(item.annotation).toBe("(closed)");
    expect(item.extra).toBeUndefined();
  });

  it("linked Issue that throws → UNREACHABLE w/ 'gh issue view failed' annotation", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewSlot(1, issueView({ body: block("- issue #404 — gone") }));
    gh.setIssueViewSlot(2, new Error("network blip"));
    const data = await deriveRehydrateData(60, gh);
    const item = data.linkedItems[0]!;
    expect(item.state).toBe("UNREACHABLE");
    expect(item.annotation).toBe("(unreachable: gh issue view failed)");
    expect(data.linkFailures).toBe(1);
  });
});

describe("deriveRehydrateData — multiple linked items, order, and notes", () => {
  it("multiple linked items mixed states → derived in body order", async () => {
    const gh = new FakeGhClient();
    const links = [
      "- pr #103 — deploy spec",
      "- pr #117 — handoff v2 spec",
      "- issue #42 — bug A",
    ].join("\n");
    // Main issue is slot 1; linked issue (#42) shares counter → slot 2.
    gh.setIssueViewSlot(1, issueView({ body: block(links) }));
    gh.setIssueViewSlot(
      2,
      issueView({
        number: 42,
        title: "bug A",
        labels: [{ name: "bug" }],
        assignees: [{ login: "someone" }],
      }),
    );
    gh.setPrViewDefault(103, prView({ title: "deploy spec" }));
    gh.setPrViewDefault(
      117,
      prView({ state: "MERGED", title: "handoff v2 spec" }),
    );
    const data = await deriveRehydrateData(60, gh);
    expect(data.linkedItems.length).toBe(3);
    expect(data.linkedItems[0]!.display).toBe("#103");
    expect(data.linkedItems[0]!.state).toBe("OPEN");
    expect(data.linkedItems[1]!.display).toBe("#117");
    expect(data.linkedItems[1]!.state).toBe("MERGED");
    expect(data.linkedItems[2]!.display).toBe("#42");
    expect(data.linkedItems[2]!.kind).toBe("issue");
    expect(data.linkedItems[2]!.annotation).toBe("[open, assigned someone]");
    expect(data.linkFailures).toBe(0);
  });

  it("note is the LAST marker block when body has multiple", async () => {
    const gh = new FakeGhClient();
    const olderBlock = `${MARK_O}
older reasoning
${MARK_C}`;
    const newerBlock = `${MARK_O}
newer reasoning
${MARK_C}`;
    const body = `${olderBlock}\n\nsome text in between\n\n${newerBlock}\n`;
    gh.setIssueViewDefault(issueView({ body }));
    const data = await deriveRehydrateData(60, gh);
    expect(data.note).toContain("newer reasoning");
    expect(data.note).not.toContain("older reasoning");
    expect(data.note).toContain(MARK_O);
    expect(data.note).toContain(MARK_C);
  });

  it("no marker block at all → note is null", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(
      issueView({ body: "no markers anywhere just text" }),
    );
    const data = await deriveRehydrateData(60, gh);
    expect(data.note).toBeNull();
    expect(data.linkedItems).toEqual([]);
  });

  it("summarizeChecks sorts buckets ascending (jq group_by parity)", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(issueView({ body: block("- pr #200 — multi") }));
    gh.setPrViewDefault(
      200,
      prView({
        statusCheckRollup: [
          { conclusion: "SUCCESS" },
          { conclusion: "FAILURE" },
          { conclusion: "SUCCESS" },
          { conclusion: "FAILURE" },
          { conclusion: "PENDING" },
        ],
      }),
    );
    const data = await deriveRehydrateData(60, gh);
    // Sorted ascending: failure, pending, success
    expect(data.linkedItems[0]!.extra?.checksSummary).toBe(
      "2 failure, 1 pending, 2 success",
    );
  });

  it("PR with empty statusCheckRollup → checksSummary = 'no checks'", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(issueView({ body: block("- pr #300 — clean") }));
    gh.setPrViewDefault(300, prView({ statusCheckRollup: [] }));
    const data = await deriveRehydrateData(60, gh);
    expect(data.linkedItems[0]!.extra?.checksSummary).toBe("no checks");
  });

  it("PR check entry with no conclusion falls back to .state (lowercased)", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(issueView({ body: block("- pr #400 — pending") }));
    gh.setPrViewDefault(
      400,
      prView({
        statusCheckRollup: [{ state: "IN_PROGRESS" }, { state: "IN_PROGRESS" }],
      }),
    );
    const data = await deriveRehydrateData(60, gh);
    expect(data.linkedItems[0]!.extra?.checksSummary).toBe("2 in_progress");
  });
});
