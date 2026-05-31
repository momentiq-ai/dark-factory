// packages/cli/tests/handoff/rehydrate-verb.test.ts
//
// Ported from .claude/skills/handoff/tests/test_handoff.sh (the bash spec),
// case-map.md § /rehydrate (cases 50-68; 19 cases). Each test cites its
// source `t_rehydrate_*` function in a comment near the top.
//
// Coverage groups:
//   1. Explicit-issue path (open, closed, livestate-fails-hard)
//   2. Linked items (open PR / merged PR / open issue / cross-repo /
//      checkout hints / scoping to markers)
//   3. Note display (control char strip on note + title, no marker block,
//      multiple blocks → last-by-position)
//   4. Argv hygiene (TRANSFORMED: non-numeric, $() command-sub) + verb-layer
//      no-tier-match HandoffError
//   5. No-arg 2-tier resolution (tier 1 open + @me; tier 2 closed + @me
//      within 7d, with ISO variants; tier-1 list failure fail-closed;
//      tier-2 over-7d → no fallback)
//
// CONTRACT: /rehydrate is read-only. The "no ownership mutation" assertion
// is anchored once in case 50; subsequent tests don't repeat the full
// negative call-log check (would be noise). Render-text assertions defer to
// rehydrate-render.test.ts — here we mostly assert on the structured
// RehydrateData; we call renderRehydrateText only where bash parity needed
// it (the control-char + linked-items + checkout-hint cases, where the
// stripping/composition happens at render time).

import { describe, it, expect } from "vitest";

import {
  requireIssueNumber,
  requireSafeArgs,
} from "../../src/handoff/args.js";
import type { IssueListItem, IssueView, PrView } from "../../src/handoff/ports.js";
import { renderRehydrateText } from "../../src/handoff/rehydrate-render.js";
import { runRehydrate } from "../../src/handoff/rehydrate-verb.js";
import { FakeGhClient } from "./fixtures/stubs/fake-gh.js";
import { FixedClock } from "./fixtures/stubs/fixed-clock.js";

const MARK_O = "<!-- agent-context:v1 -->";
const MARK_C = "<!-- /agent-context:v1 -->";

// FixedClock epoch = 1780142400 = 2026-05-30T12:00:00Z.
// Tier-2 cutoff = nowEpoch − 7*86400 = 2026-05-23T12:00:00Z.
// Bash test fixture `closedAt: 2026-05-29T10:00:00Z` is ~6d before now → IN window.
const NOW_EPOCH = 1780142400;
const NOW_YMD = "2026-05-30";

/** Body containing exactly one agent-context block — bash body_with_block(). */
function bodyWithBlock(reasoning = "prior reasoning"): string {
  return `${MARK_O}\n_Updated: 2026-05-29_\n\nwhy: ${reasoning}\n${MARK_C}`;
}

/**
 * Body with markers + Linked work items section. Em-dash (U+2014) separator
 * is REQUIRED by parseEntry — a hyphen yields "unknown link type" and the
 * linked-PR tests would pass for the wrong reason.
 */
function bodyWithLinks(entries: string, reasoning = "something"): string {
  return (
    `${MARK_O}\n_Updated: 2026-05-30_\n\n` +
    `**Linked work items:**\n${entries}\n\n` +
    `why: ${reasoning}\n${MARK_C}`
  );
}

