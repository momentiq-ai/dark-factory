// packages/cli/src/handoff/iso.ts
//
// ISO-8601 normalization + epoch parsing + age formatting.
// PORT FROM dark-factory-platform .claude/skills/handoff/scripts/lib.sh@a6f711b
// lines 373-410. GitHub's REST API has returned across the platform's lifetime:
//   2026-05-30T00:00:00Z         (canonical)
//   2026-05-30T00:00:00.500Z     (fractional seconds)
//   2026-05-30T00:00:00+00:00    (numeric offset instead of Z)
//   2026-05-30T00:00:00.123-05:00  (both)
// All three normalize to `2026-05-30T00:00:00Z`. Both BSD `date -j -f` and
// GNU `date -d` are strict about format; jq fromdate accepts only the `Z`
// canonical. Strip fractional seconds; treat any numeric offset as already UTC
// (the use is day-precision recency windowing, not wall-clock math).

/** Normalize ISO-8601 variants to canonical `YYYY-MM-DDTHH:MM:SSZ`. */
export function normalizeIso(input: string): string {
  return input
    // Strip fractional seconds, preserving any timezone suffix.
    .replace(/\.[0-9]+(Z|[+-][0-9]{2}:?[0-9]{2})?$/, "$1")
    // Replace numeric offset with Z (treat as UTC for day-precision windowing).
    .replace(/[+-][0-9]{2}:?[0-9]{2}$/, "Z");
}

/** Convert an ISO-8601 timestamp to epoch seconds. Returns undefined on
 * parse failure — callers MUST NOT silently treat as 0. */
export function isoToEpoch(input: string): number | undefined {
  if (!input) return undefined;
  const norm = normalizeIso(input);
  if (!norm) return undefined;
  const t = Date.parse(norm);
  if (Number.isNaN(t)) return undefined;
  return Math.floor(t / 1000);
}

/** Format an epoch-second delta as a coarse relative age string.
 * Mirrors bash format_age (lib.sh:373-382). */
export function formatAge(epoch: number, nowEpoch: number): string {
  const diff = nowEpoch - epoch;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
