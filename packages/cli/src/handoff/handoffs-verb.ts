// packages/cli/src/handoff/handoffs-verb.ts
//
// /handoffs — list the handoff stack. PORT FROM dark-factory-platform
// .claude/skills/handoff/scripts/handoffs.sh@a6f711b (58 LOC bash).
//
// Returns BOTH structured rows AND rendered text. The CLI prints text;
// the MCP tool returns the rows as structuredContent.
//
// Per-row link count is computed via extractLinkedItems (in-marker scoped),
// so stale outside-marker Linked-items sections don't inflate counts —
// matches bash's fix (lib.sh@a6f711b note in handoffs.sh:39-45).
//
// Sort order is ASCENDING by updatedAt — oldest first — matching bash's
// `sort_by(.updatedAt)`. localeCompare on ISO-8601 strings is byte-equal
// to lexical comparison (the canonical Z-suffixed shape sorts correctly).
//
// Per-row age uses an explicit `epoch !== undefined` guard (not `?? 0`),
// so a malformed updatedAt renders `"?"` rather than a 1970 "Nd ago" — a
// legitimate epoch of 0 still formats normally.
//
// Empty stack returns a distinct message (NOT a row), and gh failure
// throws HandoffError (fail-closed — a transient gh error should be
// diagnosed, not silently rendered as "stack is empty").
//
// /handoffs is per-repo: gh issue list is repo-scoped, and a cross-repo
// aggregator is deferred to OQ-12.3.

import { formatAge, isoToEpoch } from "./iso.js";
import { extractLinkedItems } from "./links.js";
import { HandoffError, type Clock, type GhClient } from "./ports.js";
import { stripControlChars } from "./strip-control.js";

export interface HandoffStackRow {
  readonly issueNumber: number;
  readonly title: string;
  readonly age: string;
  readonly linkedCount: number;
  readonly linkedDisplay: string;
}

export interface RunHandoffsResult {
  readonly rows: readonly HandoffStackRow[];
  /**
   * Bash-compatible text output: header + one line per row + blank line +
   * footer. No trailing newline — the CLI print layer adds it (Task 21
   * snapshot parity).
   */
  readonly text: string;
  readonly logs: readonly string[];
}

/**
 * List the handoff stack (open + handoff-labeled + unassigned, sorted
 * oldest → newest by updatedAt). Returns both structured rows and the
 * rendered text so the CLI prints text and the MCP tool returns rows as
 * structuredContent.
 */
export async function runHandoffs(opts: {
  readonly gh: GhClient;
  readonly clock: Clock;
}): Promise<RunHandoffsResult> {
  const { gh, clock } = opts;
  const logs: string[] = [];

  let list;
  try {
    list = await gh.issueList({ state: "open", search: "no:assignee" });
  } catch {
    throw new HandoffError(
      "gh issue list failed — cannot render the handoff stack.",
    );
  }

  if (list.length === 0) {
    return {
      rows: [],
      text:
        "handoff stack is empty (no open, unassigned issues labeled 'handoff').",
      logs,
    };
  }

  // Sort ascending by updatedAt (matches bash sort_by(.updatedAt)).
  // localeCompare on canonical ISO-8601 (Z-suffixed) sorts byte-equal.
  const sorted = [...list].sort((a, b) =>
    (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""),
  );

  const now = clock.nowEpoch();
  const rows: HandoffStackRow[] = sorted.map((item) => {
    const title = stripControlChars(item.title);
    const linkedItems = extractLinkedItems(item.body ?? "");
    const linkedCount = linkedItems.length;
    const linkedDisplay = linkedCount === 0 ? "none" : `${linkedCount} items`;
    const epoch = item.updatedAt ? isoToEpoch(item.updatedAt) : undefined;
    // Explicit undefined-check (NOT `?? 0`) — a parse failure renders "?"
    // rather than a 1970-relative "Nd ago".
    const age = epoch !== undefined ? formatAge(epoch, now) : "?";
    return {
      issueNumber: item.number,
      title,
      age,
      linkedCount,
      linkedDisplay,
    };
  });

  const lines: string[] = [];
  lines.push("Handoff stack (oldest → newest):");
  for (const row of rows) {
    lines.push(
      `#${row.issueNumber} · ${row.title} · ${row.age} · linked: ${row.linkedDisplay}`,
    );
  }
  lines.push("");
  lines.push("Pick one:  /accept <issue>");

  return { rows, text: lines.join("\n"), logs };
}