function issueView(overrides: Partial<IssueView> = {}): IssueView {
  return {
    number: 42,
    title: "Handoff: cycle12.1 impl",
    body: bodyWithBlock(),
    state: "OPEN",
    assignees: [],
    labels: [{ name: "handoff" }],
    updatedAt: "2026-05-30T00:00:00Z",
    closedAt: null,
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

function listItem(
  overrides: Partial<IssueListItem> & { number: number },
): IssueListItem {
  return {
    title: "stack item",
    assignees: [],
    body: "",
    createdAt: "2026-05-29T00:00:00Z",
    updatedAt: "2026-05-30T00:00:00Z",
    closedAt: undefined,
    ...overrides,
  };
}

function setup() {
  const gh = new FakeGhClient();
  const clock = new FixedClock(NOW_EPOCH, NOW_YMD);
  return { gh, clock };
}

/** Standard "no ownership mutation" sweep — used in the anchor case (50). */
function expectNoMutation(gh: FakeGhClient, num: number): void {
  expect(
    gh.calls().some((c) => c === `gh issue edit ${num} --add-assignee @me`),
  ).toBe(false);
  expect(gh.calls().some((c) => c === `gh issue close ${num}`)).toBe(false);
  expect(gh.calls().some((c) => c.startsWith(`gh issue edit ${num} --body-file`))).toBe(
    false,
  );
  expect(gh.calls().some((c) => c.startsWith(`gh issue edit ${num} --add-label`))).toBe(
    false,
  );
}

// ===========================================================================
// 1. Explicit-issue path (open, closed, livestate-fails-hard)
// ===========================================================================

describe("/rehydrate — explicit issue (open / closed)", () => {
  it("OPEN issue → live state FIRST, then reasoning; NO ownership change (t_rehydrate_explicit_open_issue)", async () => {
    const { gh, clock } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        title: "Handoff: cycle12.1 impl",
        body: bodyWithBlock("prior reasoning"),
      }),
    );

    const result = await runRehydrate({ issue: 42, gh, clock });

    expect(result.issueNumber).toBe(42);
    expect(result.rehydrate.title).toBe("Handoff: cycle12.1 impl");
    expect(result.rehydrate.stateLine).toBe(
      "open (unassigned — on the stack)",
    );
    expect(result.rehydrate.note).toContain("prior reasoning");
    expect(result.rehydrate.note).toContain(MARK_O);
    expect(result.rehydrate.note).toContain(MARK_C);

    // Render-text invariant: header "LIVE STATE" appears FIRST (live-state-first
    // ritual). This is the rehydrate-render contract surfaced through the verb.
    const rendered = renderRehydrateText(result.rehydrate);
    const lines = rendered.split("\n");
    expect(lines[0]).toMatch(/LIVE STATE/i);
    expect(rendered).toContain("Handoff: cycle12.1 impl");
    expect(rendered).toContain("prior reasoning");

    // NO ownership mutation anywhere (anchor for the read-only contract).
    expectNoMutation(gh, 42);
  });

  it("CLOSED handoff issue → live state 'closed (accepted YYYY-MM-DD)' + reasoning prints (t_rehydrate_closed_issue)", async () => {
    const { gh, clock } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 88,
        state: "CLOSED",
        closedAt: "2026-05-29T10:00:00Z",
        body: bodyWithBlock("prior reasoning"),
      }),
    );

    const result = await runRehydrate({ issue: 88, gh, clock });

    expect(result.issueNumber).toBe(88);
    expect(result.rehydrate.stateLine).toBe("closed (accepted 2026-05-29)");
    expect(result.rehydrate.note).toContain("prior reasoning");

    const rendered = renderRehydrateText(result.rehydrate);
    expect(rendered).toMatch(/state: closed/i);
    expect(rendered).toContain("2026-05-29");
    expect(rendered).toContain("prior reasoning");
  });

  it("live-state query failure is HARD error (no soft fall-through) (t_rehydrate_livestate_fails_hard)", async () => {
    const { gh, clock } = setup();
    // Force slot-1 issueView to throw.
    gh.setIssueViewSlot(1, new Error("gh issue view failed (stubbed)"));

    await expect(runRehydrate({ issue: 42, gh, clock })).rejects.toThrow(
      /could not derive live state/i,
    );
  });
});

// ===========================================================================
// 2. Linked items (open PR / merged PR / open issue / cross-repo / scoping)
// ===========================================================================

