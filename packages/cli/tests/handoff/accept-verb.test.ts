// packages/cli/tests/handoff/accept-verb.test.ts
//
// Ported from .claude/skills/handoff/tests/test_handoff.sh (the bash spec),
// case-map.md § /accept (17 cases). Each test cites its source `t_accept_*`
// function in a comment near the top.
//
// The 7-step atomic chain (per accept-verb.ts) and its slot mapping:
//   step 1: gh.issueView(issue)         — body-bearing slot 1
//   step 3: gh.issueView(issue)         — body-bearing slot 2 (inside
//                                         deriveRehydrateData); plus per
//                                         linked item gh.prView / gh.issueView
//   step 4: gh.issueViewSlim(issue)     — body-less slot 1 (V1 in bash)
//   step 5: gh.issueAssignMe(issue)
//   step 6: gh.issueViewSlim(issue)     — body-less slot 2 (V2 in bash)
//   step 7: gh.issueClose(issue)
//
// Bash STUB_ISSUE_ASSIGNEES_V1 → setIssueViewSlimSlot(1, …)
// Bash STUB_ISSUE_ASSIGNEES_V2 → setIssueViewSlimSlot(2, …)
// Bash STUB_ISSUE_BODY (default) → setIssueViewDefault(…)
//
// The bash assertions transfer 1:1 onto FakeGhClient.calls() / fake state.

import { describe, it, expect } from "vitest";

import { runAccept } from "../../src/handoff/accept-verb.js";
import {
  requireIssueNumber,
  requireSafeArgs,
} from "../../src/handoff/args.js";
import type {
  IssueView,
  IssueViewSlim,
  PrView,
} from "../../src/handoff/ports.js";
import { FakeGhClient } from "./fixtures/stubs/fake-gh.js";

const MARK_O = "<!-- agent-context:v1 -->";
const MARK_C = "<!-- /agent-context:v1 -->";

// Shared `updatedAt` for issueView + issueViewSlim default factories. step 4
// of runAccept compares driftView.updatedAt vs initialUpdatedAt — they must
// match for any pass-through (happy / post-multi / close-fail) test. The ONE
// test that deliberately splits them is `preassign_empty_to_me_drift`.
const UPDATED_AT = "2026-05-30T00:00:00Z";

/** Body containing exactly one agent-context block — bash body_with_block(). */
function bodyWithBlock(): string {
  return `${MARK_O}\n_Updated: 2026-05-29_\n\nwhy: prior reasoning\n${MARK_C}`;
}

/**
 * Body containing a Linked work items section with the given pre-formatted
 * entries (bash body_with_links). Entries MUST use the em-dash (U+2014)
 * separator that parseEntry expects — a hyphen makes parseEntry return null
 * (unknown-link-type / UNREACHABLE) for the wrong reason and the linked-PR
 * test would pass spuriously.
 */
function bodyWithLinks(entries: string): string {
  return (
    `${MARK_O}\n_Updated: 2026-05-30_\n\n` +
    `**Linked work items:**\n${entries}\n\n` +
    `why: something\n${MARK_C}`
  );
}

function issueView(overrides: Partial<IssueView> = {}): IssueView {
  return {
    number: 42,
    title: "Handoff: example",
    body: bodyWithBlock(),
    state: "OPEN",
    assignees: [],
    labels: [{ name: "handoff" }],
    updatedAt: UPDATED_AT,
    closedAt: null,
    ...overrides,
  };
}

