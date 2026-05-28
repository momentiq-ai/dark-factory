// df flow agent <agent-id> [--tenant <slug>] [--json]
//
// Reads agents-trust-summary.json and augments with avg_outcome_quality +
// most_frequent_pattern computed from agents-trust.ndjson. The cycle 333
// summary writer doesn't include those two fields by design; this CLI
// computes them on the read side so the spec's text output is fulfilled.
//
// Exit codes:
//   0 success
//   1 argument / parse error
//   2 unknown agent (not in summary and no ledger rows)
//   3 gh API error / rate limit

import { DEFAULT_TENANT, FetchError } from "./_lib/df-assessments-client.js";
import type { DfAssessmentsClient } from "./_lib/df-assessments-client.js";
import type {
  AgentRollupRow,
  AgentTrustAgentSummary,
  AgentTrustLedgerRow,
} from "./types.js";

export interface AgentFlags {
  agentId?: string;
  tenant: string;
  json: boolean;
  help: boolean;
}

export function parseAgentArgs(rest: string[]): AgentFlags {
  const flags: AgentFlags = {
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
    if (a === "--tenant") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`flag ${a} requires a value`);
      }
      flags.tenant = v;
      i++;
      continue;
    }
    if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    }
    // First non-flag positional is the agent id.
    if (flags.agentId === undefined) {
      flags.agentId = a;
    } else {
      throw new Error(`unexpected positional: ${a}`);
    }
  }
  return flags;
}

export function agentHelp(): string {
  return [
    "df flow agent — print the agent-trust rollup for one agent.",
    "",
    "Usage:",
    "  df flow agent <agent-id> [--tenant <slug>] [--json]",
    "",
    "Reads agents-trust-summary.json + agents-trust.ndjson from",
    "momentiq-ai/df-assessments. --tenant defaults to `sage3c`.",
    "",
    "Exit codes:",
    "  0 success",
    "  1 argument / parse error",
    "  2 unknown agent (not in summary and no ledger rows)",
    "  3 gh API error / rate limit",
    "",
  ].join("\n");
}

// Pure transform — given (optional summary row, ledger rows for this agent),
// build the rollup. Unit-testable.
export function buildAgentRollup(
  agentId: string,
  summaryRow: AgentTrustAgentSummary | null,
  ledgerRows: AgentTrustLedgerRow[],
): AgentRollupRow | null {
  if (summaryRow === null && ledgerRows.length === 0) return null;

  // Prefer summary-folded values when present (cycle 333 writes them); fall
  // back to computing from the ledger when summary is absent.
  const nAssessments = summaryRow?.n_assessments ?? ledgerRows.length;

  const avgProcessQuality =
    summaryRow?.avg_process_quality ?? mean(ledgerRows, (r) => r.process_quality);

  const avgIterationCount =
    summaryRow?.avg_iteration_count ?? mean(ledgerRows, (r) => r.iteration_count);

  const totalRegressionsIntroduced =
    summaryRow?.total_regressions_introduced ??
    ledgerRows.reduce((acc, r) => acc + r.regressions_introduced, 0);

  const adminMergeCount =
    summaryRow?.admin_merge_count ??
    ledgerRows.filter((r) => r.admin_merge_used).length;

  const bypassCount =
    summaryRow?.bypass_count ?? ledgerRows.filter((r) => r.bypass_used).length;

  const lastSeenAt =
    summaryRow?.last_seen_at ??
    ledgerRows
      .map((r) => r.merged_at)
      .reduce((a, b) => (a >= b ? a : b), "");

  // avg_outcome_quality + most_frequent_pattern — not in the summary; always
  // computed from the ledger. If the ledger is empty, the summary row's
  // n_assessments still matters but these two are unknown.
  const avgOutcomeQuality =
    ledgerRows.length === 0
      ? 0
      : mean(ledgerRows, (r) => r.outcome_quality);

  const mostFrequentPattern = computeMostFrequent(
    ledgerRows.flatMap((r) => r.patterns_attributed),
  );

  return {
    agent_id: agentId,
    n_assessments: nAssessments,
    avg_process_quality: avgProcessQuality,
    avg_outcome_quality: avgOutcomeQuality,
    avg_iteration_count: avgIterationCount,
    total_regressions_introduced: totalRegressionsIntroduced,
    admin_merge_count: adminMergeCount,
    bypass_count: bypassCount,
    most_frequent_pattern: mostFrequentPattern,
    last_seen_at: lastSeenAt,
  };
}

export function renderAgentText(row: AgentRollupRow): string {
  const lines: string[] = [];
  lines.push(`Agent: ${row.agent_id}`);
  lines.push(`  assessments:       ${row.n_assessments}`);
  lines.push(`  avg_process_q:     ${(row.avg_process_quality * 100).toFixed(0)}%`);
  lines.push(`  avg_outcome_q:     ${(row.avg_outcome_quality * 100).toFixed(0)}%`);
  lines.push(`  avg_iterations:    ${row.avg_iteration_count.toFixed(2)}`);
  lines.push(`  regressions:       ${row.total_regressions_introduced}`);
  lines.push(`  bypasses:          ${row.bypass_count}`);
  lines.push(`  admin_merges:      ${row.admin_merge_count}`);
  lines.push(
    `  most_freq_pattern: ${row.most_frequent_pattern ?? "(none)"}`,
  );
  lines.push(`  last_seen:         ${row.last_seen_at || "(unknown)"}`);
  lines.push("");
  return lines.join("\n");
}

export interface AgentOptions {
  client: DfAssessmentsClient;
  args: string[];
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function cmdAgent(opts: AgentOptions): Promise<number> {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  let flags: AgentFlags;
  try {
    flags = parseAgentArgs(opts.args);
  } catch (err) {
    stderr(`df flow agent: ${(err as Error).message}\n`);
    return 1;
  }
  if (flags.help) {
    stdout(agentHelp());
    return 0;
  }
  if (flags.agentId === undefined || flags.agentId === "") {
    stderr(
      "df flow agent: <agent-id> is required. Run `df flow agent --help`.\n",
    );
    return 1;
  }

  try {
    const summary = await opts.client.getAgentTrustSummary(flags.tenant);
    const summaryRow = summary?.agents[flags.agentId] ?? null;
    const allLedger = await opts.client.getAgentTrustLedger(flags.tenant);
    const ledgerRows = allLedger.filter((r) => r.agent_id === flags.agentId);

    const rollup = buildAgentRollup(flags.agentId, summaryRow, ledgerRows);
    if (rollup === null) {
      stderr(
        `df flow agent: no data for agent="${flags.agentId}" in tenant=${flags.tenant}.\n`,
      );
      return 2;
    }

    if (flags.json) {
      stdout(`${JSON.stringify(rollup)}\n`);
    } else {
      stdout(renderAgentText(rollup));
    }
    return 0;
  } catch (err) {
    if (err instanceof FetchError) {
      stderr(`df flow agent: ${err.message}\n`);
      return 3;
    }
    stderr(`df flow agent: unexpected error: ${(err as Error).message}\n`);
    return 3;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers.

function mean<T>(xs: T[], get: (x: T) => number): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += get(x);
  return s / xs.length;
}

function computeMostFrequent(items: string[]): string | null {
  if (items.length === 0) return null;
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  // Stable tie-break: alphabetical order. The Map preserves insertion order
  // but pattern arrival order isn't meaningful, so we sort the entries.
  const sorted = Array.from(counts.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  for (const [id, count] of sorted) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}
