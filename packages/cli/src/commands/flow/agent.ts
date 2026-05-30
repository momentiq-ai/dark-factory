// `df flow agent <agent-id> [--tenant <slug>] [--json]`
// Reads store/tenant/<slug>/agents-trust-summary.json and extracts the row
// for <agent-id>. The summary is a single JSON file with an `agents` map
// keyed by agent_id; we don't paginate or aggregate ndjson here — that
// rollup happens upstream in the assessor's fold step.

import {
  EXIT_ARG_ERROR,
  EXIT_GH_ERROR,
  EXIT_NOT_FOUND,
  EXIT_OK,
  resolveTenant,
  stringifyJson,
  tenantBasePath,
} from "./common.js";
import { DfFlowGhError, type GhFetcher, createGhFetcher } from "./gh-api.js";
import type { AgentTrustAgentSummary, AgentTrustSummary } from "./types.js";

interface AgentOptions {
  agentId: string;
  tenant: string;
  json: boolean;
}

export function parseAgentArgs(
  positional: string[],
  flags: Record<string, string | boolean>,
): { opts: AgentOptions } | { error: string } {
  const agentId = positional[0];
  if (!agentId) {
    return {
      error: "df flow agent: <agent-id> positional argument is required",
    };
  }
  if (positional.length > 1) {
    return {
      error: `df flow agent: unexpected extra positional argument(s): ${positional.slice(1).join(", ")}`,
    };
  }
  let tenant: string;
  try {
    tenant = resolveTenant(flags["tenant"]);
  } catch (err) {
    return { error: `df flow agent: ${(err as Error).message}` };
  }
  const json = flags["json"] === true || flags["json"] === "true";
  return { opts: { agentId, tenant, json } };
}

export function formatAgentText(
  agentId: string,
  row: AgentTrustAgentSummary,
  tenant: string,
): string {
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const lines: string[] = [];
  lines.push(`Agent: ${agentId}  (tenant: ${tenant})`);
  lines.push("");
  lines.push(`  assessments seen:           ${row.n_assessments}`);
  lines.push(`  avg process_quality:        ${pct(row.avg_process_quality)}`);
  lines.push(`  avg iteration_count:        ${row.avg_iteration_count.toFixed(2)}`);
  lines.push(`  total regressions:          ${row.total_regressions_introduced}`);
  lines.push(`  admin-merge uses:           ${row.admin_merge_count}`);
  lines.push(`  bypass uses:                ${row.bypass_count}`);
  lines.push(`  last seen at:               ${row.last_seen_at}`);
  return lines.join("\n") + "\n";
}

export async function runAgent(
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
    io.stdout(AGENT_HELP);
    return EXIT_OK;
  }
  const { flags, positional } = io.parseFlags(rest);
  const parsed = parseAgentArgs(positional, flags);
  if ("error" in parsed) {
    io.stderr(`${parsed.error}\n`);
    return EXIT_ARG_ERROR;
  }
  const fetcher = io.fetcher ?? createGhFetcher();
  const path = `${tenantBasePath(parsed.opts.tenant)}/agents-trust-summary.json`;
  let raw: string | null;
  try {
    raw = fetcher.fetchFileText(path);
  } catch (err) {
    if (err instanceof DfFlowGhError) {
      io.stderr(`df flow agent: ${err.message}\n`);
      return EXIT_GH_ERROR;
    }
    throw err;
  }
  if (raw === null) {
    io.stderr(
      `df flow agent: no agents-trust-summary.json found for tenant ${parsed.opts.tenant}\n`,
    );
    return EXIT_NOT_FOUND;
  }
  let summary: AgentTrustSummary;
  try {
    summary = JSON.parse(raw) as AgentTrustSummary;
  } catch (err) {
    io.stderr(
      `df flow agent: failed to parse agents-trust-summary.json: ${(err as Error).message}\n`,
    );
    return EXIT_GH_ERROR;
  }
  const row = summary.agents?.[parsed.opts.agentId];
  if (!row) {
    io.stderr(
      `df flow agent: agent "${parsed.opts.agentId}" not present in summary (tenant: ${parsed.opts.tenant})\n`,
    );
    return EXIT_NOT_FOUND;
  }
  if (parsed.opts.json) {
    io.stdout(`${stringifyJson({ agent_id: parsed.opts.agentId, ...row })}\n`);
  } else {
    io.stdout(formatAgentText(parsed.opts.agentId, row, parsed.opts.tenant));
  }
  return EXIT_OK;
}

const AGENT_HELP = [
  "df flow agent — show the trust ledger row for a single agent.",
  "",
  "Usage:",
  "  df flow agent <agent-id> [--tenant <slug>] [--json]",
  "",
  "Reads store/tenant/<slug>/agents-trust-summary.json and extracts the row",
  "for <agent-id>. Examples of agent_id: claude-opus-4-7, codex-c,",
  "human:<github-handle>.",
  "",
  "Flags:",
  "  --tenant <slug>   Tenant slug (default: sage3c)",
  "  --json            Emit the agent row as JSON",
  "",
  "Exit codes:",
  "  0  success",
  "  1  argument / parse error",
  "  2  no summary for tenant OR agent_id not in summary",
  "  3  gh API error / rate limit / transport failure",
  "",
].join("\n");