describe("/rehydrate — linked items", () => {
  it("linked items derived live (open PR / merged PR / open issue) (t_rehydrate_linked_items)", async () => {
    const { gh, clock } = setup();
    // 3 entries: open PR #103, merged PR #200, open issue #91.
    // Sequential issueView counter: slot 1 = handoff #42; slot 2 = linked issue #91.
    gh.setIssueViewSlot(
      1,
      issueView({
        number: 42,
        body: bodyWithLinks(
          "- pr #103 — deploy spec\n" +
            "- pr #200 — merged change\n" +
            "- issue #91 — vendor degradation",
        ),
      }),
    );
    gh.setIssueViewSlot(
      2,
      issueView({
        number: 91,
        title: "vendor degradation",
        state: "OPEN",
        body: "",
      }),
    );
    gh.setPrViewDefault(103, prView({ title: "deploy spec", state: "OPEN" }));
    gh.setPrViewDefault(
      200,
      prView({ title: "merged change", state: "MERGED" }),
    );

    const result = await runRehydrate({ issue: 42, gh, clock });

    expect(result.rehydrate.linkedItems.length).toBe(3);
    const [pr103, pr200, iss91] = result.rehydrate.linkedItems;
    expect(pr103!.kind).toBe("pr");
    expect(pr103!.display).toBe("#103");
    expect(pr103!.state).toBe("OPEN");
    expect(pr200!.kind).toBe("pr");
    expect(pr200!.state).toBe("MERGED");
    expect(pr200!.annotation).toBe("(merged)");
    expect(iss91!.kind).toBe("issue");
    expect(iss91!.display).toBe("#91");
    expect(iss91!.state).toBe("OPEN");

    // Render parity (bash assertions): substrings 'pr #103' + '(merged)' +
    // 'issue #91' all present.
    const rendered = renderRehydrateText(result.rehydrate);
    expect(rendered).toContain("linked work items");
    expect(rendered).toContain("pr #103");
    expect(rendered).toContain("(merged)");
    expect(rendered).toContain("issue #91");
  });

  it("linked-item derivation in-marker scoped (stale outside entries ignored) (t_rehydrate_linked_items_scoped_to_markers)", async () => {
    const { gh, clock } = setup();
    // STALE `**Linked work items:**` section + #999 OUTSIDE the open marker —
    // must be ignored. Inside markers: canonical #103. Only configure prView
    // for 103 — if scoping regresses and #999 leaks through, the fake will
    // throw "no prView slot for 999" (free sharpening per advisor).
    const staleOutside =
      `**Linked work items:**\n- pr #999 — STALE outside\n\n`;
    const insideMarkers =
      `${MARK_O}\n**Linked work items:**\n- pr #103 — canonical\n\nwhy: x\n${MARK_C}`;
    gh.setIssueViewDefault(
      issueView({ number: 42, body: staleOutside + insideMarkers }),
    );
    gh.setPrViewDefault(103, prView({ title: "canonical", state: "OPEN" }));

    const result = await runRehydrate({ issue: 42, gh, clock });

    expect(result.rehydrate.linkedItems.length).toBe(1);
    expect(result.rehydrate.linkedItems[0]!.display).toBe("#103");
    const rendered = renderRehydrateText(result.rehydrate);
    expect(rendered).toContain("pr #103");
    expect(rendered).not.toContain("#999");
  });
});

// ===========================================================================
// 3. Checkout hints (same-repo / cross-repo / skipped-for-merged)
// ===========================================================================

