// `df flow cost [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--tenant <slug>] [--json]`
// Reads store/tenant/<slug>/cost-tracking.ndjson, filters replay/backfill rows
// (Cycle 11 Decision 4 — operational spend only), applies the optional date
// range against each row's own `timestamp` (the assessment timestamp; cleaner
// than joining each row to pr/N.json's merged_at for the operational "what
// did we spend this week" framing operators want from the cost view), and
// emits the total + Haiku/Opus tier split + per-day breakdown.

import {
  EXIT_ARG_ERROR,
  EXIT_GH_ERROR,
  EXIT_NOT_FOUND,
  EXIT_OK,
  parseDateRange,
  resolveTenant,
  stringifyJson,
  tenantBasePath,
  type DateRange,
  dateInRange,
} from "./common.js";
import { DfFlowGhError, type GhFetcher, createGhFetcher, parseNdjson } from "./gh-api.js";
import type { CostTrackingRow } from "./types.js";

interface CostOptions {
  range: DateRange;
  tenant: string;
  json: boolean;
}

export function parseCostArgs(
  flags: Record<string, string | boolean>,
): { opts: CostOptions } | { error: string } {
  // Pass the raw flag values through so parseDateRange can attribute a bare
  // `--from` (boolean true) as an arg error instead of silently dropping it.
  const { range, error } = parseDateRange({
    from: flags["from"],
    to: flags["to"],
  });
  if (error) return { error: `df flow cost: ${error}` };
  let tenant: string;
  try {
    tenant = resolveTenant(flags["tenant"]);
  } catch (err) {
    return { error: `df flow cost: ${(err as Error).message}` };
  }
  const json = flags["json"] === true || flags["json"] === "true";
  return { opts: { range, tenant, json } };
}

export interface CostDayBreakdown {
  date: string;
  total_usd: number;
  tier1_usd: number;
  tier2_usd: number;
  pr_count: number;
}

export interface CostSummary {
  total_usd: number;
  tier1_usd: number;
  tier2_usd: number;
  pr_count: number;
  avg_per_pr_usd: number;
  days: CostDayBreakdown[];
}

function dayKey(iso: string): string {
  // Truncate ISO timestamp to YYYY-MM-DD (UTC) for day bucketing. The slice
  // is safe — the assessor always writes timezone-suffixed timestamps, and
  // any malformed row is filtered out by the date-range guard upstream.
  return iso.slice(0, 10);
}

// Pure aggregator — input is raw cost-tracking rows + date range; output is
// the rendered CostSummary. Replay/backfill filtering and degraded handling
// happen here so tests pin both behaviors.
export function aggregateCost(
  rows: CostTrackingRow[],
  range: DateRange,
): CostSummary {
  const operational = rows.filter((r) => r.replay === false && r.backfill === false);
  const inRange = range.from || range.to
    ? operational.filter((r) => dateInRange(r.timestamp, range))
    : operational;
  const byDay = new Map<string, { tier1: number; tier2: number; prs: Set<number> }>();
  let total = 0;
  let tier1 = 0;
  let tier2 = 0;
  const allPrs = new Set<number>();
  for (const r of inRange) {
    total += r.cost_usd;
    if (r.tier === "triage") tier1 += r.cost_usd;
    else tier2 += r.cost_usd;
    allPrs.add(r.pr_number);
    const key = dayKey(r.timestamp);
    let day = byDay.get(key);
    if (!day) {
      day = { tier1: 0, tier2: 0, prs: new Set<number>() };
      byDay.set(key, day);
    }
    if (r.tier === "triage") day.tier1 += r.cost_usd;
    else day.tier2 += r.cost_usd;
    day.prs.add(r.pr_number);
  }
  const days: CostDayBreakdown[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      total_usd: roundUsd(v.tier1 + v.tier2),
      tier1_usd: roundUsd(v.tier1),
      tier2_usd: roundUsd(v.tier2),
      pr_count: v.prs.size,
    }));
  const prCount = allPrs.size;
  return {
    total_usd: roundUsd(total),
    tier1_usd: roundUsd(tier1),
    tier2_usd: roundUsd(tier2),
    pr_count: prCount,
    avg_per_pr_usd: prCount === 0 ? 0 : roundUsd(total / prCount),
    days,
  };
}