function slimView(overrides: Partial<IssueViewSlim> = {}): IssueViewSlim {
  return {
    state: "OPEN",
    assignees: [],
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function prView(overrides: Partial<PrView> = {}): PrView {
  return {
    title: "PR title",
    state: "OPEN",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [],
    ...overrides,
  };
}

function setup() {
  const gh = new FakeGhClient();
  return { gh };
}

// ===========================================================================
// 1. Happy path
// ===========================================================================

describe("/accept — happy path", () => {
  it("assigns @me + closes; KEEPS handoff label; rehydrates (t_accept_happy_path)", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(issueView({ number: 42, body: bodyWithBlock() }));
    // Slot 1 (pre-assign drift): no assignees, updatedAt matches.
    // Slot 2 (post-assign verify): now [@me], post-assign success.
    gh.setIssueViewSlimSlot(1, slimView({ assignees: [] }));
    gh.setIssueViewSlimSlot(
      2,
      slimView({ assignees: [{ login: "alien8d" }] }),
    );

    const result = await runAccept({ issue: 42, gh });

    expect(result.issueNumber).toBe(42);
    // Atomic chain completed: assign + close fired.
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(true);
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(true);
    // Label NOT removed (Commitment 10 — label retained for lifetime).
    expect(
      gh.calls().some((c) => c.includes("--remove-label")),
    ).toBe(false);
    // Rehydrate data was derived.
    expect(result.rehydrate.issueNumber).toBe(42);
    // Both success-path log lines fired.
    expect(result.logs.some((l) => /assigned to you/i.test(l))).toBe(true);
    expect(result.logs.some((l) => /handoff event complete/i.test(l))).toBe(
      true,
    );
  });
});

// ===========================================================================
// 2. Refusals (step 1 / step 2 / body validation)
// ===========================================================================

describe("/accept — refusals", () => {
  it("refuse on closed handoff issue, no mutation (t_accept_refuse_closed)", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 88, state: "CLOSED", closedAt: "2026-05-29T10:00:00Z" }),
    );
    await expect(runAccept({ issue: 88, gh })).rejects.toThrow(/closed/i);
    expect(
      gh.calls().some((c) => c === "gh issue edit 88 --add-assignee @me"),
    ).toBe(false);
    expect(gh.calls().some((c) => c === "gh issue close 88")).toBe(false);
  });

  it("refuse if no handoff label (not warn-proceed) (t_accept_refuse_no_label)", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, labels: [{ name: "bug" }] }),
    );
    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /not a handoff/i,
    );
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(false);
  });

  it("refuse if assigned to @other, no mutation (t_accept_refuse_assigned_other)", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        body: bodyWithBlock(),
        assignees: [{ login: "other" }],
      }),
    );
    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /currently assigned to/i,
    );
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(false);
  });

  it("refuse on body without agent-context markers — no mutation, no close (t_accept_refuse_no_marker_block)", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: "some plain body without any markers" }),
    );
    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /no parseable agent-context/i,
    );
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(false);
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(false);
  });

  it("refuse on open marker without close — no mutation (t_accept_refuse_malformed_block)", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        body: `${MARK_O}\nsome content but no close marker\n`,
      }),
    );
    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /no parseable agent-context/i,
    );
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(false);
  });

  it("refuse on reversed markers (close before open) — no mutation, no close (t_accept_refuse_reversed_markers)", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        body: `${MARK_C}\nsome reasoning\n${MARK_O}`,
      }),
    );
    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /no parseable agent-context/i,
    );
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(false);
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(false);
  });

  it("refuse on stale valid + newer malformed block — no close (t_accept_refuse_stale_valid_plus_newest_malformed)", async () => {
    const { gh } = setup();
    // Two blocks: first valid, second has an open marker but no close. The
    // accept extractor (validateLatestBlock) checks the LAST open vs the
    // LAST close — last_open is later than last_close so validation fails.
    const body =
      `${MARK_O}\nold valid block\n${MARK_C}\n\n` +
      `some separator\n\n` +
      `${MARK_O}\nnewer malformed (no close)\n`;
    gh.setIssueViewDefault(issueView({ number: 42, body }));
    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /no parseable agent-context/i,
    );
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(false);
  });

  it("step 1 gh failure → 'could not fetch' error, no mutation", async () => {
    const { gh } = setup();
    gh.setIssueViewSlot(1, new Error("gh issue view failed"));
    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /could not fetch/i,
    );
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(false);
  });
});

// ===========================================================================
// 3. Strict rehydrate (step 3)
// ===========================================================================

describe("/accept — strict rehydrate", () => {
  it("linked PR unreachable → strict rehydrate aborts, no assign, no close (t_accept_linked_pr_unreachable_aborts)", async () => {
    const { gh } = setup();
    // Body has a linked PR #999 that PR view fails on. Em-dash separator
    // (U+2014) — parseEntry requires it; a hyphen would yield "unknown link
    // type" which is also UNREACHABLE but tests the wrong path.
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        body: bodyWithLinks("- pr #999 — broken link"),
      }),
    );
    // Force ALL prView calls to throw (parity with bash STUB_PR_VIEW_RC=1).
    gh.setAllPrViewsThrow(new Error("gh pr view failed (stubbed)"));

    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /rehydrate failed/i,
    );
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(false);
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(false);
  });

  it("gh fetch failure during validate/rehydrate → abort, no mutation (t_accept_rehydrate_failure_aborts)", async () => {
    const { gh } = setup();
    // Make BOTH issueView slots throw (slot 1 = validate; slot 2 = rehydrate).
    // The bash test sets STUB_ISSUE_VIEW_RC=1 which fails BOTH; the assertion
    // is "no mutation either way" — runAccept aborts at slot 1, never
    // reaches slot 2 / assign / close.
    gh.setIssueViewSlot(1, new Error("gh issue view failed"));
    gh.setIssueViewSlot(2, new Error("gh issue view failed"));
    await expect(runAccept({ issue: 42, gh })).rejects.toThrow();
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(false);
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(false);
  });
});