describe("/rehydrate — checkout hint per PR state", () => {
  it("same-repo open PR emits 'gh pr checkout N' (no --repo on the hint) (t_rehydrate_checkout_hint_same_repo)", async () => {
    const { gh, clock } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        body: bodyWithLinks("- pr #103 — same repo"),
      }),
    );
    gh.setPrViewDefault(103, prView({ title: "same repo", state: "OPEN" }));

    const result = await runRehydrate({ issue: 42, gh, clock });

    expect(result.rehydrate.linkedItems[0]!.checkoutHint).toBe(
      "gh pr checkout 103",
    );

    // Render-line parity: the bash test scopes the negative `--repo` assertion
    // to the checkout: line itself (the ritual blurb at the bottom mentions
    // --repo). Same here.
    const rendered = renderRehydrateText(result.rehydrate);
    const checkoutLine = rendered
      .split("\n")
      .find((l) => l.includes("checkout: gh pr checkout"));
    expect(checkoutLine).toBeDefined();
    expect(checkoutLine).toContain("checkout: gh pr checkout 103");
    expect(checkoutLine).not.toContain("--repo");
  });

  it("cross-repo open PR emits 'gh pr checkout N --repo owner/repo' (t_rehydrate_checkout_hint_cross_repo)", async () => {
    const { gh, clock } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        body: bodyWithLinks(
          "- pr momentiq-ai/dark-factory#59 — cross repo",
        ),
      }),
    );
    gh.setPrViewDefault(59, prView({ title: "cross repo", state: "OPEN" }));

    const result = await runRehydrate({ issue: 42, gh, clock });

    expect(result.rehydrate.linkedItems[0]!.checkoutHint).toBe(
      "gh pr checkout 59 --repo momentiq-ai/dark-factory",
    );
    const rendered = renderRehydrateText(result.rehydrate);
    expect(rendered).toContain(
      "checkout: gh pr checkout 59 --repo momentiq-ai/dark-factory",
    );
  });

  it("merged PR has no checkout hint (t_rehydrate_checkout_hint_skipped_for_merged)", async () => {
    const { gh, clock } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        body: bodyWithLinks("- pr #200 — merged change"),
      }),
    );
    gh.setPrViewDefault(
      200,
      prView({ title: "merged change", state: "MERGED" }),
    );

    const result = await runRehydrate({ issue: 42, gh, clock });

    expect(result.rehydrate.linkedItems[0]!.state).toBe("MERGED");
    expect(result.rehydrate.linkedItems[0]!.checkoutHint).toBeUndefined();
    const rendered = renderRehydrateText(result.rehydrate);
    expect(rendered).toContain("(merged)");
    expect(rendered).not.toContain("checkout: gh pr checkout 200");
  });
});

// ===========================================================================
// 4. Note display: control-char strip + no-marker + multi-block latest
// ===========================================================================

