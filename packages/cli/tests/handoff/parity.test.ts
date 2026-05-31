// packages/cli/tests/handoff/parity.test.ts
//
// Byte-identical parity tests: TS output === bash output for 3 fixed-stub
// scenarios. Snapshots were captured in Task 16 (fixtures/bash-output/) from
// the bash impl at dark-factory-platform@b23865ba (origin/main captured
// 2026-05-30). Stub configs + FixedClock epoch documented verbatim in
// fixtures/bash-output/CAPTURE.md — this test's inputs MUST match CAPTURE.md
// exactly; the plan outline's illustrative code-block in the Task-21 brief is
// NOT the source of truth (e.g. #101 updatedAt is 12:00:00Z per CAPTURE.md,
// not 00:00:00Z — CAPTURE.md anchors "exactly 24h before FIXED_NOW → 1d ago").
//
// These tests close the "byte-identical claim" gap — the ~85 ported
// behavioral tests assert specific control flow + substrings; the parity
// tests prove TS and bash produce IDENTICAL bytes on the same inputs for
// representative scenarios end-to-end.
//
// Snapshot trailing-newline contract: each .txt ends with a single `\n`
// (verified via `tail -c 5 … | od -c`). The TS verbs return strings WITHOUT
// a trailing `\n` (per runHandoffs's text contract — Task 14 — and
// renderRehydrateText's contract — Task 10 — "no trailing newline"; the CLI
// print layer adds one). We strip the snapshot's trailing `\n` rather than
// appending one to the TS output, to preserve the verbs' "no trailing
// newline" invariant in the comparison.
//
// Em-dash byte significance: the linked-item input bodies use real U+2014
// em-dashes (` — `). parseEntry's regex matches that exact codepoint; a
// retyped hyphen-minus would silently fail to parse, dropping linked items
// from rehydrate output and zeroing /handoffs link counts. Copy the glyph,
// do not retype it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runHandoffs } from "../../src/handoff/handoffs-verb.js";
import { runRehydrate } from "../../src/handoff/rehydrate-verb.js";
import { renderRehydrateText } from "../../src/handoff/rehydrate-render.js";
import type {
  IssueListItem,
  IssueView,
  PrView,
} from "../../src/handoff/ports.js";

import { FakeGhClient } from "./fixtures/stubs/fake-gh.js";
import { FixedClock } from "./fixtures/stubs/fixed-clock.js";

const here = dirname(fileURLToPath(import.meta.url));
const snap = (n: string) =>
  readFileSync(resolve(here, `fixtures/bash-output/${n}`), "utf8");

// FixedClock pin from CAPTURE.md — 1780142400 = 2026-05-30T12:00:00Z.
// Required to reproduce handoffs-list.txt's "1d ago" / "12h ago".
// (rehydrate-open.txt and rehydrate-closed.txt are clock-independent
// per CAPTURE.md, but we pin the same clock for consistency.)
const FIXED_NOW_EPOCH = 1780142400;
const FIXED_NOW_YMD = "2026-05-30";

// Snapshots have a trailing `\n` (bash `> file` redirection); TS verbs do
// not. Strip the trailing `\n` from the snapshot so the comparison matches
// the verbs' no-trailing-newline contract verbatim.
const stripTrailingNewline = (s: string): string => s.replace(/\n$/, "");

