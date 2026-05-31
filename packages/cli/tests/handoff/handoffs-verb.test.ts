// packages/cli/tests/handoff/handoffs-verb.test.ts
//
// Ported from .claude/skills/handoff/tests/test_handoff.sh, case-map.md
// § /handoffs (cases 1-5). Each test cites its source `t_handoffs_*`
// function in a comment near the top.
//
// Coverage:
//   1. renders_rows         — query shape + row rendering + per-row link count
//   2. empty                — empty list → "stack is empty"
//   3. iso_timestamp_variants — ISO-8601 variants (fractional, +00:00)
//      normalize so format_age produces a real age (TRANSFORMED: bash asserts
//      the empty-stack jq-fromdate false negative; in TS the failure mode
//      is `age === "?"` from impl's `epoch !== undefined` guard, so we
//      assert `age` matches a real age string).
//   4. link_count_scoped_to_markers — stale outside-marker links ignored.
//   5. strips_control_chars_in_title — terminal-escape safety on row titles.
//
// Plus one extra (mirrors the rehydrate-verb test pattern):
//   - gh issue list failure → fail-closed HandoffError.
//   - malformed updatedAt → age === "?" (locks impl's explicit
//     `epoch !== undefined` guard — the complement of case 3).
//
// CONTRACT: bash's `--label handoff` filter is hardcoded inside
// real-clients.ts:212-213 (NOT a parameter on the GhClient interface), so it
// never appears in the FakeGhClient's call log. We assert what the fake CAN
// see: `state=open` + `search=no:assignee`. This is the same precedent as
// rehydrate-verb.test.ts (which asserts state + assignee on issueList, not
// label). Snapshot byte-parity against
// fixtures/bash-output/handoffs-list.txt is Task 21's parity.test.ts.

import { describe, it, expect } from "vitest";

import type { IssueListItem } from "../../src/handoff/ports.js";
import { runHandoffs } from "../../src/handoff/handoffs-verb.js";
import { FakeGhClient } from "./fixtures/stubs/fake-gh.js";
import { FixedClock } from "./fixtures/stubs/fixed-clock.js";

const MARK_O = "<!-- agent-context:v1 -->";
const MARK_C = "<!-- /agent-context:v1 -->";

// FixedClock = 2026-05-30T12:00:00Z (matches CAPTURE.md FIXED_NOW_EPOCH so
// the same clock pin works if a future test wants to reproduce snapshot
// fragments). updatedAt offsets per test set the rendered age.
const NOW_EPOCH = 1780142400;
const NOW_YMD = "2026-05-30";

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

// ===========================================================================
// 1. renders_rows
// ===========================================================================

