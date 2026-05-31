// packages/cli/src/handoff/strip-control.ts
//
// Strip control/ESC bytes from operator-editable text before printing.
// PORT FROM dark-factory-platform .claude/skills/handoff/scripts/lib.sh@a6f711b
// line 341 (strip_control_chars: `LC_ALL=C tr -d '\000-\010\013-\037\177'`).
//
// Hostile body content via gh issue view could drive the terminal via ANSI
// escapes. Defense applied to issue body reasoning + title + linked-item
// titles before printing.

/** Strip C0 control characters (0x00-0x08, 0x0B-0x1F) and DEL (0x7F).
 * Preserves TAB (0x09) and LF (0x0A). */
export function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}