// Round to 6 decimal places (sub-cent precision) — matches the assessor's
// own precision on cost_usd. We round AFTER summation so the per-day rows +
// total reconcile to within 1 unit at the last decimal place.
function roundUsd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function formatCostText(summary: CostSummary, tenant: string, range: DateRange): string {
  const usd = (n: number) => `$${n.toFixed(4)}`;
  const lines: string[] = [];
  const rangeLabel = describeRange(range);
  lines.push(`Cost — tenant: ${tenant}  (${rangeLabel})`);
  lines.push("");
  lines.push(`  total:           ${usd(summary.total_usd)}`);
  lines.push(`  tier1 (Haiku):   ${usd(summary.tier1_usd)}`);
  lines.push(`  tier2 (Opus):    ${usd(summary.tier2_usd)}`);
  lines.push(`  PRs costed:      ${summary.pr_count}`);
  lines.push(`  avg / PR:        ${usd(summary.avg_per_pr_usd)}`);
  if (summary.days.length === 0) {
    lines.push("");
    lines.push("  (no operational rows in range — replay/backfill are always excluded)");
  } else {
    lines.push("");
    lines.push("  daily breakdown");
    lines.push("  date         total       tier1 (Hai)   tier2 (Opus)   prs");
    lines.push("  ----------   --------    -----------   ------------   ---");
    for (const d of summary.days) {
      lines.push(
        `  ${d.date}   ${usd(d.total_usd).padStart(8, " ")}    ${usd(d.tier1_usd).padStart(11, " ")}   ${usd(d.tier2_usd).padStart(12, " ")}   ${d.pr_count.toString().padStart(3, " ")}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

function describeRange(range: DateRange): string {
  if (!range.from && !range.to) return "all time";
  const from = range.from ? toYmd(range.from) : "−∞";
  const to = range.to ? toYmd(range.to) : "now";
  return `${from} → ${to}`;
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function runCost(
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
    io.stdout(COST_HELP);
    return EXIT_OK;
  }
  const { flags } = io.parseFlags(rest);
  const parsed = parseCostArgs(flags);
  if ("error" in parsed) {
    io.stderr(`${parsed.error}\n`);
    return EXIT_ARG_ERROR;
  }
  const fetcher = io.fetcher ?? createGhFetcher();
  const path = `${tenantBasePath(parsed.opts.tenant)}/cost-tracking.ndjson`;
  let raw: string | null;
  try {
    raw = fetcher.fetchFileText(path);
  } catch (err) {
    if (err instanceof DfFlowGhError) {
      io.stderr(`df flow cost: ${err.message}\n`);
      return EXIT_GH_ERROR;
    }
    throw err;
  }
  if (raw === null) {
    io.stderr(
      `df flow cost: no cost-tracking.ndjson for tenant ${parsed.opts.tenant}\n`,
    );
    return EXIT_NOT_FOUND;
  }
  let rows: CostTrackingRow[];
  try {
    rows = parseNdjson<CostTrackingRow>(raw, "cost-tracking.ndjson");
  } catch (err) {
    io.stderr(`df flow cost: ${(err as Error).message}\n`);
    return EXIT_GH_ERROR;
  }
  const summary = aggregateCost(rows, parsed.opts.range);
  if (parsed.opts.json) {
    io.stdout(`${stringifyJson(summary)}\n`);
  } else {
    io.stdout(formatCostText(summary, parsed.opts.tenant, parsed.opts.range));
  }
  return EXIT_OK;
}

const COST_HELP = [
  "df flow cost — operational LLM spend for the assessor.",
  "",
  "Usage:",
  "  df flow cost [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--tenant <slug>] [--json]",
  "",
  "Reads store/tenant/<slug>/cost-tracking.ndjson and aggregates total spend,",
  "tier1 (Haiku triage) vs tier2 (Opus deep) split, and daily breakdown.",
  "",
  "Filters: replay=true and backfill=true rows are ALWAYS excluded (Cycle 11",
  "Decision 4 — operational spend only). degraded=true rows are kept; they",
  "represent real billed usage on a degraded run.",
  "",
  "Flags:",
  "  --from <YYYY-MM-DD>   Lower bound (inclusive UTC midnight)",
  "  --to <YYYY-MM-DD>     Upper bound (inclusive UTC end-of-day)",
  "  --tenant <slug>       Tenant slug (default: sage3c)",
  "  --json                Emit the CostSummary as JSON",
  "",
  "Exit codes:",
  "  0  success",
  "  1  argument / parse error",
  "  2  no cost-tracking.ndjson for tenant",
  "  3  gh API error / rate limit / transport failure",
  "",
].join("\n");
