// Self-test for FakeGhClient — validates the slot semantics, counter
// independence, error-slot, missing-slot diagnostic, setAllPrViewsThrow,
// call log, and lastEditBody capture. Lives next to the fake so a bug
// in the fake surfaces cleanly here, not buried inside a verb-test failure.

import { describe, expect, it } from "vitest";

import type { IssueView } from "../../../../src/handoff/ports.js";

import { FakeGhClient } from "./fake-gh.js";

const ISSUE_42: IssueView = {
  number: 42,
  title: "test",
  body: "body",
  state: "OPEN",
  assignees: [],
  labels: [{ name: "handoff" }],
  updatedAt: "2026-05-30T00:00:00Z",
  closedAt: null,
};

describe("FakeGhClient — per-method ordinal slots", () => {
  it("default slot returned for every call when only default set", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(ISSUE_42);
    expect((await gh.issueView(42)).number).toBe(42);
    expect((await gh.issueView(42)).number).toBe(42);
    expect((await gh.issueView(42)).number).toBe(42);
  });

  it("slot N overrides Nth call; default applies to others", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(ISSUE_42);
    gh.setIssueViewSlot(2, { ...ISSUE_42, body: "drifted body" });
    expect((await gh.issueView(42)).body).toBe("body"); // 1st call → default
    expect((await gh.issueView(42)).body).toBe("drifted body"); // 2nd call → slot 2
    expect((await gh.issueView(42)).body).toBe("body"); // 3rd call → default
  });

  it("issueView and issueViewSlim have INDEPENDENT counters", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(ISSUE_42);
    gh.setIssueViewSlimDefault({
      state: "OPEN",
      assignees: [],
      updatedAt: "2026-05-30T00:00:00Z",
    });
    gh.setIssueViewSlot(1, { ...ISSUE_42, body: "view-1" });
    gh.setIssueViewSlimSlot(1, {
      state: "CLOSED",
      assignees: [],
      updatedAt: "2026-05-30T00:00:00Z",
    });
    // Calling issueViewSlim first — should NOT advance issueView's counter.
    const slim = await gh.issueViewSlim(42);
    expect(slim.state).toBe("CLOSED");
    const full = await gh.issueView(42);
    expect(full.body).toBe("view-1"); // 1st issueView call → slot 1
  });

  it("Error slot throws on access", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewSlot(1, new Error("network down"));
    await expect(gh.issueView(42)).rejects.toThrow("network down");
  });

  it("missing slot config throws a clear error", async () => {
    const gh = new FakeGhClient();
    await expect(gh.issueView(42)).rejects.toThrow(/no slot configured/);
  });

  it("setAllPrViewsThrow makes every prView fail", async () => {
    const gh = new FakeGhClient();
    gh.setAllPrViewsThrow();
    await expect(gh.prView(103)).rejects.toThrow(/gh pr view failed/);
    await expect(gh.prView(200)).rejects.toThrow(/gh pr view failed/);
  });

  it("calls() records every invocation in order", async () => {
    const gh = new FakeGhClient();
    gh.setIssueViewDefault(ISSUE_42);
    await gh.apiUserLogin();
    await gh.issueView(42);
    await gh.issueAddLabel(42, "handoff");
    expect(gh.calls()).toEqual([
      "gh api user --jq .login",
      "gh issue view 42 (slot 1)",
      "gh issue edit 42 --add-label handoff",
    ]);
  });

  it("lastEditBody captures the body of the most recent issueEditBody call", async () => {
    const gh = new FakeGhClient();
    await gh.issueEditBody(42, "first body");
    await gh.issueEditBody(42, "second body");
    expect(gh.lastEditBody()).toEqual({ num: 42, bodyMd: "second body" });
  });
});
