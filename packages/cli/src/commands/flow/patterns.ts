// `df flow patterns [--top <N>] [--tenant <slug>] [--json]`
// Reads each store/tenant/<slug>/recurrence/<pattern-id>.ndjson — one file
// per tracked pattern — and aggregates observation count, distinct PR count,
// and last-seen date. Output is a ranked table by observation count.
//
// The pattern catalog is hand-mirrored in pattern-catalog.ts (see the drift
// note there). For each pattern present in the catalog we issue a single gh-
// api fetch for its recurrence file. A 404 means "tracked but never observed"
// (rate-1 condition for a freshly-seeded tenant) and is treated as zero
// observations, not an error. Genuine transport failures still propagate.

import {
  DEFAULT_TENANT,
  EXIT_ARG_ERROR,
  EXIT_GH_ERROR,
  EXIT_OK,
  resolveTenant,
  stringifyJson,
  tenantBasePath,
} from "./common.js";
import {
  DfFlowGhError,
  type GhFetcher,
  createGhFetcher,
  parseNdjson,
} from "./gh-api.js";
import { PATTERN_CATALOG, lookupPattern } from "./pattern-catalog.js";
import type { RecurrenceEvent } from "./types.js";

interface PatternsOptions {
  top: number;
  tenant: string;
  json: boolean;
}

const DEFAULT_TOP = 10;
const MAX_TOP = 1000; // sanity bound; the pattern catalog is 10 today.

export function parsePatternsArgs(
  flags: Record<string, string | boolean>,
): { opts: PatternsOptions } | { error: string } {
  let top = DEFAULT_TOP;
  const topRaw = flags["top"];
  if (topRaw !== undefined && topRaw !== true) {
    if (typeof topRaw !== "string") {
      return { error: "df flow patterns: --top requires a positive integer" };
    }
    const n = Number(topRaw);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_TOP) {
      return {
        error: `df flow patterns: --top "${topRaw}" must be a positive integer ≤ ${MAX_TOP}`,
      };
    }
    top = n;
  }
  let tenant: string;
  try {
    tenant = resolveTenant(flags["tenant"]);
  } catch (err) {
    return { error: `df flow patterns: ${(err as Error).message}` };
  }
  const json = flags["json"] === true || flags["json"] === "true";
  return { opts: { top, tenant, json } };
}

export interface PatternRow {
  pattern_id: string;
  observations: number;
  distinct_prs: number;
  last_seen: string | null;
}

// Pure aggregation — input is the parsed event rows for one pattern; output
// is the summary row. Exported for unit tests.
export function aggregatePattern(
  patternId: string,
  events: RecurrenceEvent[],
): PatternRow {
  const prs = new Set<number>();
  let lastSeen: string | null = null;
  let lastSeenTs = -Infinity;
  for (const e of events) {
    if (typeof e.pr_number === "number") prs.add(e.pr_number);
    if (typeof e.observed_at === "string") {
      const ts = Date.parse(e.observed_at);
      if (!Number.isNaN(ts) && ts > lastSeenTs) {
        lastSeenTs = ts;
        lastSeen = e.observed_at;
      }
    }
  }
  return {
    pattern_id: patternId,
    observations: events.length,
    distinct_prs: prs.size,
    last_seen: lastSeen,
  };
}

export function rankPatterns(rows: PatternRow[], top: number): PatternRow[] {
  return [...rows]
    .sort((a, b) => {
      if (b.observations !== a.observations) return b.observations - a.observations;
      if (b.distinct_prs !== a.distinct_prs) return b.distinct_prs - a.distinct_prs;
      return a.pattern_id.localeCompare(b.pattern_id);
    })
    .slice(0, top);
}