describe("/rehydrate — note display & sanitization", () => {
  it("control/ESC chars stripped from note on display (t_rehydrate_strips_control_chars)", async () => {
    const { gh, clock } = setup();
    // The note carries an ESC sequence (\x1b[31m...). data.note is RAW (core
    // does NOT strip — only title is pre-stripped). renderRehydrateText is
    // where stripping happens; assert on the RENDERED text per advisor.
    // bash assertion: no 0x1B in output AND 'why: chose path 1' present.
    // The "[31m" + "END" text bytes survive — strip_control_chars only
    // deletes the ESC byte itself (0x1B), not the literal "[31m" that
    // accompanied it.
    const noteBody = `${MARK_O}\n_Updated: 2026-05-30_\n\nwhy: chose path 1\x1b[31mEND\n${MARK_C}`;
    gh.setIssueViewDefault(issueView({ number: 42, body: noteBody }));

    const result = await runRehydrate({ issue: 42, gh, clock });
    const rendered = renderRehydrateText(result.rehydrate);

    // No ESC byte (0x1B) survives in the rendered text.
    expect(rendered).not.toMatch(/\x1b/);
    expect(rendered).toContain("why: chose path 1");
    // Concretely, the post-strip note line reads "...chose path 1[31mEND"
    // (ESC removed; "[31m" bytes preserved, matching bash strip_control_chars).
    expect(rendered).toContain("chose path 1[31mEND");
  });

  it("control/ESC chars stripped from issue title (t_rehydrate_strips_control_chars_in_title)", async () => {
    const { gh, clock } = setup();
    // Title carries an ESC sequence. data.title IS pre-stripped by the core
    // (deriveRehydrateData calls stripControlChars on view.title) — assert
    // directly on it per advisor's asymmetry note.
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        title: "Handoff: feature/x\x1b[31mRESET",
        body: bodyWithBlock(),
      }),
    );

    const result = await runRehydrate({ issue: 42, gh, clock });

    expect(result.rehydrate.title).not.toMatch(/\x1b/);
    expect(result.rehydrate.title).toContain("Handoff: feature/x");
    // Concretely: "Handoff: feature/x[31mRESET" (ESC stripped, "[31m" + RESET
    // preserved — bash strip_control_chars only deletes the 0x1B byte itself).
    expect(result.rehydrate.title).toBe("Handoff: feature/x[31mRESET");
  });

  it("no marker block → 'no agent-context note' message (t_rehydrate_no_marker)", async () => {
    const { gh, clock } = setup();
    gh.setIssueViewDefault(
      issueView({
        number: 42,
        body: "just a bare description, no markers",
      }),
    );

    const result = await runRehydrate({ issue: 42, gh, clock });

    expect(result.rehydrate.note).toBeNull();
    const rendered = renderRehydrateText(result.rehydrate);
    expect(rendered).toMatch(/no agent-context note/i);
  });

  it("multiple agent-context blocks → shows the last-by-position (t_rehydrate_multiple_blocks_picks_last)", async () => {
    const { gh, clock } = setup();
    const body =
      `${MARK_O}\nfirst\n${MARK_C}\n\nseparator\n\n${MARK_O}\nNEWEST\n${MARK_C}`;
    gh.setIssueViewDefault(issueView({ number: 42, body }));

    const result = await runRehydrate({ issue: 42, gh, clock });

    expect(result.rehydrate.note).not.toBeNull();
    expect(result.rehydrate.note).toContain("NEWEST");
    // The stale "first" block is NOT in the picked note. (Scope the negative
    // assertion to data.note — the rendered text contains "first" inside the
    // "Live-state-first ritual" blurb, which is template text, not the note.)
    expect(result.rehydrate.note).not.toContain("first");

    const rendered = renderRehydrateText(result.rehydrate);
    expect(rendered).toContain("NEWEST");
  });
});

// ===========================================================================
// 5. Argv hygiene (TRANSFORMED) + verb-layer no-tier-match HandoffError
// ===========================================================================
//
// FINDING per case-map.md cases 61 + 63: bash refused non-numeric / `$()`
// payloads via $ARGUMENTS allow-list BEFORE any gh call. In TS, argv arrives
// pre-split; rejection happens at requireIssueNumber / requireSafeArgs
// (CLI layer). The verb's `issue` param is typed `number | undefined`, so
// these payloads can't reach runRehydrate — they're rejected upstream.
// Exercise the validators directly here (mirrors accept-verb.test.ts), and
// assert verb-layer behavior for the residual no-tier-match path.
//
// Cross-ref: args.test.ts (Task 3) for the full validator unit coverage.

