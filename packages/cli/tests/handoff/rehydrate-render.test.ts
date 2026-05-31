// packages/cli/tests/handoff/rehydrate-render.test.ts
//
// Tests for renderRehydrateText — branch coverage on the data shape.
// Byte-for-byte bash parity is asserted separately in Task 21 (parity.test.ts).

import { describe, expect, it } from "vitest";

import type { RehydrateData } from "../../src/handoff/rehydrate-core.js";
import { renderRehydrateText } from "../../src/handoff/rehydrate-render.js";

const BASE: RehydrateData = {
  issueNumber: 42,
  title: "Handoff: feature/x",
  stateLine: "open (unassigned — on the stack)",
  linkedItems: [],
  linkFailures: 0,
  note: null,
};

describe("renderRehydrateText", () => {
  it("emits live-state header + title + state line", () => {
    const out = renderRehydrateText(BASE);
    expect(out).toContain(
      "=== handoff #42 — LIVE STATE (script-derived; this is the truth, not the note) ===",
    );
    expect(out).toContain("  Handoff: feature/x");
    expect(out).toContain("  state: open (unassigned — on the stack)");
  });

  it("no note → emits 'no agent-context note on #N' message", () => {
    const out = renderRehydrateText(BASE);
    expect(out).toContain(
      "(no agent-context note on #42 — you have the live state above; read the linked items to continue.)",
    );
    expect(out).not.toContain("Prior session's reasoning");
  });

  it("with note → emits reasoning block bounded by ===== rulers + ritual", () => {
    const out = renderRehydrateText({
      ...BASE,
      note: "<!-- agent-context:v1 -->\nwhy: chose path 1\n<!-- /agent-context:v1 -->",
    });
    expect(out).toContain("Prior session's reasoning");
    expect(out).toContain("why: chose path 1");
    expect(out).toContain("Live-state-first ritual");
    // Two ruler lines bounding the reasoning block (77 `=` chars each).
    const rulers = out.match(/^=+$/gm) ?? [];
    expect(rulers.length).toBe(2);
    expect(rulers[0]!.length).toBe(77);
    expect(rulers[1]!.length).toBe(77);
  });

  it("strips control chars from note at render time", () => {
    const noteWithEsc =
      "<!-- agent-context:v1 -->\nhello\x1B[31mred\x1B[0m world\n<!-- /agent-context:v1 -->";
    const out = renderRehydrateText({ ...BASE, note: noteWithEsc });
    expect(out).not.toContain("\x1B");
    expect(out).toContain("hello[31mred[0m world");
  });

  it("no linked items → no '--- linked work items ---' header", () => {
    const out = renderRehydrateText(BASE);
    expect(out).not.toContain("--- linked work items ---");
  });

  it("OPEN PR linked item → renders with [mergeable, review, checks] + checkout hint", () => {
    const out = renderRehydrateText({
      ...BASE,
      linkedItems: [
        {
          kind: "pr",
          display: "#103",
          title: "deploy spec",
          state: "OPEN",
          annotation: "",
          checkoutHint: "gh pr checkout 103",
          extra: {
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            checksSummary: "2 pass",
          },
        },
      ],
    });
    expect(out).toContain("  --- linked work items ---");
    expect(out).toContain(
      "  pr #103 — deploy spec [mergeable: CLEAN, review: APPROVED, checks: 2 pass]",
    );
    expect(out).toContain("              checkout: gh pr checkout 103");
  });

  it("MERGED PR linked item → '(merged)' annotation, NO checkout hint", () => {
    const out = renderRehydrateText({
      ...BASE,
      linkedItems: [
        {
          kind: "pr",
          display: "#200",
          title: "merged change",
          state: "MERGED",
          annotation: "(merged)",
        },
      ],
    });
    expect(out).toContain("  pr #200 — merged change (merged)");
    expect(out).not.toContain("checkout: gh pr checkout 200");
  });

  it("CLOSED PR linked item → '(closed)' annotation", () => {
    const out = renderRehydrateText({
      ...BASE,
      linkedItems: [
        {
          kind: "pr",
          display: "#201",
          title: "abandoned",
          state: "CLOSED",
          annotation: "(closed)",
        },
      ],
    });
    expect(out).toContain("  pr #201 — abandoned (closed)");
  });

  it("UNREACHABLE PR linked item → '(unreachable: gh pr view failed)' annotation", () => {
    const out = renderRehydrateText({
      ...BASE,
      linkedItems: [
        {
          kind: "pr",
          display: "#999",
          title: "broken",
          state: "UNREACHABLE",
          annotation: "(unreachable: gh pr view failed)",
        },
      ],
    });
    expect(out).toContain(
      "  pr #999 — broken (unreachable: gh pr view failed)",
    );
  });

  it("OPEN issue linked item → '[open]' or '[open, assigned X]' annotation", () => {
    const out = renderRehydrateText({
      ...BASE,
      linkedItems: [
        {
          kind: "issue",
          display: "#91",
          title: "degradation",
          state: "OPEN",
          annotation: "[open]",
        },
        {
          kind: "issue",
          display: "#92",
          title: "other",
          state: "OPEN",
          annotation: "[open, assigned someone]",
          extra: { assigneesCsv: "someone" },
        },
      ],
    });
    expect(out).toContain("  issue #91 — degradation [open]");
    expect(out).toContain("  issue #92 — other [open, assigned someone]");
  });

  it("cross-repo PR checkout hint includes --repo", () => {
    const out = renderRehydrateText({
      ...BASE,
      linkedItems: [
        {
          kind: "pr",
          display: "momentiq-ai/dark-factory#59",
          title: "cross",
          state: "OPEN",
          annotation: "",
          checkoutHint: "gh pr checkout 59 --repo momentiq-ai/dark-factory",
          extra: {
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            checksSummary: "no checks",
          },
        },
      ],
    });
    expect(out).toContain(
      "checkout: gh pr checkout 59 --repo momentiq-ai/dark-factory",
    );
  });

  it("closed issue state line carries the date", () => {
    const out = renderRehydrateText({
      ...BASE,
      stateLine: "closed (accepted 2026-05-29)",
    });
    expect(out).toContain("  state: closed (accepted 2026-05-29)");
  });

  it("unknown link kind → renders em dash + empty title + annotation (bash parity)", () => {
    // Bash: `printf '  ? %s — %s (unknown link type)\n' "$disp_ref" "$title"`
    // with title="" produces `  ? weird-line —  (unknown link type)` —
    // em dash followed by two spaces (the empty %s + the literal space
    // before `(unknown...`). Bash printf does not collapse the gap;
    // matching it is load-bearing for Task 21 byte-parity.
    const out = renderRehydrateText({
      ...BASE,
      linkedItems: [
        {
          kind: "?",
          display: "weird-line",
          title: "",
          state: "UNREACHABLE",
          annotation: "(unknown link type)",
        },
      ],
    });
    expect(out).toContain("  ? weird-line —  (unknown link type)");
  });
});
