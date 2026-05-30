// `df flow show --pr <N> [--tenant <slug>] [--json]`
// Reads store/tenant/<slug>/pr/<N>.json and renders either the full
// AssessmentArtifact (--json) or a human summary block (default). Per Cycle 11
// Decision 5: 404 on the artifact returns exit 2, gh-api transport failures
// return exit 3, arg parse errors return exit 1.

import {
  DEFAULT_TENANT,
  EXIT_ARG_ERROR,
  EXIT_GH_ERROR,
  EXIT_NOT_FOUND,
  EXIT_OK,
  resolveTenant,
  stringifyJson,
  tenantBasePath,
} from "./common.js";
import { DfFlowGhError, type GhFetcher, createGhFetcher } from "./gh-api.js";
import type { AssessmentArtifact } from "./types.js";

interface ShowOptions {
  pr: number;
  tenant: string;
  json: boolean;
}

export function parseShowArgs(
  flags: Record<string, string | boolean>,
): { opts: ShowOptions } | { error: string } {
  if (flags["pr"] === undefined || flags["pr"] === true) {
    return { error: "df flow show: --pr <N> is required" };
  }
  const prRaw = flags["pr"];
  if (typeof prRaw !== "string") {
    return { error: "df flow show: --pr requires a positive integer" };
  }
  const pr = Number(prRaw);
  if (!Number.isInteger(pr) || pr <= 0) {
    return {
      error: `df flow show: --pr "${prRaw}" is not a positive integer`,
    };
  }
  let tenant: string;
  try {
    tenant = resolveTenant(flags["tenant"]);
  } catch (err) {
    return { error: `df flow show: ${(err as Error).message}` };
  }
  const json = flags["json"] === true || flags["json"] === "true";
  return { opts: { pr, tenant, json } };
}

// Pure formatter exported for unit tests. Operators see this when --json is
// absent. Keep it boring: one header, one section per data axis; no colors
// (the existing `df` output is ANSI-free, matching consumer terminals that
// pipe through grep / jq).
export function formatShowText(art: AssessmentArtifact, tenant: string): string {
  const lines: string[] = [];
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const usd = (n: number) => `$${n.toFixed(4)}`;
  lines.push(`PR ${art.pr_number} — tenant: ${tenant}`);
  lines.push(`Merged: ${art.merged_at}  (commit ${art.merged_commit_sha.slice(0, 12)})`);
  if (art.degraded) lines.push("Degraded assessment: yes");
  lines.push("");
  lines.push("Scores");
  lines.push(`  outcome_quality:  ${pct(art.outcome_quality)}`);
  lines.push(`  input_quality:    ${pct(art.input_quality)}`);
  lines.push(`  process_quality:  ${pct(art.process_quality)}`);
  lines.push(
    `  iterations:       ${art.iteration_count}    pushes: ${art.push_count}    time_to_merge: ${art.time_to_merge_hours.toFixed(2)}h`,
  );
  lines.push(
    `  regressions:      ${art.regressions_introduced}    admin_merge: ${art.admin_merge_used ? "yes" : "no"}    bypass: ${art.bypass_used ? "yes" : "no"}`,
  );
  lines.push("");
  if (art.patterns_detected.length === 0) {
    lines.push("Patterns: (none detected)");
  } else {
    lines.push(`Patterns (${art.patterns_detected.length})`);
    for (const p of art.patterns_detected) {
      lines.push(`  - ${p.pattern_id}  (confidence ${pct(p.confidence)})`);
    }
  }
  lines.push("");
  if (art.root_causes.length === 0) {
    lines.push("Root causes: (none)");
  } else {
    const top = art.root_causes[0];
    if (top) {
      lines.push("Top root cause");
      lines.push(`  ${top.description}`);
    }
    if (art.root_causes.length > 1) {
      lines.push(`  (+ ${art.root_causes.length - 1} more — see --json for full list)`);
    }
  }
  lines.push("");
  lines.push("Cost summary");
  const co = art.cost_observed;
  const t1 = co.tier1_haiku_cost_usd;
  const t2 = co.tier2_opus_cost_usd ?? 0;
  lines.push(
    `  tier1 (Haiku triage):  ${usd(t1)}   (in: ${co.tier1_haiku_input_tokens} tok, out: ${co.tier1_haiku_output_tokens} tok)`,
  );
  lines.push(
    `  tier2 (Opus deep):     ${usd(t2)}   (in: ${co.tier2_opus_input_tokens ?? 0} tok, out: ${co.tier2_opus_output_tokens ?? 0} tok)`,
  );
  lines.push(`  total:                 ${usd(co.total_cost_usd)}`);
  lines.push("");
  lines.push(`assessment_run_id: ${art.assessment_run_id}`);
  lines.push(`PR:                https://github.com/momentiq-ai/sage3c/pull/${art.pr_number}`);
  lines.push(
    `Source JSON:       https://github.com/momentiq-ai/df-assessments/blob/main/store/tenant/${tenant}/pr/${art.pr_number}.json`,
  );
  return lines.join("\n") + "\n";
}

export async function runShow(
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
    io.stdout(SHOW_HELP);
    return EXIT_OK;
  }
  const { flags } = io.parseFlags(rest);
  const parsed = parseShowArgs(flags);
  if ("error" in parsed) {
    io.stderr(`${parsed.error}\n`);
    return EXIT_ARG_ERROR;
  }
  const fetcher = io.fetcher ?? createGhFetcher();
  const path = `${tenantBasePath(parsed.opts.tenant)}/pr/${parsed.opts.pr}.json`;
  let raw: string | null;
  try {
    raw = fetcher.fetchFileText(path);
  } catch (err) {
    if (err instanceof DfFlowGhError) {
      io.stderr(`df flow show: ${err.message}\n`);
      return EXIT_GH_ERROR;
    }
    throw err;
  }
  if (raw === null) {
    io.stderr(
      `df flow show: no assessment found for PR ${parsed.opts.pr} (tenant: ${parsed.opts.tenant})\n`,
    );
    return EXIT_NOT_FOUND;
  }
  let art: AssessmentArtifact;
  try {
    art = JSON.parse(raw) as AssessmentArtifact;
  } catch (err) {
    io.stderr(`df flow show: failed to parse PR ${parsed.opts.pr} JSON: ${(err as Error).message}\n`);
    return EXIT_GH_ERROR;
  }
  if (parsed.opts.json) {
    io.stdout(`${stringifyJson(art)}\n`);
  } else {
    io.stdout(formatShowText(art, parsed.opts.tenant));
  }
  return EXIT_OK;
}

const SHOW_HELP = [
  "df flow show — render the AssessmentArtifact for a single PR.",
  "",
  "Usage:",
  "  df flow show --pr <N> [--tenant <slug>] [--json]",
  "",
  "Reads store/tenant/<slug>/pr/<N>.json from momentiq-ai/df-assessments.",
  "",
  "Flags:",
  "  --pr <N>          PR number (required)",
  "  --tenant <slug>   Tenant slug (default: sage3c)",
  "  --json            Emit the full artifact as JSON (no text formatting)",
  "",
  "Exit codes:",
  "  0  success",
  "  1  argument / parse error",
  "  2  no assessment found for the requested PR",
  "  3  gh API error / rate limit / transport failure",
  "",
].join("\n");