describe("/rehydrate — argv hygiene (TRANSFORMED) + verb-layer no-tier-match", () => {
  it("non-numeric issue arg rejected at the args layer before any gh call (t_rehydrate_nonnumeric — TRANSFORMED)", () => {
    const { gh } = setup();
    // Literal bash payload from `bash rehydrate.sh '42; echo PWNED'`.
    expect(() => requireIssueNumber("42; echo PWNED")).toThrow(
      /positive integer/i,
    );
    // requireSafeArgs (run first in the CLI pipeline) ALSO rejects the
    // semicolon — defense in depth.
    expect(() => requireSafeArgs(["42; echo PWNED"])).toThrow(
      /disallowed characters/i,
    );
    expect(gh.calls().length).toBe(0);
  });

  it("$() command-sub payload refused at the args layer; PWNED not echoed (t_rehydrate_refuses_command_sub_payload — TRANSFORMED)", () => {
    const { gh } = setup();
    // Literal bash payload from `bash rehydrate.sh '$(echo PWNED)'`.
    let safeMsg = "";
    try {
      requireSafeArgs(["$(echo PWNED)"]);
    } catch (e) {
      safeMsg = (e as Error).message;
    }
    expect(safeMsg).toMatch(/disallowed characters/i);
    // Bash assertion: "PWNED" must not be echoed in the error.
    expect(safeMsg).not.toContain("PWNED");
    expect(gh.calls().length).toBe(0);
  });

  it("no-arg + no tier-1/tier-2 candidate → HandoffError with 'no in-flight handoff' message", async () => {
    // Verb-layer guard for the residual case where neither tier resolves an
    // issue. The bash analog is the no-arg path with empty lists; in TS this
    // is the explicit verb contract checked here (rehydrate-verb.ts:136-140).
    const { gh, clock } = setup();
    gh.setIssueListSlot(1, []); // tier 1: empty
    gh.setIssueListSlot(2, []); // tier 2: empty

    await expect(runRehydrate({ gh, clock })).rejects.toThrow(
      /no in-flight handoff/i,
    );
  });
});

// ===========================================================================
// 6. No-arg 2-tier resolution
// ===========================================================================

describe("/rehydrate — no-arg tier 1 (open + assigned-to-@me)", () => {
  it("resolves to open assigned-to-@me handoff (t_rehydrate_noarg_tier1_open_assigned)", async () => {
    const { gh, clock } = setup();
    gh.setIssueListSlot(1, [
      listItem({
        number: 151,
        title: "my open one",
        assignees: [{ login: "alien8d" }],
        updatedAt: "2026-05-30T00:00:00Z",
      }),
    ]);
    gh.setIssueViewDefault(
      issueView({
        number: 151,
        title: "my open one",
        assignees: [{ login: "alien8d" }],
        body: bodyWithBlock(),
      }),
    );

    const result = await runRehydrate({ gh, clock });

    expect(result.issueNumber).toBe(151);
    // Slot-1 list call fired with state=open, assignee=@me.
    expect(
      gh.calls().some((c) =>
        c.startsWith("gh issue list --state open --assignee @me"),
      ),
    ).toBe(true);
    // issueView for 151 fired (live-state anchor).
    expect(
      gh.calls().some((c) => c.startsWith("gh issue view 151")),
    ).toBe(true);
    // No closed-list query (tier 2 SHOULD NOT engage when tier 1 hits).
    expect(
      gh.calls().some((c) =>
        c.startsWith("gh issue list --state closed"),
      ),
    ).toBe(false);
  });

  it("tier-1 list failure → HandoffError fail-closed (t_rehydrate_noarg_tier1_list_fails_closed)", async () => {
    const { gh, clock } = setup();
    gh.setIssueListSlot(1, new Error("gh issue list failed (stubbed)"));

    await expect(runRehydrate({ gh, clock })).rejects.toThrow(
      /could not query in-flight handoffs/i,
    );
    // Did NOT silently fall through to tier 2: no closed-list query.
    expect(
      gh.calls().some((c) =>
        c.startsWith("gh issue list --state closed"),
      ),
    ).toBe(false);
  });
});

