// df flow cost [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--tenant <slug>] [--json]
//
// Reads store/tenant/<slug>/cost-tracking.ndjson, filters
// replay===false && backfill===false (per Decision 4 — replay/backfill are
// engineering overhead, not operational spend), then aggregates the surviving
// rows into a total + tier split + daily breakdown.
//
// Tier mapping (from real assessor output):
//   tier === "triage" → tier1 (Haiku)
//   tier === "deep"   → tier2 (Opus)
// Unknown tier values fall into neither and are still counted in `total_usd`.
//
// Exit codes:
//   0 success (including when no rows survive the filter)
//   1 argument / parse error
//   3 gh API error / rate limit

import { withinRange } from "./date.js";
import { DEFAULT_TENANT, FetchError } from "./_lib/df-assessments-client.js";
import type { DfAssessmentsClient } from "./_lib/df-assessments-client.js";
import type {
  CostDayBreakdown,
  CostSummary,
  CostTrackingRow,
} from "./types.js";

export interface CostFlags {
  from?: string;
  to?: string;
  tenant: string;
  json: boolean;
  help: boolean;
}

export function parseCostArgs(rest: string[]): CostFlags {
  const flags: CostFlags = {
    tenant: DEFAULT_TENANT,
    json: false,
    help: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--help" || a === "-h") {
      flags.help = true;
      continue;
    }
    if (a === "--json") {
      flags.json = true;
      continue;
    }
    if (a === "--from" || a === "--to" || a === "--tenant") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`flag ${a} requires a value`);
      }
      if (a === "--from") flags.from = v;
      else if (a === "--to") flags.to = v;
      else flags.tenant = v;
      i++;
      continue;
    }
    throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

export function costHelp(): string {
  return [
    "df flow cost — aggregate per-PR LLM spend from the assessor's cost log.",
    "",
    "Usage:",
    "  df flow cost [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--tenant <slug>] [--json]",
    "",
    "Excludes replay/backfill rows per Decision 4. Tier split: triage→tier1",
    "(Haiku), deep→tier2 (Opus). --tenant defaults to `sage3c`.",
    "",
    "Exit codes:",
    "  0 success (including empty result)",
    "  1 argument / parse error",
    "  3 gh API error / rate limit",
    "",
  ].join("\n");
}

// Pure transform.
export function buildCostSummary(
  rows: CostTrackingRow[],
  from: string | undefined,
  to: string | undefined,
): CostSummary {
  const survivors = rows.filter(
    (r) =>
      r.replay === false &&
      r.backfill === false &&
      withinRange(r.timestamp, from, to),
  );

  const totalUsd = sum(survivors, (r) => r.cost_usd);
  const tier1Usd = sum(
    survivors.filter((r) => r.tier === "triage"),
    (r) => r.cost_usd,
  );
  const tier2Usd = sum(
    survivors.filter((r) => r.tier === "deep"),
    (r) => r.cost_usd,
  );

  const distinctPrs = new Set(survivors.map((r) => r.pr_number));
  const prCount = distinctPrs.size;
  const avgPerPrUsd = prCount === 0 ? 0 : totalUsd / prCount;

  // Per-day breakdown: bucket by YYYY-MM-DD prefix of the timestamp. Days
  // with zero rows are not included (the live data is sparse; rendering
  // empty days adds noise without value at LA scale).
  const byDay = new Map<
    string,
    { total: number; tier1: number; tier2: number; prs: Set<number> }
  >();
  for (const r of survivors) {
    const day = r.timestamp.slice(0, 10);
    let bucket = byDay.get(day);
    if (bucket === undefined) {
      bucket = { total: 0, tier1: 0, tier2: 0, prs: new Set<number>() };
      byDay.set(day, bucket);
    }
    bucket.total += r.cost_usd;
    if (r.tier === "triage") bucket.tier1 += r.cost_usd;
    if (r.tier === "deep") bucket.tier2 += r.cost_usd;
    bucket.prs.add(r.pr_number);
  }
  const days: CostDayBreakdown[] = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, b]) => ({
      date,
      total_usd: b.total,
      tier1_usd: b.tier1,
      tier2_usd: b.tier2,
      pr_count: b.prs.size,
    }));

  return {
    total_usd: totalUsd,
    tier1_usd: tier1Usd,
    tier2_usd: tier2Usd,
    avg_per_pr_usd: avgPerPrUsd,
    pr_count: prCount,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    days,
  };
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

export function renderCostText(summary: CostSummary): string {
  const lines: string[] = [];
  const range =
    summary.from !== undefined || summary.to !== undefined
      ? ` (${summary.from ?? "earliest"} to ${summary.to ?? "now"})`
      : "";
  lines.push(`Cost summary${range}`);
  lines.push(`  total:        ${fmtUsd(summary.total_usd)}`);
  lines.push(`  tier1 (Haiku triage): ${fmtUsd(summary.tier1_usd)}`);
  lines.push(`  tier2 (Opus deep):    ${fmtUsd(summary.tier2_usd)}`);
  lines.push(`  PR count:     ${summary.pr_count}`);
  lines.push(`  avg per PR:   ${fmtUsd(summary.avg_per_pr_usd)}`);
  lines.push("");
  if (summary.days.length === 0) {
    lines.push("Daily: (no rows in range)");
  } else {
    lines.push(
      ["Date".padEnd(12), "Total", "Tier1", "Tier2", "PRs"].join("  "),
    );
    lines.push("-".repeat(60));
    for (const d of summary.days) {
      lines.push(
        [
          d.date.padEnd(12),
          fmtUsd(d.total_usd).padStart(8),
          fmtUsd(d.tier1_usd).padStart(8),
          fmtUsd(d.tier2_usd).padStart(8),
          String(d.pr_count).padStart(3),
        ].join("  "),
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

export interface CostOptions {
  client: DfAssessmentsClient;
  args: string[];
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function cmdCost(opts: CostOptions): Promise<number> {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  let flags: CostFlags;
  try {
    flags = parseCostArgs(opts.args);
  } catch (err) {
    stderr(`df flow cost: ${(err as Error).message}\n`);
    return 1;
  }
  if (flags.help) {
    stdout(costHelp());
    return 0;
  }

  try {
    const rows = await opts.client.getCostTracking(flags.tenant);
    const summary = buildCostSummary(rows, flags.from, flags.to);
    if (flags.json) {
      stdout(`${JSON.stringify(summary)}\n`);
    } else {
      stdout(renderCostText(summary));
    }
    return 0;
  } catch (err) {
    if (err instanceof FetchError) {
      stderr(`df flow cost: ${err.message}\n`);
      return 3;
    }
    stderr(`df flow cost: unexpected error: ${(err as Error).message}\n`);
    return 3;
  }
}

function sum<T>(xs: T[], get: (x: T) => number): number {
  let s = 0;
  for (const x of xs) s += get(x);
  return s;
}