// ===========================================================================
// 4. Pre-assign drift (step 4)
// ===========================================================================

describe("/accept — pre-assign drift detection (step 4)", () => {
  it("empty→@me drift between validate + assign → abort (not stale-retry) (t_accept_preassign_empty_to_me_drift_aborts)", async () => {
    const { gh } = setup();
    // Validate: empty assignees, UPDATED_AT.
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock(), assignees: [] }),
    );
    // Slim slot 1 (pre-assign drift): assignees=[@me] AND updatedAt differs
    // → concurrent same-account assign by another tool/automation. The
    // close-failure retry allow-list requires initialStatus="me", but here
    // initial was "empty" → must abort.
    gh.setIssueViewSlimSlot(
      1,
      slimView({
        assignees: [{ login: "alien8d" }],
        updatedAt: "2026-05-30T01:00:00Z",
      }),
    );

    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /edited between/i,
    );
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(false);
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(false);
  });

  it("pre-assign drift detected (assignees changed to @other) → abort, no assign/close (t_accept_preassign_drift_detected)", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock(), assignees: [] }),
    );
    // Slim slot 1: now assigned to @other (concurrent claim).
    gh.setIssueViewSlimSlot(
      1,
      slimView({ assignees: [{ login: "other" }] }),
    );

    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /changed between/i,
    );
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(false);
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(false);
  });
});

// ===========================================================================
// 5. Post-assign verify (step 6)
// ===========================================================================

describe("/accept — post-assign verify (step 6)", () => {
  it("post-assign verify sees multi-assignee → abort BEFORE close (t_accept_post_assign_multi_assignee_aborts)", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock(), assignees: [] }),
    );
    // Slim slot 1 (pre-assign drift): empty (matches initial; no abort).
    // Slim slot 2 (post-assign verify): race resolved to [@me, other] by GH.
    gh.setIssueViewSlimSlot(1, slimView({ assignees: [] }));
    gh.setIssueViewSlimSlot(
      2,
      slimView({
        assignees: [{ login: "alien8d" }, { login: "other" }],
      }),
    );

    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /collision detected/i,
    );
    // Assign DID fire (step 5 succeeded).
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(true);
    // Close MUST NOT fire (abort before step 7).
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(false);
  });
});

// ===========================================================================
// 6. Close-failure recovery + already-assigned retry
// ===========================================================================

describe("/accept — close-failure recovery", () => {
  it("assign OK + close fail → warn 'assigned but not closed' (re-runnable) (t_accept_close_failure_recovery_path)", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(
      issueView({ number: 42, body: bodyWithBlock(), assignees: [] }),
    );
    // Slim slot 1: pre-assign drift OK (empty).
    // Slim slot 2: post-assign verify OK (now [@me]).
    gh.setIssueViewSlimSlot(1, slimView({ assignees: [] }));
    gh.setIssueViewSlimSlot(
      2,
      slimView({ assignees: [{ login: "alien8d" }] }),
    );
    // But close throws (parity with STUB_ISSUE_CLOSE_RC=1).
    gh.setIssueCloseThrows();

    await expect(runAccept({ issue: 42, gh })).rejects.toThrow(
      /assigned but not closed/i,
    );
    // Both assign + close are in the call log (close logged before throw).
    expect(
      gh.calls().some((c) => c === "gh issue edit 42 --add-assignee @me"),
    ).toBe(true);
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(true);
  });

  it("already assigned-to-@me → no drift, completes (t_accept_self_already_assigned_passes — baseline)", async () => {
    const { gh } = setup();
    // Initial view: already assigned to @me (prior step-5-OK / step-7-fail).
    // updatedAt matches the slim slots, so the close-failure retry allow-list
    // (accept-verb.ts:179-187) is NOT exercised here — that branch needs an
    // updatedAt mismatch (see the next test). This baseline is the no-drift
    // arm: same @me, no updatedAt change → trivial pass-through.
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        body: bodyWithBlock(),
        assignees: [{ login: "alien8d" }],
      }),
    );
    gh.setIssueViewSlimDefault(
      slimView({ assignees: [{ login: "alien8d" }] }),
    );

    const result = await runAccept({ issue: 42, gh });
    expect(result.issueNumber).toBe(42);
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(true);
  });

  it("@me + updatedAt drift → close-failure retry allow-list passes (t_accept_self_already_assigned_passes — allow-list arm)", async () => {
    // The LOAD-BEARING arm of accept-verb.ts:179-187: when INITIAL was @me
    // and DRIFT is @me but updatedAt differs, the chain passes through
    // (close-failure retry path — assign happened on a prior attempt, close
    // failed, the operator re-ran /accept). This is the ONLY drift-pass
    // branch in the verb; if someone deletes it so all updatedAt drift
    // aborts, every other accept test still passes — this is the test that
    // anchors that contract.
    const { gh } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        body: bodyWithBlock(),
        assignees: [{ login: "alien8d" }],
        updatedAt: UPDATED_AT,
      }),
    );
    // Slim slot 1: [@me], updatedAt DIFFERS → triggers the drift check;
    // initialStatus == "me" && driftStatus == "me" → allow-list pass.
    gh.setIssueViewSlimSlot(
      1,
      slimView({
        assignees: [{ login: "alien8d" }],
        updatedAt: "2026-05-30T01:00:00Z",
      }),
    );
    // Slim slot 2: post-assign verify sees [@me] (assign is idempotent).
    gh.setIssueViewSlimSlot(
      2,
      slimView({ assignees: [{ login: "alien8d" }] }),
    );

    const result = await runAccept({ issue: 42, gh });
    expect(result.issueNumber).toBe(42);
    // Close completed — the retry path succeeded.
    expect(gh.calls().some((c) => c === "gh issue close 42")).toBe(true);
    expect(result.logs.some((l) => /handoff event complete/i.test(l))).toBe(
      true,
    );
  });
});

