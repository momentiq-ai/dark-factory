// df flow trends [--metric M] [--from D --to D] [--tenant <slug>] [--json]
//
// Lists pr/<N>.json under the tenant, fetches each artifact, and buckets by
// ISO week (Monday-start) for the chosen metric. Text output is an ASCII
// sparkline + numeric summary; JSON is a TrendSeries.
//
// Supported metrics:
//   process_quality | outcome_quality | iteration_count → averaged per week
//   cost                                                → summed per week
//
// Exit codes:
//   0 success (including empty series)
//   1 argument / parse error
//   3 gh API error / rate limit

import { parseISODate, weekStart, withinRange } from "./date.js";
import { DEFAULT_TENANT, FetchError } from "./_lib/df-assessments-client.js";
import type { DfAssessmentsClient } from "./_lib/df-assessments-client.js";
import type {
  AssessmentArtifact,
  TrendBucket,
  TrendMetric,
  TrendSeries,
} from "./types.js";

const SUPPORTED_METRICS: ReadonlyArray<TrendMetric> = [
  "process_quality",
  "outcome_quality",
  "cost",
  "iteration_count",
];

export interface TrendsFlags {
  metric: TrendMetric;
  from?: string;
  to?: string;
  tenant: string;
  json: boolean;
  help: boolean;
}

export function parseTrendsArgs(rest: string[]): TrendsFlags {
  const flags: TrendsFlags = {
    metric: "process_quality",
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
    if (a === "--metric" || a === "--from" || a === "--to" || a === "--tenant") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`flag ${a} requires a value`);
      }
      if (a === "--metric") {
        if (!isSupportedMetric(v)) {
          throw new Error(
            `--metric must be one of: ${SUPPORTED_METRICS.join(", ")}; got: ${v}`,
          );
        }
        flags.metric = v;
      } else if (a === "--from") flags.from = v;
      else if (a === "--to") flags.to = v;
      else flags.tenant = v;
      i++;
      continue;
    }
    throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

function isSupportedMetric(s: string): s is TrendMetric {
  return (SUPPORTED_METRICS as readonly string[]).includes(s);
}

export function trendsHelp(): string {
  return [
    "df flow trends — weekly time series for a chosen assessor metric.",
    "",
    "Usage:",
    "  df flow trends [--metric M] [--from D --to D] [--tenant <slug>] [--json]",
    "",
    "Metrics:",
    "  process_quality | outcome_quality | iteration_count (averaged per week)",
    "  cost                                                 (summed per week)",
    "",
    "Default metric: process_quality. --tenant defaults to `sage3c`.",
    "",
    "Exit codes:",
    "  0 success (including empty series)",
    "  1 argument / parse error",
    "  3 gh API error / rate limit",
    "",
  ].join("\n");
}

function metricValue(a: AssessmentArtifact, metric: TrendMetric): number {
  if (metric === "process_quality") return a.process_quality;
  if (metric === "outcome_quality") return a.outcome_quality;
  if (metric === "iteration_count") return a.iteration_count;
  return a.cost_observed.total_cost_usd;
}

function aggregateMode(metric: TrendMetric): "mean" | "sum" {
  return metric === "cost" ? "sum" : "mean";
}

// Pure transform — given filtered artifacts + metric, build the TrendSeries.
export function buildTrendSeries(
  artifacts: AssessmentArtifact[],
  metric: TrendMetric,
): TrendSeries {
  const mode = aggregateMode(metric);
  const byWeek = new Map<string, { sum: number; n: number }>();
  for (const a of artifacts) {
    const wk = weekStart(parseISODate(a.merged_at));
    const v = metricValue(a, metric);
    let bucket = byWeek.get(wk);
    if (bucket === undefined) {
      bucket = { sum: 0, n: 0 };
      byWeek.set(wk, bucket);
    }
    bucket.sum += v;
    bucket.n += 1;
  }

  const buckets: TrendBucket[] = Array.from(byWeek.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week_start, b]) => ({
      week_start,
      value: mode === "mean" ? b.sum / b.n : b.sum,
      pr_count: b.n,
    }));

  let min = 0;
  let max = 0;
  let mean = 0;
  let direction: "up" | "down" | "flat" = "flat";
  if (buckets.length > 0) {
    const vs = buckets.map((b) => b.value);
    min = Math.min(...vs);
    max = Math.max(...vs);
    mean = vs.reduce((acc, v) => acc + v, 0) / vs.length;
    if (buckets.length >= 2) {
      const first = buckets[0]?.value ?? 0;
      const last = buckets[buckets.length - 1]?.value ?? 0;
      const eps = Math.max(1e-6, Math.abs(mean) * 0.01);
      if (last - first > eps) direction = "up";
      else if (first - last > eps) direction = "down";
    }
  }

  return { metric, buckets, min, max, mean, direction };
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export function renderSparkline(values: number[]): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) {
    // Flat line: emit the middle char for every bucket.
    return SPARK_CHARS[3]!.repeat(values.length);
  }
  const range = max - min;
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

function fmtNumeric(metric: TrendMetric, v: number): string {
  if (metric === "cost") return `$${v.toFixed(4)}`;
  if (metric === "iteration_count") return v.toFixed(2);
  return `${(v * 100).toFixed(0)}%`;
}

export function renderTrendsText(series: TrendSeries): string {
  const lines: string[] = [];
  lines.push(`Trend: ${series.metric}`);
  if (series.buckets.length === 0) {
    lines.push("  (no data)");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`  sparkline: ${renderSparkline(series.buckets.map((b) => b.value))}`);
  lines.push(`  buckets:   ${series.buckets.length} week(s)`);
  lines.push(`  min:       ${fmtNumeric(series.metric, series.min)}`);
  lines.push(`  max:       ${fmtNumeric(series.metric, series.max)}`);
  lines.push(`  mean:      ${fmtNumeric(series.metric, series.mean)}`);
  lines.push(`  direction: ${series.direction}`);
  lines.push("");
  lines.push("  Per-week:");
  for (const b of series.buckets) {
    lines.push(
      `    ${b.week_start} — ${fmtNumeric(series.metric, b.value)} (${b.pr_count} PR${b.pr_count === 1 ? "" : "s"})`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export interface TrendsOptions {
  client: DfAssessmentsClient;
  args: string[];
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function cmdTrends(opts: TrendsOptions): Promise<number> {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  let flags: TrendsFlags;
  try {
    flags = parseTrendsArgs(opts.args);
  } catch (err) {
    stderr(`df flow trends: ${(err as Error).message}\n`);
    return 1;
  }
  if (flags.help) {
    stdout(trendsHelp());
    return 0;
  }

  try {
    const numbers = await opts.client.listPrNumbers(flags.tenant);
    const artifacts: AssessmentArtifact[] = [];
    for (const n of numbers) {
      const a = await opts.client.getAssessment(flags.tenant, n);
      if (a === null) continue;
      if (!withinRange(a.merged_at, flags.from, flags.to)) continue;
      artifacts.push(a);
    }
    const series = buildTrendSeries(artifacts, flags.metric);
    if (flags.json) {
      stdout(`${JSON.stringify(series)}\n`);
    } else {
      stdout(renderTrendsText(series));
    }
    return 0;
  } catch (err) {
    if (err instanceof FetchError) {
      stderr(`df flow trends: ${err.message}\n`);
      return 3;
    }
    stderr(`df flow trends: unexpected error: ${(err as Error).message}\n`);
    return 3;
  }
}
