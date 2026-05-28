// df flow rollup [--cycle <id> | --issue <ref>] [--tenant <slug>] [--json]
//
// Lists pr/<N>.json under the tenant, filters by cycle_id or issue_ids
// (whichever flag was passed), and emits an aggregate: avg scores, total
// cost, union of detected patterns, contributing PR numbers.
//
// Reference normalization:
//   --cycle  "333" | "cycle333" | "Cycle333" → "333"
//   --issue  "38" | "#38" | "dark-factory-platform#38" | "momentiq-ai/sage3c#38" → 38
//
// Exit codes:
//   0 success (including empty result)
//   1 argument / parse error (incl. both flags set, or neither)
//   3 gh API error / rate limit

import { DEFAULT_TENANT, FetchError } from "./_lib/df-assessments-client.js";
import type { DfAssessmentsClient } from "./_lib/df-assessments-client.js";
import type {
  AssessmentArtifact,
  RollupQuery,
  RollupSummary,
} from "./types.js";

export interface RollupFlags {
  cycle?: string;
  issue?: string;
  tenant: string;
  json: boolean;
  help: boolean;
}

export function parseRollupArgs(rest: string[]): RollupFlags {
  const flags: RollupFlags = {
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
    if (a === "--cycle" || a === "--issue" || a === "--tenant") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`flag ${a} requires a value`);
      }
      if (a === "--cycle") flags.cycle = v;
      else if (a === "--issue") flags.issue = v;
      else flags.tenant = v;
      i++;
      continue;
    }
    throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

export function rollupHelp(): string {
  return [
    "df flow rollup — aggregate assessments across a cycle or issue.",
    "",
    "Usage:",
    "  df flow rollup --cycle <id> [--tenant <slug>] [--json]",
    "  df flow rollup --issue <ref> [--tenant <slug>] [--json]",
    "",
    "Exactly one of --cycle or --issue must be set. Reference forms accepted:",
    "  --cycle 333 | --cycle cycle333",
    "  --issue 38 | --issue #38 | --issue org/repo#38",
    "",
    "Exit codes:",
    "  0 success (including empty result)",
    "  1 argument / parse error (incl. both --cycle and --issue, or neither)",
    "  3 gh API error / rate limit",
    "",
  ].join("\n");
}

// Normalize --cycle: strip optional "cycle" prefix (case-insensitive),
// return whatever remains as the canonical id.
export function normalizeCycleRef(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("cycle")) return trimmed.slice(5);
  return trimmed;
}

// Normalize --issue: peel an optional owner/repo prefix and an optional '#'
// to a positive integer; throw on invalid input.
export function normalizeIssueRef(raw: string): number {
  const trimmed = raw.trim();
  const hashIdx = trimmed.lastIndexOf("#");
  const numeric = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : trimmed;
  const n = Number(numeric);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `--issue: cannot parse "${raw}" — expected forms: 38 | #38 | org/repo#38`,
    );
  }
  return n;
}

interface MatchFn {
  (a: AssessmentArtifact): boolean;
}

function makeMatcher(flags: RollupFlags): { match: MatchFn; query: RollupQuery } {
  if (flags.cycle !== undefined) {
    const cycleId = normalizeCycleRef(flags.cycle);
    return {
      query: { kind: "cycle", value: cycleId },
      match: (a) => a.cycle_id === cycleId,
    };
  }
  // flags.issue is set — caller guarantees one of them is.
  const issueNumber = normalizeIssueRef(flags.issue ?? "");
  return {
    query: { kind: "issue", value: String(issueNumber) },
    match: (a) =>
      a.issue_ids !== undefined && a.issue_ids.includes(issueNumber),
  };
}