// ===========================================================================
// 7. Argv hygiene (TRANSFORMED) + no-arg
// ===========================================================================
//
// FINDING (reported to caller): runAccept does NOT internally call
// requireIssueNumber / requireSafeArgs — unlike runHandoff which validates
// `opts.issue` defensively as a belt-and-braces guard. The CLI layer
// (Task 25) is the only barrier between raw user input and runAccept. To
// preserve the bash test semantics (rejection BEFORE any gh call), these
// tests exercise the validators DIRECTLY against the literal bash payloads
// and assert that runAccept's gh client stays untouched. They are
// nonetheless verb-level guarantees because the CLI delegates parsing to
// requireIssueNumber (per accept-verb.ts comment: "the CLI layer is
// expected to parse the raw arg via requireIssueNumber").

describe("/accept — argv hygiene (TRANSFORMED) + no-arg", () => {
  it("no arg → error, no mutation (t_accept_no_arg)", async () => {
    // Bash invocation: `bash accept.sh` (no args) — the CLI's
    // requireIssueNumber returns undefined on empty, and the verb shim is
    // expected to throw before reaching runAccept. We exercise the
    // validator directly (the only place rejection happens for missing
    // argv) and confirm no gh call would have fired.
    const { gh } = setup();
    // requireIssueNumber on empty input returns undefined — the CLI layer
    // (Task 25) catches that and errors before calling runAccept. Verify
    // here that no fake call is made.
    expect(requireIssueNumber("")).toBeUndefined();
    expect(requireIssueNumber(undefined)).toBeUndefined();
    expect(gh.calls().length).toBe(0);
  });

  it("argument with semicolon refused (allow-list backstop) (t_accept_refuses_semicolon_payload — TRANSFORMED)", async () => {
    // Bash payload: '42; echo PWNED'. The shell-invocation pipeline runs
    // requireSafeArgs (allow-list) FIRST — it rejects on the semicolon
    // before requireIssueNumber even sees the input. case-map.md specifies
    // /disallowed characters/. The bash assertion "PWNED not echoed"
    // applies to that requireSafeArgs error wording (which does NOT echo
    // the input).
    //
    // requireIssueNumber DOES echo its input in the error message (matches
    // bash `die "issue must be a positive integer (got: '$1')."` at
    // lib.sh:49-50). That's intentional for operator UX on a typo'd issue
    // number; the no-echo guarantee belongs to requireSafeArgs.
    const { gh } = setup();
    let safeMsg = "";
    try {
      requireSafeArgs(["42; echo PWNED"]);
    } catch (e) {
      safeMsg = (e as Error).message;
    }
    expect(safeMsg).toMatch(/disallowed characters/i);
    expect(safeMsg).not.toContain("PWNED");
    // Confirm requireIssueNumber would also reject the non-digit payload
    // (defense in depth — order in the CLI is safe-args first).
    expect(() => requireIssueNumber("42; echo PWNED")).toThrow(
      /positive integer/i,
    );
    expect(gh.calls().length).toBe(0);
  });
});

