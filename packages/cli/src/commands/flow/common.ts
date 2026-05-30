// Cross-subcommand helpers: tenant slug resolution, date-range parsing,
// ISO-week bucketing, and the exit-code constants every subcommand routes
// through.
//
// Cycle 11 Decision 5 — exit codes:
//   0 = success
//   1 = argument / parse error (caller's fault, before any network)
//   2 = data not found (404 on the requested artifact)
//   3 = gh API error / rate limit / transport failure
// These constants are exported so subcommands all agree and tests can
// assert against them by name.

export const EXIT_OK = 0;
export const EXIT_ARG_ERROR = 1;
export const EXIT_NOT_FOUND = 2;
export const EXIT_GH_ERROR = 3;

export const DEFAULT_TENANT = "sage3c";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// We validate tenant slugs before they touch the gh path because the value
// flows into a URL segment. The regex covers the LA tenant's shape and
// rejects path-traversal attempts (slashes, dots), shell metacharacters, and
// the empty string. gh-api would also reject these, but rejecting at the
// CLI layer keeps the error message attributable.
export function resolveTenant(flagValue: unknown): string {
  if (flagValue === undefined || flagValue === true) return DEFAULT_TENANT;
  if (typeof flagValue !== "string" || flagValue.length === 0) {
    throw new Error(
      "--tenant requires a non-empty slug (lowercase letters, digits, dashes)",
    );
  }
  if (!SLUG_RE.test(flagValue)) {
    throw new Error(
      `--tenant value "${flagValue}" is not a valid slug (must match ^[a-z0-9][a-z0-9-]*$, max 63 chars)`,
    );
  }
  return flagValue;
}

export function tenantBasePath(tenant: string): string {
  return `store/tenant/${tenant}`;
}

// Date helpers. We work in UTC throughout — the assessor records ISO-8601 in
// the source data, and operators expect the same UTC-anchored buckets across
// time zones.

// Parse YYYY-MM-DD into a UTC midnight Date. Returns null on malformed input
// so callers can produce attributable arg errors.
export function parseYmd(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export interface DateRange {
  from: Date | null;
  to: Date | null;
}

export function parseDateRange(flags: {
  from?: unknown;
  to?: unknown;
}): { range: DateRange; error?: string } {
  const range: DateRange = { from: null, to: null };
  for (const which of ["from", "to"] as const) {
    const value = flags[which];
    if (value === undefined) continue;
    // parseFlags surfaces a bare `--from` (no value) as boolean `true`.
    // Treating that as "no filter" silently swallows operator intent; force
    // an attributable arg error so the caller sees what's wrong.
    if (typeof value !== "string") {
      return {
        range,
        error: `--${which} requires a YYYY-MM-DD value (got a bare flag)`,
      };
    }
    const d = parseYmd(value);
    if (!d) return { range, error: `--${which} "${value}" is not a YYYY-MM-DD date` };
    range[which] = d;
  }
  if (range.from && range.to && range.from > range.to) {
    return { range, error: "--from must be on or before --to" };
  }
  return { range };
}

// Inclusive of `from` (00:00 UTC) and exclusive of the day AFTER `to`
// (00:00 UTC), so passing --from 2026-05-01 --to 2026-05-31 covers the whole
// month inclusive. A null bound means "open".
export function dateInRange(iso: string, range: DateRange): boolean {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return false;
  if (range.from && ts < range.from.getTime()) return false;
  if (range.to) {
    const dayAfterTo = range.to.getTime() + 86_400_000;
    if (ts >= dayAfterTo) return false;
  }
  return true;
}

// ISO week bucketing. The bucket key is the YYYY-MM-DD of the Monday that
// starts the week (UTC). Operators reading the bar charts expect Monday-
// anchored buckets per the DORA conventions the rest of the dashboard uses.
export function weekStartMondayUtc(iso: string): string | null {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  // getUTCDay: 0=Sun, 1=Mon, ..., 6=Sat. Distance back to Monday:
  //   Sun -> 6, Mon -> 0, Tue -> 1, ..., Sat -> 5.
  const day = d.getUTCDay();
  const back = day === 0 ? 6 : day - 1;
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back),
  );
  return formatYmd(monday);
}

export function formatYmd(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Inserts a thin space inside the JSON for stdout readability (still
// machine-readable; matches what `gh api` produces by default and what the
// rest of the CLI emits).
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}
