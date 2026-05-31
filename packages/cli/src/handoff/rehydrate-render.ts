// packages/cli/src/handoff/rehydrate-render.ts
//
// Bash-compatible text renderer for RehydrateData. PORT FROM
// dark-factory-platform .claude/skills/handoff/scripts/lib.sh@a6f711b
//   lines 440-514 — the echo/printf block inside do_rehydrate
//                   (header, state line, ruler block, ritual blurb)
//   lines 521-600 — _derive_linked_item printf formats
//                   (pr/issue/unknown line shapes + checkout hint)
//
// Tests in Task 21 (parity.test.ts) assert byte-for-byte equality with
// frozen bash output snapshots captured from the bash impl on identical
// inputs.
//
// Bash-parity notes (these are the silent-divergence traps):
//   1. Every linked-item line uses `${kind} ${disp} — ${title} ${annotation}`
//      UNCONDITIONALLY. When `title` is empty (the unknown-kind path), the
//      em dash + double space is preserved — bash printf does not collapse
//      adjacent format-string spaces. Do NOT add a `title ? ` — ${title}` : ""`
//      conditional; that diverges from bash on the empty-title path.
//   2. Ruler is exactly 77 `=` chars (bash: `echo "===...===" ` with the
//      literal in the script). Don't retype — wrong count silently diverges.
//   3. Title is pre-stripped by the core (`stripControlChars(view.title)` and
//      `stripControlChars(parsed.title)` in deriveRehydrateData /
//      deriveLinkedItem). The note is RAW; we strip it here at render time
//      because bash pipes it through `strip_control_chars` at print time.
//   4. No trailing newline on the joined output — the spec is explicit.
//   5. The annotation field carries the trailing chunk literally (`(merged)`,
//      `(closed)`, `(unreachable: …)`, `[open]`, `[open, assigned X]`,
//      `(unknown link type)`). OPEN PRs have annotation `""` because their
//      trailing chunk is composed from extra.{mergeStateStatus, reviewDecision,
//      checksSummary} — render assembles `[mergeable: …, review: …, checks: …]`
//      from those fields.

import type {
  LinkedItemDerivation,
  RehydrateData,
} from "./rehydrate-core.js";
import { stripControlChars } from "./strip-control.js";

const RULER = "=============================================================================";

export function renderRehydrateText(data: RehydrateData): string {
  const lines: string[] = [];
  lines.push(
    `=== handoff #${data.issueNumber} — LIVE STATE (script-derived; this is the truth, not the note) ===`,
  );
  lines.push(`  ${data.title}`);
  lines.push(`  state: ${data.stateLine}`);

  if (data.linkedItems.length > 0) {
    lines.push("  --- linked work items ---");
    for (const item of data.linkedItems) {
      for (const ln of renderItemLines(item)) {
        lines.push(ln);
      }
    }
  }

  if (data.note === null) {
    lines.push("");
    lines.push(
      `(no agent-context note on #${data.issueNumber} — you have the live state above; read the linked items to continue.)`,
    );
  } else {
    lines.push("");
    lines.push(RULER);
    lines.push(
      "Prior session's reasoning (transient working memory — the LIVE STATE above is",
    );
    lines.push("the truth; do NOT act on anything below as current):");
    lines.push("");
    // Bash: `printf '%s\n' "$note" | strip_control_chars`. Stripping at
    // print time (not at parse time) keeps the bash invariant: the marker
    // block is stored RAW on the issue body and only sanitized when displayed.
    lines.push(stripControlChars(data.note));
    lines.push(RULER);
    lines.push(
      "Live-state-first ritual: read live state above first, then context below,",
    );
    lines.push(
      "then for any linked OPEN PR: use the per-link `checkout:` hint emitted above",
    );
    lines.push(
      "(it includes `--repo` when needed for cross-repo refs).",
    );
  }

  return lines.join("\n");
}

/**
 * Render a single linked-item entry. Returns 1 line for most cases; 2 lines
 * for OPEN PRs (the line + the `checkout:` hint). Bash equivalents:
 *
 *   pr MERGED      : `  pr %s — %s (merged)`
 *   pr CLOSED      : `  pr %s — %s (closed)`
 *   pr UNREACHABLE : `  pr %s — %s (unreachable: gh pr view failed)`
 *   pr OPEN        : `  pr %s — %s [mergeable: %s, review: %s, checks: %s]`
 *                    `              checkout: gh pr checkout %s [--repo %s]`
 *   issue CLOSED   : `  issue %s — %s (closed)`
 *   issue UNREACH. : `  issue %s — %s (unreachable: gh issue view failed)`
 *   issue OPEN     : `  issue %s — %s [open]`  OR
 *                    `  issue %s — %s [open, assigned %s]`
 *   unknown kind   : `  ? %s — %s (unknown link type)`
 *
 * Note the UNCONDITIONAL ` — ` between display and title. For the unknown-kind
 * path the core sets `title: ""`, so the rendered line has the em dash
 * followed by two spaces before `(unknown link type)`. This is bash behavior
 * and Task 21 will lock it in.
 */
function renderItemLines(item: LinkedItemDerivation): string[] {
  const out: string[] = [];
  const lead = `  ${item.kind} ${item.display} — ${item.title}`;

  if (item.state === "OPEN" && item.kind === "pr") {
    const m = item.extra?.mergeStateStatus ?? "";
    const r = item.extra?.reviewDecision ?? "";
    const c = item.extra?.checksSummary ?? "";
    out.push(`${lead} [mergeable: ${m}, review: ${r}, checks: ${c}]`);
    if (item.checkoutHint !== undefined) {
      out.push(`              checkout: ${item.checkoutHint}`);
    }
    return out;
  }

  // All non-OPEN-PR branches (MERGED/CLOSED/UNREACHABLE PR, OPEN/CLOSED/
  // UNREACHABLE issue, unknown kind) share the same trailing-annotation form.
  out.push(`${lead} ${item.annotation}`);
  return out;
}