// ===========================================================================
// 8. gh-call sequence (the 7-step ordering — load-bearing race-safety contract)
// ===========================================================================

describe("/accept — gh-call sequence (atomic chain ordering)", () => {
  it("happy path emits steps 1→7 in the documented order", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(issueView({ number: 42, body: bodyWithBlock() }));
    gh.setIssueViewSlimSlot(1, slimView({ assignees: [] }));
    gh.setIssueViewSlimSlot(
      2,
      slimView({ assignees: [{ login: "alien8d" }] }),
    );

    await runAccept({ issue: 42, gh });

    const order = gh.calls();
    // Step 1: issueView slot 1.
    const step1 = order.findIndex(
      (c) => c === "gh issue view 42 (slot 1)",
    );
    // Lazy me-login fires AFTER step 1 (advisor catch #2 in accept-verb.ts).
    const meLogin = order.findIndex((c) => c === "gh api user --jq .login");
    // Step 3: issueView slot 2 (inside deriveRehydrateData).
    const step3 = order.findIndex(
      (c) => c === "gh issue view 42 (slot 2)",
    );
    // Step 4: issueViewSlim slot 1.
    const step4 = order.findIndex(
      (c) => c === "gh issue view 42 --slim (slot 1)",
    );
    // Step 5: add-assignee @me.
    const step5 = order.findIndex(
      (c) => c === "gh issue edit 42 --add-assignee @me",
    );
    // Step 6: issueViewSlim slot 2.
    const step6 = order.findIndex(
      (c) => c === "gh issue view 42 --slim (slot 2)",
    );
    // Step 7: close.
    const step7 = order.findIndex((c) => c === "gh issue close 42");

    expect(step1).toBeGreaterThanOrEqual(0);
    expect(meLogin).toBeGreaterThan(step1);
    expect(step3).toBeGreaterThan(meLogin);
    expect(step4).toBeGreaterThan(step3);
    expect(step5).toBeGreaterThan(step4);
    expect(step6).toBeGreaterThan(step5);
    expect(step7).toBeGreaterThan(step6);
  });

  it("step 1 + step 3 use separate body-bearing slot counters from step 4 + step 6 (slim)", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(issueView({ number: 42, body: bodyWithBlock() }));
    gh.setIssueViewSlimSlot(1, slimView({ assignees: [] }));
    gh.setIssueViewSlimSlot(
      2,
      slimView({ assignees: [{ login: "alien8d" }] }),
    );

    await runAccept({ issue: 42, gh });

    // Exactly 2 body-bearing issueView calls (slots 1 + 2).
    const bodyCalls = gh.calls().filter(
      (c) => c.startsWith("gh issue view 42") && !c.includes("--slim"),
    );
    expect(bodyCalls.length).toBe(2);
    expect(bodyCalls[0]).toBe("gh issue view 42 (slot 1)");
    expect(bodyCalls[1]).toBe("gh issue view 42 (slot 2)");

    // Exactly 2 body-less (--slim) issueView calls (slots 1 + 2 — separate
    // counter from the body-bearing slots above).
    const slimCalls = gh.calls().filter((c) =>
      c.startsWith("gh issue view 42") && c.includes("--slim"),
    );
    expect(slimCalls.length).toBe(2);
    expect(slimCalls[0]).toBe("gh issue view 42 --slim (slot 1)");
    expect(slimCalls[1]).toBe("gh issue view 42 --slim (slot 2)");
  });

  it("linked-PR happy path inserts a prView call between issueView slot 2 and the slim sequence", async () => {
    const { gh } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        body: bodyWithLinks("- pr #103 — deploy spec"),
      }),
    );
    gh.setPrViewDefault(103, prView({ title: "deploy spec" }));
    gh.setIssueViewSlimSlot(1, slimView({ assignees: [] }));
    gh.setIssueViewSlimSlot(
      2,
      slimView({ assignees: [{ login: "alien8d" }] }),
    );

    await runAccept({ issue: 42, gh });

    const order = gh.calls();
    const slot2 = order.findIndex((c) => c === "gh issue view 42 (slot 2)");
    const prCall = order.findIndex((c) => c.startsWith("gh pr view 103"));
    const slim1 = order.findIndex(
      (c) => c === "gh issue view 42 --slim (slot 1)",
    );

    expect(slot2).toBeGreaterThan(-1);
    expect(prCall).toBeGreaterThan(slot2);
    expect(slim1).toBeGreaterThan(prCall);
  });
});
