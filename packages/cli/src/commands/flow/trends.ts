// `df flow trends --metric <m> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--tenant <slug>] [--json]`
// Lists the pr/ directory, fetches each pr/<N>.json within the date range,
// buckets the values by ISO week (Monday-anchored, UTC), and emits a numeric
// series + an ASCII sparkline showing the most recent 7 weeks.
//
// At LA scale (sage3c, < 200 PRs, three today) the directory-listing +
// per-file fetch is well within the gh-api budget. The spec's R4 calls out
// that a 500+-PR backlog would need pre-aggregation; until then we keep the
// fetch loop straightforward and SHA-stable (each pr/<N>.json is fetched
// once per command run; no on-disk cache yet).

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
  weekStartMondayUtc,
} from "./common.js";
import { DfFlowGhError, type GhFetcher, createGhFetcher } from "./gh-api.js";
import type { AssessmentArtifact } from "./types.js";

const SUPPORTED_METRICS = [
  "process_quality",
  "outcome_quality",
  "cost",
  "iteration_count",
] as const;

export type TrendMetric = (typeof SUPPORTED_METRICS)[number];

const SPARKLINE_BUCKETS = 7;

interface TrendsOptions {
  metric: TrendMetric;
  range: DateRange;
  tenant: string;
  json: boolean;
}

export function parseTrendsArgs(
  flags: Record<string, string | boolean>,
): { opts: TrendsOptions } | { error: string } {
  const metricRaw = flags["metric"];
  if (metricRaw === undefined || metricRaw === true) {
    return {
      error: `df flow trends: --metric <${SUPPORTED_METRICS.join("|")}> is required`,
    };
  }
  if (typeof metricRaw !== "string") {
    return { error: "df flow trends: --metric requires a string value" };
  }
  if (!(SUPPORTED_METRICS as readonly string[]).includes(metricRaw)) {
    return {
      error: `df flow trends: --metric "${metricRaw}" not supported (allowed: ${SUPPORTED_METRICS.join(", ")})`,
    };
  }
  const { range, error } = parseDateRange({
    from: flags["from"],
    to: flags["to"],
  });
  if (error) return { error: `df flow trends: ${error}` };
  let tenant: string;
  try {
    tenant = resolveTenant(flags["tenant"]);
  } catch (err) {
    return { error: `df flow trends: ${(err as Error).message}` };
  }
  const json = flags["json"] === true || flags["json"] === "true";
  return { opts: { metric: metricRaw as TrendMetric, range, tenant, json } };
}

export interface TrendBucket {
  week_start: string;
  value: number;
  pr_count: number;
}

export interface TrendSummary {
  metric: TrendMetric;
  buckets: TrendBucket[];
}

export interface TrendStats {
  min: number;
  max: number;
  mean: number;
  direction: "up" | "down" | "flat" | "n/a";
}

function metricValue(art: AssessmentArtifact, metric: TrendMetric): number | null {
  switch (metric) {
    case "process_quality":
      return typeof art.process_quality === "number" ? art.process_quality : null;
    case "outcome_quality":
      return typeof art.outcome_quality === "number" ? art.outcome_quality : null;
    case "iteration_count":
      return typeof art.iteration_count === "number" ? art.iteration_count : null;
    case "cost":
      return typeof art.cost_observed?.total_cost_usd === "number"
        ? art.cost_observed.total_cost_usd
        : null;
  }
}

// Quality scores and iteration_count are averaged inside a bucket; cost is
// summed (a bucket's spend is the sum of PR spends in that week).
function isAggregateSum(metric: TrendMetric): boolean {
  return metric === "cost";
}

// Pure aggregator — input is the parsed artifacts (already date-range
// filtered) + chosen metric; output is the weekly TrendSummary with buckets
// sorted by week_start ascending. Empty input returns an empty buckets array.
export function aggregateTrends(
  artifacts: AssessmentArtifact[],
  metric: TrendMetric,
): TrendSummary {
  const byWeek = new Map<string, { sum: number; count: number }>();
  for (const a of artifacts) {
    const week = weekStartMondayUtc(a.merged_at);
    if (!week) continue;
    const v = metricValue(a, metric);
    if (v === null) continue;
    let bucket = byWeek.get(week);
    if (!bucket) {
      bucket = { sum: 0, count: 0 };
      byWeek.set(week, bucket);
    }
    bucket.sum += v;
    bucket.count += 1;
  }
  const buckets: TrendBucket[] = [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week_start, b]) => {
      const value = isAggregateSum(metric) ? b.sum : b.sum / b.count;
      return {
        week_start,
        value: round6(value),
        pr_count: b.count,
      };
    });
  return { metric, buckets };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function summarizeTrend(buckets: TrendBucket[]): TrendStats {
  if (buckets.length === 0) {
    return { min: 0, max: 0, mean: 0, direction: "n/a" };
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const b of buckets) {
    if (b.value < min) min = b.value;
    if (b.value > max) max = b.value;
    sum += b.value;
  }
  const mean = sum / buckets.length;
  let direction: TrendStats["direction"] = "flat";
  if (buckets.length >= 2) {
    const first = buckets[0]?.value ?? 0;
    const last = buckets[buckets.length - 1]?.value ?? 0;
    const span = Math.max(Math.abs(first), Math.abs(last), 1);
    const delta = last - first;
    if (Math.abs(delta) / span < 0.05) direction = "flat";
    else direction = delta > 0 ? "up" : "down";
  }
  return {
    min: round6(min),
    max: round6(max),
    mean: round6(mean),
    direction,
  };
}