// Pure transform.
export function buildRollupSummary(
  query: RollupQuery,
  matched: AssessmentArtifact[],
): RollupSummary {
  const contributingPrs = matched.map((a) => a.pr_number).sort((a, b) => a - b);
  const totalCostUsd = matched.reduce(
    (acc, a) => acc + a.cost_observed.total_cost_usd,
    0,
  );
  const patternIds = new Set<string>();
  for (const a of matched) {
    for (const p of a.patterns_detected) patternIds.add(p.pattern_id);
  }
  const patternsDetected = Array.from(patternIds).sort();

  let aggregateScores: RollupSummary["aggregate_scores"] = null;
  if (matched.length > 0) {
    const n = matched.length;
    aggregateScores = {
      avg_outcome_quality:
        matched.reduce((a, r) => a + r.outcome_quality, 0) / n,
      avg_input_quality:
        matched.reduce((a, r) => a + r.input_quality, 0) / n,
      avg_process_quality:
        matched.reduce((a, r) => a + r.process_quality, 0) / n,
      total_iteration_count: matched.reduce(
        (a, r) => a + r.iteration_count,
        0,
      ),
    };
  }

  return {
    query,
    contributing_prs: contributingPrs,
    aggregate_scores: aggregateScores,
    total_cost_usd: totalCostUsd,
    patterns_detected: patternsDetected,
  };
}

export function renderRollupText(summary: RollupSummary): string {
  const lines: string[] = [];
  const label =
    summary.query.kind === "cycle"
      ? `Cycle ${summary.query.value}`
      : `Issue #${summary.query.value}`;
  lines.push(`Rollup: ${label}`);
  lines.push(`  contributing PRs: ${summary.contributing_prs.length}`);
  if (summary.contributing_prs.length === 0) {
    lines.push("  (no assessments matched this reference)");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(
    `  PRs: ${summary.contributing_prs.map((n) => `#${n}`).join(", ")}`,
  );
  const s = summary.aggregate_scores!;
  lines.push("");
  lines.push("Aggregate scores:");
  lines.push(`  avg outcome_quality:  ${(s.avg_outcome_quality * 100).toFixed(0)}%`);
  lines.push(`  avg input_quality:    ${(s.avg_input_quality * 100).toFixed(0)}%`);
  lines.push(`  avg process_quality:  ${(s.avg_process_quality * 100).toFixed(0)}%`);
  lines.push(`  total iterations:     ${s.total_iteration_count}`);
  lines.push("");
  lines.push(`Total cost: $${summary.total_cost_usd.toFixed(4)}`);
  lines.push("");
  if (summary.patterns_detected.length === 0) {
    lines.push("Patterns: none detected");
  } else {
    lines.push("Patterns detected (union):");
    for (const p of summary.patterns_detected) lines.push(`  - ${p}`);
  }
  lines.push("");
  return lines.join("\n");
}

export interface RollupOptions {
  client: DfAssessmentsClient;
  args: string[];
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function cmdRollup(opts: RollupOptions): Promise<number> {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  let flags: RollupFlags;
  try {
    flags = parseRollupArgs(opts.args);
  } catch (err) {
    stderr(`df flow rollup: ${(err as Error).message}\n`);
    return 1;
  }
  if (flags.help) {
    stdout(rollupHelp());
    return 0;
  }
  const hasCycle = flags.cycle !== undefined;
  const hasIssue = flags.issue !== undefined;
  if (hasCycle && hasIssue) {
    stderr("df flow rollup: pass exactly one of --cycle or --issue, not both.\n");
    return 1;
  }
  if (!hasCycle && !hasIssue) {
    stderr("df flow rollup: pass exactly one of --cycle or --issue.\n");
    return 1;
  }

  let matcher: { match: MatchFn; query: RollupQuery };
  try {
    matcher = makeMatcher(flags);
  } catch (err) {
    stderr(`df flow rollup: ${(err as Error).message}\n`);
    return 1;
  }

  try {
    const numbers = await opts.client.listPrNumbers(flags.tenant);
    const matched: AssessmentArtifact[] = [];
    for (const n of numbers) {
      const a = await opts.client.getAssessment(flags.tenant, n);
      if (a === null) continue;
      if (!matcher.match(a)) continue;
      matched.push(a);
    }
    const summary = buildRollupSummary(matcher.query, matched);
    if (flags.json) {
      stdout(`${JSON.stringify(summary)}\n`);
    } else {
      stdout(renderRollupText(summary));
    }
    return 0;
  } catch (err) {
    if (err instanceof FetchError) {
      stderr(`df flow rollup: ${err.message}\n`);
      return 3;
    }
    stderr(`df flow rollup: unexpected error: ${(err as Error).message}\n`);
    return 3;
  }
}
