// df flow show --pr <N> [--tenant <slug>] [--json]
//
// Reads `store/tenant/<slug>/pr/<N>.json` and emits either a human-readable
// summary block or the full AssessmentArtifact as minified JSON.
//
// Exit codes:
//   0 success
//   1 argument / parse error
//   2 data not found (no artifact for that PR)
//   3 gh API error / rate limit

import { DEFAULT_TENANT, FetchError } from "./_lib/df-assessments-client.js";
import type { DfAssessmentsClient } from "./_lib/df-assessments-client.js";
import type { AssessmentArtifact } from "./types.js";

export interface ShowFlags {
  pr?: number;
  tenant: string;
  json: boolean;
  help: boolean;
}

export function parseShowArgs(rest: string[]): ShowFlags {
  const flags: ShowFlags = {
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
    if (a === "--pr" || a === "--tenant") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`flag ${a} requires a value`);
      }
      if (a === "--pr") {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--pr must be a positive integer, got: ${v}`);
        }
        flags.pr = n;
      } else {
        flags.tenant = v;
      }
      i++;
      continue;
    }
    throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

export function showHelp(): string {
  return [
    "df flow show — print the PR Flow Assessor artifact for one PR.",
    "",
    "Usage:",
    "  df flow show --pr <N> [--tenant <slug>] [--json]",
    "",
    "Reads store/tenant/<slug>/pr/<N>.json from momentiq-ai/df-assessments",
    "via gh api. --tenant defaults to `sage3c` (the LA pilot tenant).",
    "",
    "Exit codes:",
    "  0 success",
    "  1 argument / parse error",
    "  2 no artifact for that PR (data not found)",
    "  3 gh API error / rate limit",
    "",
  ].join("\n");
}

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(4)}`;
}

// Pure transform — input: artifact, output: text block. Unit-testable.
export function renderShowText(artifact: AssessmentArtifact): string {
  const lines: string[] = [];
  lines.push(`PR #${artifact.pr_number} — assessed by ${artifact.assessment_run_id}`);
  lines.push(`Merged at: ${artifact.merged_at}`);
  if (artifact.cycle_id !== undefined) lines.push(`Cycle: ${artifact.cycle_id}`);
  if (artifact.issue_ids !== undefined && artifact.issue_ids.length > 0) {
    lines.push(`Issues: ${artifact.issue_ids.map((n) => `#${n}`).join(", ")}`);
  }
  if (artifact.degraded) lines.push("⚠ DEGRADED ASSESSMENT");
  lines.push("");
  lines.push("Scores:");
  lines.push(`  outcome_quality:  ${pct(artifact.outcome_quality)}`);
  lines.push(`  input_quality:    ${pct(artifact.input_quality)}`);
  lines.push(`  process_quality:  ${pct(artifact.process_quality)}`);
  lines.push("");
  lines.push(
    `Flow: iterations=${artifact.iteration_count} pushes=${artifact.push_count} time_to_merge=${artifact.time_to_merge_hours.toFixed(2)}h regressions=${artifact.regressions_introduced}`,
  );
  if (artifact.admin_merge_used) lines.push("  admin_merge: TRUE");
  if (artifact.bypass_used) {
    const reason = artifact.bypass_reason_classification ?? "unclassified";
    lines.push(`  bypass: TRUE (${reason})`);
  }
  lines.push("");
  if (artifact.patterns_detected.length === 0) {
    lines.push("Patterns: none detected");
  } else {
    lines.push("Patterns detected:");
    for (const p of artifact.patterns_detected) {
      lines.push(`  - ${p.pattern_id} (confidence ${pct(p.confidence)})`);
    }
  }
  if (artifact.root_causes.length > 0) {
    lines.push("");
    lines.push("Top root cause:");
    const top = artifact.root_causes[0];
    if (top !== undefined) {
      lines.push(`  ${top.description}`);
      if (top.links_to_components.length > 0) {
        lines.push(`  components: ${top.links_to_components.join(", ")}`);
      }
    }
  }
  lines.push("");
  const cost = artifact.cost_observed;
  lines.push("Cost:");
  lines.push(
    `  tier1 (Haiku triage): ${fmtUsd(cost.tier1_haiku_cost_usd)} (${cost.tier1_haiku_input_tokens} in / ${cost.tier1_haiku_output_tokens} out)`,
  );
  if (cost.tier2_opus_cost_usd !== undefined) {
    lines.push(
      `  tier2 (Opus deep):    ${fmtUsd(cost.tier2_opus_cost_usd)} (${cost.tier2_opus_input_tokens ?? 0} in / ${cost.tier2_opus_output_tokens ?? 0} out)`,
    );
  }
  lines.push(`  total:                ${fmtUsd(cost.total_cost_usd)}`);
  lines.push("");
  return lines.join("\n");
}

export interface ShowOptions {
  client: DfAssessmentsClient;
  args: string[];
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function cmdShow(opts: ShowOptions): Promise<number> {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  let flags: ShowFlags;
  try {
    flags = parseShowArgs(opts.args);
  } catch (err) {
    stderr(`df flow show: ${(err as Error).message}\n`);
    return 1;
  }
  if (flags.help) {
    stdout(showHelp());
    return 0;
  }
  if (flags.pr === undefined) {
    stderr("df flow show: --pr <N> is required. Run `df flow show --help`.\n");
    return 1;
  }

  let artifact: AssessmentArtifact | null;
  try {
    artifact = await opts.client.getAssessment(flags.tenant, flags.pr);
  } catch (err) {
    if (err instanceof FetchError) {
      stderr(`df flow show: ${err.message}\n`);
      return 3;
    }
    stderr(`df flow show: unexpected error: ${(err as Error).message}\n`);
    return 3;
  }

  if (artifact === null) {
    stderr(
      `df flow show: no assessment artifact for tenant=${flags.tenant} pr=${flags.pr}.\n`,
    );
    return 2;
  }

  if (flags.json) {
    stdout(`${JSON.stringify(artifact)}\n`);
  } else {
    stdout(renderShowText(artifact));
  }
  return 0;
}