describe("/handoffs — renders rows", () => {
  it("queries open + no:assignee + handoff label; renders rows with link counts (t_handoffs_renders_rows)", async () => {
    const { gh, clock } = setup();
    // Em-dash (U+2014) separator is REQUIRED by extractLinkedItems → without
    // it the entry doesn't parse and count comes out 0 (false-pass risk).
    // Fixtures copied verbatim from bash t_handoffs_renders_rows (2 links on
    // #101: pr #103 + issue #91; #102 has no markers → 0 links).
    const body101 =
      `${MARK_O}\n**Linked work items:**\n` +
      `- pr #103 — deploy spec\n` +
      `- issue #91 — vendor degradation\n\n` +
      `body\n${MARK_C}`;
    const body102 = "some body without markers and no links";
    gh.setIssueListDefault([
      listItem({
        number: 101,
        title: "Handoff: cycle 12.1",
        createdAt: "2026-05-29T00:00:00Z",
        updatedAt: "2026-05-30T00:00:00Z",
        body: body101,
      }),
      listItem({
        number: 102,
        title: "Handoff: closeout",
        createdAt: "2026-05-28T00:00:00Z",
        updatedAt: "2026-05-30T01:00:00Z",
        body: body102,
      }),
    ]);

    const result = await runHandoffs({ gh, clock });

    // Sort is ASCENDING by updatedAt — #101 (00:00) before #102 (01:00).
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.issueNumber).toBe(101);
    expect(result.rows[0]!.linkedCount).toBe(2);
    expect(result.rows[0]!.linkedDisplay).toBe("2 items");
    expect(result.rows[1]!.issueNumber).toBe(102);
    expect(result.rows[1]!.linkedCount).toBe(0);
    expect(result.rows[1]!.linkedDisplay).toBe("none");

    // Bash asserts `'issue list --label handoff --state open'` + `'no:assignee'`
    // in GH_CALLS. The `--label handoff` filter is hardcoded inside
    // real-clients.ts:212-213 (not a parameter on the GhClient interface), so
    // it never reaches the FakeGhClient's call log — we assert the visible
    // call shape: state=open + search=no:assignee.
    const listCall = gh.calls().find((c) => c.startsWith("gh issue list"));
    expect(listCall).toBeDefined();
    expect(listCall).toContain("--state open");
    expect(listCall).toContain("no:assignee");

    // Render-text parity with bash assertions.
    expect(result.text).toContain("#101");
    expect(result.text).toContain("#102");
    expect(result.text).toContain("linked: 2 items");
    expect(result.text).toContain("linked: none");
  });
});

// ===========================================================================
// 2. empty
// ===========================================================================

describe("/handoffs — empty stack", () => {
  it("empty list → 'stack is empty' message (t_handoffs_empty)", async () => {
    const { gh, clock } = setup();
    gh.setIssueListDefault([]);

    const result = await runHandoffs({ gh, clock });

    expect(result.rows).toEqual([]);
    expect(result.text.toLowerCase()).toContain("stack is empty");
  });
});

// ===========================================================================
// 3. ISO-8601 variants (TRANSFORMED)
// ===========================================================================
//
// Bash asserted: variant timestamps that confuse jq fromdate produce an
// empty-stack false negative. In TS the failure mode is different — a
// parse failure surfaces as `age === "?"` (impl's `epoch !== undefined`
// guard at handoffs-verb.ts:98). So the direct TS analog is: BOTH rows
// present AND each row.age matches a real coarse-age string (not "?").
// Cross-ref: iso.test.ts for the normalization unit coverage.

describe("/handoffs — ISO-8601 variant tolerance (TRANSFORMED)", () => {
  it("fractional + numeric-offset timestamps normalize → rows render with real ages (t_handoffs_iso_timestamp_variants)", async () => {
    const { gh, clock } = setup();
    gh.setIssueListDefault([
      listItem({
        number: 201,
        title: "with fractional",
        createdAt: "2026-05-29T00:00:00.500Z",
        updatedAt: "2026-05-30T00:00:00.123Z",
        body: "no links",
      }),
      listItem({
        number: 202,
        title: "with numeric offset",
        createdAt: "2026-05-29T00:00:00+00:00",
        updatedAt: "2026-05-30T01:00:00+00:00",
        body: "no links",
      }),
    ]);

    const result = await runHandoffs({ gh, clock });

    expect(result.rows).toHaveLength(2);
    // Neither variant should render as "?" — that would mean normalizeIso
    // failed and the impl's `epoch !== undefined` guard kicked in.
    for (const row of result.rows) {
      expect(row.age).not.toBe("?");
      // Coarse-age forms: "just now" | "Nm ago" | "Nh ago" | "Nd ago".
      expect(row.age).toMatch(/^(just now|\d+[mhd] ago)$/);
    }

    // Bash assertion: rendered text contains both row markers AND does NOT
    // say "stack is empty" (the empty-stack false negative the bash test
    // was guarding against).
    expect(result.text).toContain("#201");
    expect(result.text).toContain("#202");
    expect(result.text.toLowerCase()).not.toContain("stack is empty");
  });
});

