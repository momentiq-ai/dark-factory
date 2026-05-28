// `df flow` namespace dispatcher — entry point wired into src/cli.ts.

import { cmdAgent } from "./agent.js";
import { cmdCost } from "./cost.js";
import { makeGhClient } from "./_lib/df-assessments-client.js";
import { cmdPatterns } from "./patterns.js";
import { cmdRollup } from "./rollup.js";
import { cmdShow } from "./show.js";
import { cmdTrends } from "./trends.js";

import type { DfAssessmentsClient } from "./_lib/df-assessments-client.js";

export const FLOW_SUBCOMMANDS = [
  "show",
  "agent",
  "patterns",
  "cost",
  "trends",
  "rollup",
] as const;

export type FlowSubcommand = (typeof FLOW_SUBCOMMANDS)[number];

export function flowHelp(): string {
  return [
    "df flow — surface the PR Flow Assessor's df-assessments store.",
    "",
    "Usage:",
    "  df flow <subcommand> [flags]",
    "",
    "Subcommands:",
    "  show <--pr N>             Print one PR's full assessment artifact",
    "  agent <agent-id>          Print the agent-trust rollup for one agent",
    "  patterns [--top N]        Rank the 10 tracked patterns by recurrence",
    "  cost [--from D --to D]    Aggregate spend, excluding replay/backfill",
    "  trends [--metric M]       Weekly time series for a chosen metric",
    "  rollup --cycle ID|--issue REF",
    "                            Aggregate scores + cost + patterns + PRs",
    "                            for a Cycle: or Issue: reference",
    "",
    "Global flags (all subcommands):",
    "  --tenant <slug>           df-assessments tenant slug (default: sage3c)",
    "  --json                    Emit minified JSON to stdout",
    "  --help                    Subcommand-specific help",
    "",
    "Exit codes (per subcommand):",
    "  0 success",
    "  1 argument / parse error",
    "  2 data not found (single-record lookups: show, agent)",
    "  3 gh API error / rate limit",
    "",
    "Auth: subcommands shell out to `gh api` against momentiq-ai/df-assessments.",
    "Run `gh auth login` once; subsequent calls inherit that token.",
    "",
    "Run `df flow <subcommand> --help` for per-subcommand flag detail.",
    "",
  ].join("\n");
}

export interface FlowDispatchOptions {
  client?: DfAssessmentsClient;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function cmdFlow(
  rest: string[],
  options: FlowDispatchOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s: string) => process.stderr.write(s));

  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    stdout(flowHelp());
    return 0;
  }

  const sub = rest[0] ?? "";
  const subRest = rest.slice(1);
  const client = options.client ?? makeGhClient();

  const dispatchOpts = {
    client,
    args: subRest,
    stdout,
    stderr,
  };

  switch (sub) {
    case "show":
      return cmdShow(dispatchOpts);
    case "agent":
      return cmdAgent(dispatchOpts);
    case "patterns":
      return cmdPatterns(dispatchOpts);
    case "cost":
      return cmdCost(dispatchOpts);
    case "trends":
      return cmdTrends(dispatchOpts);
    case "rollup":
      return cmdRollup(dispatchOpts);
    default:
      stderr(
        `df flow: unknown subcommand "${sub}". Run \`df flow --help\`.\n`,
      );
      return 1;
  }
}