describe("parity — TS output byte-identical to bash output", () => {
  // -------------------------------------------------------------------------
  // Snapshot 1: /handoffs with 2 rows (one with linked items, one without).
  // CAPTURE.md § "Snapshot 1: handoffs-list.txt" — inputs verbatim from there.
  // -------------------------------------------------------------------------
  it("/handoffs with 2 rows matches handoffs-list.txt byte-for-byte", async () => {
    const gh = new FakeGhClient();
    const clock = new FixedClock(FIXED_NOW_EPOCH, FIXED_NOW_YMD);

    // body_101 from CAPTURE.md — includes a parseable `- pr #103 — deploy
    // spec` entry inside the marker block → extractLinkedItems returns 1 →
    // renders `linked: 1 items` (yes, "1 items" not "1 item" — bash invariant
    // documented in CAPTURE.md § "Notable byte-significant quirks").
    const body101 =
      "<!-- agent-context:v1 -->\n" +
      "**Linked work items:**\n" +
      "- pr #103 — deploy spec\n" +
      "\n" +
      "why: example\n" +
      "<!-- /agent-context:v1 -->";

    // body_102 from CAPTURE.md — no `- pr|issue` entries inside markers →
    // extractLinkedItems returns 0 → renders `linked: none`.
    const body102 =
      "<!-- agent-context:v1 -->\n" +
      "no links here\n" +
      "<!-- /agent-context:v1 -->";

    // Per CAPTURE.md:
    //   #101 updatedAt 2026-05-29T12:00:00Z — exactly 24h pre FIXED_NOW → "1d ago"
    //   #102 updatedAt 2026-05-30T00:00:00Z — exactly 12h pre FIXED_NOW → "12h ago"
    // Order in the input list is irrelevant (the impl re-sorts ascending by
    // updatedAt before rendering — same as bash's sort_by(.updatedAt)); we
    // keep it the same as CAPTURE.md anyway for fidelity.
    const list: readonly IssueListItem[] = [
      {
        number: 101,
        title: "Handoff: cycle 12.1",
        assignees: [],
        body: body101,
        createdAt: "2026-05-29T12:00:00Z",
        updatedAt: "2026-05-29T12:00:00Z",
      },
      {
        number: 102,
        title: "Handoff: closeout",
        assignees: [],
        body: body102,
        createdAt: "2026-05-28T00:00:00Z",
        updatedAt: "2026-05-30T00:00:00Z",
      },
    ];
    gh.setIssueListDefault(list);

    const result = await runHandoffs({ gh, clock });
    const expected = stripTrailingNewline(snap("handoffs-list.txt"));
    expect(result.text).toBe(expected);
  });

  // -------------------------------------------------------------------------
  // Snapshot 2: /rehydrate on OPEN issue with 1 linked OPEN PR.
  // CAPTURE.md § "Snapshot 2: rehydrate-open.txt" — inputs verbatim.
  // -------------------------------------------------------------------------
  it("/rehydrate on OPEN issue with 1 linked OPEN PR matches rehydrate-open.txt", async () => {
    const gh = new FakeGhClient();
    const clock = new FixedClock(FIXED_NOW_EPOCH, FIXED_NOW_YMD);

    // STUB_ISSUE_BODY from CAPTURE.md — note the em-dash inside the linked
    // entry (` — `, U+2014). Required for parseEntry to match; a hyphen
    // silently drops the linked-item line from the rendered output.
    const issueBody =
      "<!-- agent-context:v1 -->\n" +
      "_Updated: 2026-05-30 by claude-opus-4-7 session_\n" +
      "\n" +
      "**Linked work items:**\n" +
      "- pr #103 — deploy spec\n" +
      "\n" +
      "**Why this approach (and what I rejected):**\n" +
      "- example reasoning\n" +
      "<!-- /agent-context:v1 -->";

    const issueView: IssueView = {
      number: 42,
      title: "Handoff: cycle12.1 impl",
      body: issueBody,
      state: "OPEN",
      // STUB_ISSUE_ASSIGNEES="" → empty list → renders the
      // "open (unassigned — on the stack)" branch in deriveRehydrateData.
      assignees: [],
      labels: [{ name: "handoff" }],
      // updatedAt is not rendered by /rehydrate (only /handoffs uses it);
      // value is immaterial to the snapshot. Pinned for stability.
      updatedAt: "2026-05-30T00:00:00Z",
      closedAt: null,
    };
    gh.setIssueViewDefault(issueView);

    // STUB_PR_REFS='103|deploy spec|OPEN|CLEAN|APPROVED' — bash stub's
    // _pr_blob ALWAYS emits `statusCheckRollup: []`, which TS's
    // summarizeChecks maps to the literal "no checks" string (matches
    // CAPTURE.md § "Notable byte-significant lines" for the trailing
    // `checks: no checks` rendering).
    const prView: PrView = {
      title: "deploy spec",
      state: "OPEN",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollup: [],
    };
    gh.setPrViewDefault(103, prView);

    // Explicit `issue` skips the no-arg 2-tier resolution → only
    // issueView(42) + prView(103) are exercised — matches the bash
    // capture's call profile (`bash scripts/rehydrate.sh 42`).
    const r = await runRehydrate({ issue: 42, gh, clock });
    const text = renderRehydrateText(r.rehydrate);
    const expected = stripTrailingNewline(snap("rehydrate-open.txt"));
    expect(text).toBe(expected);
  });

  // -------------------------------------------------------------------------
  // Snapshot 3: /rehydrate on CLOSED issue (forensic catch-up).
  // CAPTURE.md § "Snapshot 3: rehydrate-closed.txt" — inputs verbatim.
  // -------------------------------------------------------------------------
  it("/rehydrate on CLOSED issue (forensic) matches rehydrate-closed.txt", async () => {
    const gh = new FakeGhClient();
    const clock = new FixedClock(FIXED_NOW_EPOCH, FIXED_NOW_YMD);

    const issueBody =
      "<!-- agent-context:v1 -->\n" +
      "_Updated: 2026-05-29_\n" +
      "\n" +
      "why: closed example\n" +
      "<!-- /agent-context:v1 -->";

    const issueView: IssueView = {
      number: 88,
      title: "Handoff: closed example",
      body: issueBody,
      state: "CLOSED",
      assignees: [],
      labels: [{ name: "handoff" }],
      // Immaterial for /rehydrate render (not used in the CLOSED branch).
      updatedAt: "2026-05-29T10:00:00Z",
      // closedAt → `cut -c1-10` in bash, `.slice(0, 10)` in TS →
      // renders `closed (accepted 2026-05-29)`.
      closedAt: "2026-05-29T10:00:00Z",
    };
    gh.setIssueViewDefault(issueView);

    // No STUB_PR_REFS set in CAPTURE.md for this snapshot → no linked
    // items in the body → no prView calls needed.
    const r = await runRehydrate({ issue: 88, gh, clock });
    const text = renderRehydrateText(r.rehydrate);
    const expected = stripTrailingNewline(snap("rehydrate-closed.txt"));
    expect(text).toBe(expected);
  });
});