// Unicode block-elements sparkline, one char per bucket. Lower values render
// shorter; constant values render mid-height. Empty input returns "(no data)".
const SPARK_CHARS = "▁▂▃▄▅▆▇█";

export function sparkline(values: number[]): string {
  if (values.length === 0) return "(no data)";
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) {
    return SPARK_CHARS[3]!.repeat(values.length);
  }
  return values
    .map((v) => {
      const idx = Math.min(
        SPARK_CHARS.length - 1,
        Math.max(0, Math.floor(((v - min) / range) * (SPARK_CHARS.length - 1))),
      );
      return SPARK_CHARS[idx]!;
    })
    .join("");
}

export function formatTrendsText(summary: TrendSummary, tenant: string): string {
  const stats = summarizeTrend(summary.buckets);
  const lines: string[] = [];
  lines.push(`Trends — tenant: ${tenant}  metric: ${summary.metric}`);
  lines.push("");
  if (summary.buckets.length === 0) {
    lines.push("  (no buckets in range — try a wider --from/--to)");
    return lines.join("\n") + "\n";
  }
  const lastN = summary.buckets.slice(-SPARKLINE_BUCKETS);
  const spark = sparkline(lastN.map((b) => b.value));
  lines.push(
    `  last ${lastN.length} week${lastN.length === 1 ? "" : "s"}:   ${spark}`,
  );
  lines.push("");
  lines.push(`  min:        ${stats.min}`);
  lines.push(`  max:        ${stats.max}`);
  lines.push(`  mean:       ${stats.mean}`);
  lines.push(`  direction:  ${stats.direction}`);
  lines.push("");
  lines.push("  per-week");
  for (const b of summary.buckets) {
    lines.push(`    ${b.week_start}   ${b.value}  (n=${b.pr_count})`);
  }
  return lines.join("\n") + "\n";
}

export async function runTrends(
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
    io.stdout(TRENDS_HELP);
    return EXIT_OK;
  }
  const { flags } = io.parseFlags(rest);
  const parsed = parseTrendsArgs(flags);
  if ("error" in parsed) {
    io.stderr(`${parsed.error}\n`);
    return EXIT_ARG_ERROR;
  }
  const fetcher = io.fetcher ?? createGhFetcher();
  const tenant = parsed.opts.tenant;
  const prDir = `${tenantBasePath(tenant)}/pr`;
  let entries: Awaited<ReturnType<typeof fetcher.fetchDir>>;
  try {
    entries = fetcher.fetchDir(prDir);
  } catch (err) {
    if (err instanceof DfFlowGhError) {
      io.stderr(`df flow trends: ${err.message}\n`);
      return EXIT_GH_ERROR;
    }
    throw err;
  }
  if (entries === null) {
    io.stderr(`df flow trends: no pr/ dir for tenant ${tenant}\n`);
    return EXIT_NOT_FOUND;
  }
  const artifacts: AssessmentArtifact[] = [];
  try {
    for (const e of entries) {
      if (e.type !== "file" || !e.name.endsWith(".json")) continue;
      const raw = fetcher.fetchFileText(`${prDir}/${e.name}`);
      if (raw === null) continue;
      let art: AssessmentArtifact;
      try {
        art = JSON.parse(raw) as AssessmentArtifact;
      } catch (parseErr) {
        // A malformed pr/<N>.json shouldn't kill the trends run — surface
        // a warning + continue. The assessor's writer guarantees well-
        // formed JSON; a parse failure here is novel and worth flagging.
        io.stderr(
          `df flow trends: skipping ${e.name}: parse error (${(parseErr as Error).message})\n`,
        );
        continue;
      }
      if (typeof art.merged_at !== "string") continue;
      if (!dateInRange(art.merged_at, parsed.opts.range)) continue;
      artifacts.push(art);
    }
  } catch (err) {
    if (err instanceof DfFlowGhError) {
      io.stderr(`df flow trends: ${err.message}\n`);
      return EXIT_GH_ERROR;
    }
    throw err;
  }
  const summary = aggregateTrends(artifacts, parsed.opts.metric);
  if (parsed.opts.json) {
    io.stdout(`${stringifyJson(summary)}\n`);
  } else {
    io.stdout(formatTrendsText(summary, tenant));
  }
  return EXIT_OK;
}

const TRENDS_HELP = [
  "df flow trends — weekly time-series for a single metric across all PRs.",
  "",
  "Usage:",
  `  df flow trends --metric <${SUPPORTED_METRICS.join("|")}> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--tenant <slug>] [--json]`,
  "",
  "Lists store/tenant/<slug>/pr/*.json, filters to PRs whose merged_at falls",
  "in the optional date range, then buckets by ISO week (Monday-anchored UTC).",
  "Quality metrics average inside a bucket; cost sums.",
  "",
  "Flags:",
  "  --metric <m>          One of: " + SUPPORTED_METRICS.join(", "),
  "  --from <YYYY-MM-DD>   Lower bound on merged_at (inclusive)",
  "  --to <YYYY-MM-DD>     Upper bound on merged_at (inclusive end-of-day)",
  "  --tenant <slug>       Tenant slug (default: sage3c)",
  "  --json                Emit the TrendSummary as JSON",
  "",
  "Exit codes:",
  "  0  success",
  "  1  argument / parse error",
  "  2  no pr/ dir for tenant",
  "  3  gh API error / rate limit / transport failure",
  "",
].join("\n");

export { SUPPORTED_METRICS };