// ===========================================================================
// 4. link count scoped to markers
// ===========================================================================

describe("/handoffs — link count scoped to in-marker", () => {
  it("stale outside-marker Linked-items section ignored; in-marker only counts (t_handoffs_link_count_scoped_to_markers)", async () => {
    const { gh, clock } = setup();
    // Stale `**Linked work items:**` section + #999 OUTSIDE markers → ignored.
    // Inside markers: canonical #103. Link count should be 1 — NOT 2.
    const body =
      `**Linked work items:**\n- pr #999 — STALE outside\n\n` +
      `${MARK_O}\n**Linked work items:**\n- pr #103 — canonical\n${MARK_C}`;
    gh.setIssueListDefault([
      listItem({
        number: 201,
        title: "mixed body",
        createdAt: "2026-05-29T00:00:00Z",
        updatedAt: "2026-05-30T00:00:00Z",
        body,
      }),
    ]);

    const result = await runHandoffs({ gh, clock });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.linkedCount).toBe(1);
    expect(result.rows[0]!.linkedDisplay).toBe("1 items");
    expect(result.text).toContain("linked: 1 items");
  });
});

// ===========================================================================
// 5. control/ESC chars stripped from title
// ===========================================================================

describe("/handoffs — title sanitization", () => {
  it("control/ESC chars stripped from row title (t_handoffs_strips_control_chars_in_title)", async () => {
    const { gh, clock } = setup();
    // ESC sequence (0x1B[31m) in title. Bash's strip_control_chars (and the
    // TS stripControlChars) only removes the 0x1B byte itself — "[31m" + the
    // trailing literal "RESET" survive. Mirrors the rehydrate-verb title
    // case (t_rehydrate_strips_control_chars_in_title).
    gh.setIssueListDefault([
      listItem({
        number: 301,
        title: "Handoff: feature/x\x1b[31mRESET",
        createdAt: "2026-05-29T00:00:00Z",
        updatedAt: "2026-05-30T00:00:00Z",
        body: "no links",
      }),
    ]);

    const result = await runHandoffs({ gh, clock });

    expect(result.rows).toHaveLength(1);
    // Structured row title: ESC stripped, "[31mRESET" preserved.
    expect(result.rows[0]!.title).not.toMatch(/\x1b/);
    expect(result.rows[0]!.title).toBe("Handoff: feature/x[31mRESET");
    // Bash assertions: no ESC byte in rendered text + row marker present.
    expect(result.text).not.toMatch(/\x1b/);
    expect(result.text).toContain("#301");
  });
});

// ===========================================================================
// 6. Extra coverage — fail-closed on gh failure + age "?" on malformed iso
// ===========================================================================

describe("/handoffs — extra coverage", () => {
  it("gh issue list failure → HandoffError fail-closed (NOT silent 'stack is empty')", async () => {
    const { gh, clock } = setup();
    gh.setIssueListSlot(1, new Error("gh issue list failed (stubbed)"));

    await expect(runHandoffs({ gh, clock })).rejects.toThrow(
      /cannot render the handoff stack/i,
    );
  });

  it("malformed updatedAt → row.age === '?' (locks impl's epoch !== undefined guard)", async () => {
    // Complement of the ISO-variant test: a string that normalizeIso cannot
    // recover from → isoToEpoch returns undefined → impl's explicit
    // `epoch !== undefined ? formatAge(...) : "?"` guard renders "?". Without
    // this test the guard could regress to `?? 0` and yield a "20053d ago"
    // 1970-relative age, and the ISO-variant test would not catch it.
    const { gh, clock } = setup();
    gh.setIssueListDefault([
      listItem({
        number: 401,
        title: "broken timestamp",
        createdAt: "2026-05-29T00:00:00Z",
        updatedAt: "not-a-timestamp",
        body: "no links",
      }),
    ]);

    const result = await runHandoffs({ gh, clock });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.age).toBe("?");
  });
});
