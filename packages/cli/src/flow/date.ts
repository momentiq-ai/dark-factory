// Date helpers for flow subcommands. ISO-8601 throughout; no timezone math
// beyond UTC. Week buckets start Monday (ISO 8601 week).

export function parseISODate(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid ISO-8601 date: ${s}`);
  }
  return d;
}

export function isoDay(d: Date): string {
  // YYYY-MM-DD in UTC
  return d.toISOString().slice(0, 10);
}

// ISO 8601 week start (Monday). Returns YYYY-MM-DD in UTC.
export function weekStart(d: Date): string {
  const u = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const day = u.getUTCDay(); // 0=Sun..6=Sat
  // Days to subtract to reach Monday: (day+6) % 7
  const offset = (day + 6) % 7;
  u.setUTCDate(u.getUTCDate() - offset);
  return isoDay(u);
}

// Inclusive-on-both-ends range filter. `from` / `to` accept YYYY-MM-DD or
// full ISO; comparison is lexicographic on the ISO prefix, which is correct
// because the file timestamps are ISO-8601.
export function withinRange(
  isoTimestamp: string,
  from: string | undefined,
  to: string | undefined,
): boolean {
  if (from !== undefined && isoTimestamp < from) return false;
  if (to !== undefined) {
    // If `to` is just YYYY-MM-DD, compare to the end of that day. Otherwise
    // use it as-is. We approximate "end of day" by appending T23:59:59Z when
    // the input is exactly 10 chars (YYYY-MM-DD).
    const upper = to.length === 10 ? `${to}T23:59:59Z` : to;
    if (isoTimestamp > upper) return false;
  }
  return true;
}