describe("/rehydrate — no-arg tier 2 (closed + accepted-by-@me within 7d)", () => {
  it("resolves to most recent closed-accepted-by-@me within 7d (t_rehydrate_noarg_tier2_closed_recent)", async () => {
    const { gh, clock } = setup();
    // Tier 1 returns empty → tier 2 engages.
    gh.setIssueListSlot(1, []);
    // closedAt = 2026-05-29T10:00:00Z, ~6d before NOW = 2026-05-30T12:00:00Z
    // → INSIDE the 7d window.
    gh.setIssueListSlot(2, [
      listItem({
        number: 88,
        title: "closed earlier",
        closedAt: "2026-05-29T10:00:00Z",
      }),
    ]);
    gh.setIssueViewDefault(
      issueView({
        number: 88,
        state: "CLOSED",
        closedAt: "2026-05-29T10:00:00Z",
        body: bodyWithBlock(),
      }),
    );

    const result = await runRehydrate({ gh, clock });

    expect(result.issueNumber).toBe(88);
    expect(result.rehydrate.stateLine).toBe("closed (accepted 2026-05-29)");
    // Tier-2 list call fired with state=closed.
    expect(
      gh.calls().some((c) =>
        c.startsWith("gh issue list --state closed --assignee @me"),
      ),
    ).toBe(true);
    // issueView for 88 fired.
    expect(
      gh.calls().some((c) => c.startsWith("gh issue view 88")),
    ).toBe(true);
  });

  it("tier 2 with +00:00 numeric offset → normalized + resolves (t_rehydrate_noarg_tier2_iso_offset_variant)", async () => {
    const { gh, clock } = setup();
    gh.setIssueListSlot(1, []);
    // +00:00 instead of Z. JS Date.parse accepts both, so this exercises the
    // ISO-variant tolerance at the verb layer; the normalization-is-load-
    // bearing assertion lives in iso.test.ts (cross-ref).
    gh.setIssueListSlot(2, [
      listItem({
        number: 88,
        title: "closed earlier",
        closedAt: "2026-05-29T10:00:00+00:00",
      }),
    ]);
    gh.setIssueViewDefault(
      issueView({
        number: 88,
        state: "CLOSED",
        closedAt: "2026-05-29T10:00:00+00:00",
        body: bodyWithBlock(),
      }),
    );

    const result = await runRehydrate({ gh, clock });

    expect(result.issueNumber).toBe(88);
    expect(result.rehydrate.stateLine).toMatch(/^closed/);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue view 88")),
    ).toBe(true);
  });

  it("tier 2 with .123Z fractional → normalized + resolves (t_rehydrate_noarg_tier2_iso_fractional_variant)", async () => {
    const { gh, clock } = setup();
    gh.setIssueListSlot(1, []);
    gh.setIssueListSlot(2, [
      listItem({
        number: 88,
        title: "closed earlier",
        closedAt: "2026-05-29T10:00:00.123Z",
      }),
    ]);
    gh.setIssueViewDefault(
      issueView({
        number: 88,
        state: "CLOSED",
        closedAt: "2026-05-29T10:00:00.123Z",
        body: bodyWithBlock(),
      }),
    );

    const result = await runRehydrate({ gh, clock });

    expect(result.issueNumber).toBe(88);
    expect(result.rehydrate.stateLine).toMatch(/^closed/);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue view 88")),
    ).toBe(true);
  });

  // Extra (not in case-map but adjacent): tier-2 candidate OVER 7d is rejected
  // and the verb throws the "no in-flight handoff" HandoffError. Locks the
  // 7d cutoff math (rehydrate-verb.ts:128) — without this, an off-by-86400
  // regression would not be caught by the in-window test above.
  it("tier 2 candidate OVER 7d → no fallback engages → HandoffError (extra coverage)", async () => {
    const { gh, clock } = setup();
    gh.setIssueListSlot(1, []);
    // closedAt = 2026-05-20T00:00:00Z is BEFORE the 2026-05-23T12:00:00Z
    // cutoff (NOW − 7d) → out of window.
    gh.setIssueListSlot(2, [
      listItem({
        number: 99,
        title: "too old",
        closedAt: "2026-05-20T00:00:00Z",
      }),
    ]);

    await expect(runRehydrate({ gh, clock })).rejects.toThrow(
      /no in-flight handoff/i,
    );
    // Tier-2 list was queried, but no issueView fired for the stale candidate.
    expect(
      gh.calls().some((c) =>
        c.startsWith("gh issue list --state closed --assignee @me"),
      ),
    ).toBe(true);
    expect(
      gh.calls().some((c) => c.startsWith("gh issue view 99")),
    ).toBe(false);
  });
});