export function formatPatternsText(rows: PatternRow[], tenant: string): string {
  if (rows.length === 0) {
    return `Patterns — tenant: ${tenant}\n  (no patterns observed)\n`;
  }
  // Compute column widths so the table renders cleanly under any pattern_id
  // length the catalog grows to.
  const idCol = Math.max(10, ...rows.map((r) => r.pattern_id.length));
  const lines: string[] = [];
  lines.push(`Patterns — tenant: ${tenant}  (top ${rows.length})`);
  lines.push("");
  lines.push(
    `  ${"pattern_id".padEnd(idCol)}  obs  prs  last_seen`,
  );
  lines.push(
    `  ${"-".repeat(idCol)}  ---  ---  --------------------`,
  );
  for (const r of rows) {
    const obs = r.observations.toString().padStart(3, " ");
    const prs = r.distinct_prs.toString().padStart(3, " ");
    const last = r.last_seen ?? "(never)";
    lines.push(`  ${r.pattern_id.padEnd(idCol)}  ${obs}  ${prs}  ${last}`);
    const catalog = lookupPattern(r.pattern_id);
    if (catalog) {
      lines.push(`  ${" ".repeat(idCol)}    ${catalog.description}`);
    }
  }
  return lines.join("\n") + "\n";
}

export async function runPatterns(
  rest: string[],
  io: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    fetcher?: GhFetcher;
    parseFlags: (
      rest: string[],
    ) => { flags: Record<string, string | boolean>; positional: string[] };
  },
): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(PATTERNS_HELP);
    return EXIT_OK;
  }
  const { flags } = io.parseFlags(rest);
  const parsed = parsePatternsArgs(flags);
  if ("error" in parsed) {
    io.stderr(`${parsed.error}\n`);
    return EXIT_ARG_ERROR;
  }
  const fetcher = io.fetcher ?? createGhFetcher();
  const tenant = parsed.opts.tenant;
  const basePath = `${tenantBasePath(tenant)}/recurrence`;
  const rows: PatternRow[] = [];
  try {
    for (const p of PATTERN_CATALOG) {
      const raw = fetcher.fetchFileText(`${basePath}/${p.id}.ndjson`);
      if (raw === null) {
        rows.push({
          pattern_id: p.id,
          observations: 0,
          distinct_prs: 0,
          last_seen: null,
        });
        continue;
      }
      const events = parseNdjson<RecurrenceEvent>(
        raw,
        `recurrence/${p.id}.ndjson`,
      );
      rows.push(aggregatePattern(p.id, events));
    }
  } catch (err) {
    if (err instanceof DfFlowGhError) {
      io.stderr(`df flow patterns: ${err.message}\n`);
      return EXIT_GH_ERROR;
    }
    io.stderr(`df flow patterns: ${(err as Error).message}\n`);
    return EXIT_GH_ERROR;
  }
  const ranked = rankPatterns(rows, parsed.opts.top);
  // We don't filter zero-observation patterns out of the JSON shape — chat
  // tools (Phase 11.5) wrap this and need to know the catalog member is
  // tracked even when count is 0. The text formatter elides them by sorting
  // them to the bottom + truncating via --top.
  if (parsed.opts.json) {
    io.stdout(`${stringifyJson(ranked)}\n`);
  } else {
    io.stdout(formatPatternsText(ranked, tenant));
  }
  return EXIT_OK;
}

const PATTERNS_HELP = [
  "df flow patterns — rank pattern recurrence across all PRs in the store.",
  "",
  "Usage:",
  "  df flow patterns [--top <N>] [--tenant <slug>] [--json]",
  "",
  "Reads store/tenant/<slug>/recurrence/<pattern-id>.ndjson for each pattern",
  "in the hand-mirrored catalog (10 patterns today) and aggregates observation",
  "count, distinct PR count, and last-seen date. Sorted descending.",
  "",
  "Flags:",
  "  --top <N>         Show only the top N patterns (default: 10)",
  "  --tenant <slug>   Tenant slug (default: sage3c)",
  "  --json            Emit the ranked rows as JSON",
  "",
  "Exit codes:",
  "  0  success (zero observations is still success)",
  "  1  argument / parse error",
  "  3  gh API error / rate limit / transport failure",
  "",
].join("\n");

export { DEFAULT_TOP };
