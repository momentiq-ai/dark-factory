// packages/cli/src/handoff/markers.ts
//
// Marker constants + parse/splice helpers. The marker tokens are LOAD-BEARING:
// the upsert finds the existing block by them and replaces it in place,
// preserving any text outside the markers. PORT FROM dark-factory-platform
// .claude/skills/handoff/scripts/lib.sh@a6f711b lines 11-13, 153-215.

export const MARKER_OPEN = "<!-- agent-context:v1 -->";
export const MARKER_CLOSE = "<!-- /agent-context:v1 -->";

/**
 * True iff body contains an open marker on a line strictly preceding the
 * (first) close marker. Mirrors bash `validate_note_markers`:
 *   grep -nF "$MARKER_OPEN" | head -1   → open line
 *   grep -nF "$MARKER_CLOSE" | head -1  → close line
 *   open < close
 *
 * Used by /handoff against the operator's stdin note (always single block by
 * construction).
 */
export function validateNoteMarkers(body: string): boolean {
  const lines = body.split("\n");
  let openIdx = -1;
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (openIdx < 0 && lines[i]!.includes(MARKER_OPEN)) openIdx = i;
    if (closeIdx < 0 && lines[i]!.includes(MARKER_CLOSE)) closeIdx = i;
    if (openIdx >= 0 && closeIdx >= 0) break;
  }
  if (openIdx < 0 || closeIdx < 0) return false;
  return openIdx < closeIdx;
}

/**
 * True iff the LAST open marker is followed by a close marker. Mirrors bash
 * `validate_latest_block` (awk: tracks last_o + last_c; passes iff
 * last_o > 0 AND last_c > last_o).
 *
 * Used by /accept against the issue body (which may carry past blocks from
 * prior /handoff runs). Semantics must match `do_rehydrate`'s extractor
 * (last_open … last_close after last_open) so accept never closes a handoff
 * whose reasoning artifact rehydrate would fail to display.
 *
 * NOTE: scans every line (no early break) because we need the LATEST
 * occurrence, not the first.
 */
export function validateLatestBlock(body: string): boolean {
  const lines = body.split("\n");
  let lastOpen = -1;
  let lastClose = -1;
  lines.forEach((l, idx) => {
    if (l.includes(MARKER_OPEN)) lastOpen = idx;
    if (l.includes(MARKER_CLOSE)) lastClose = idx;
  });
  return lastOpen >= 0 && lastClose > lastOpen;
}

/**
 * Splice an agent-context block into an existing body. PORT FROM bash
 * `splice_agent_context_block` (awk state machine: pre / inside / post).
 *
 * If the old body contains markers, FIRST-open through LAST-close is replaced
 * by the new block (this both fixes operator-error multi-blocks and is
 * idempotent for the normal one-block case). If markers absent, the new block
 * is appended with a blank-line separator. Body text outside the markers is
 * preserved.
 *
 * The new block IS the new block in its entirety — its own markers are NOT
 * processed by the splice loop (we transition pre → inside on the first old
 * marker, emit the new block once, skip until we see a close marker, then
 * transition to post). The new block can therefore contain its own marker
 * tokens without double-splicing.
 *
 * Bash-parity contract: the marker-present branch always emits a trailing
 * `\n` (matching bash awk's `print` ORS), regardless of input. The
 * append-no-markers branch preserves the new block's trailing-newline
 * status (matching bash `cat "$newfile"` which adds nothing of its own).
 */
export function spliceAgentContextBlock(
  oldBody: string,
  newBlock: string,
): string {
  const hasOpen = oldBody.includes(MARKER_OPEN);
  const hasClose = oldBody.includes(MARKER_CLOSE);
  if (!hasOpen || !hasClose) {
    if (oldBody.length === 0) return newBlock;
    return `${oldBody}\n\n${newBlock}`;
  }
  const lines = oldBody.split("\n");
  const out: string[] = [];
  type Mode = "pre" | "inside" | "post";
  let mode: Mode = "pre";
  for (const line of lines) {
    if (mode === "pre") {
      if (line.includes(MARKER_OPEN)) {
        out.push(newBlock);
        mode = "inside";
        continue;
      }
      out.push(line);
    } else if (mode === "inside") {
      if (line.includes(MARKER_CLOSE)) {
        mode = "post";
        continue;
      }
      // skip inside-block lines (they're replaced by newBlock)
    } else {
      // mode === "post"
      if (line.includes(MARKER_OPEN)) {
        // Another stale block — drop until next close.
        mode = "inside";
        continue;
      }
      out.push(line);
    }
  }
  const result = out.join("\n");
  return result.endsWith("\n") ? result : result + "\n";
}
