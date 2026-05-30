// `df flow` subcommand namespace dispatcher.
//
// The CLI entry point in `src/cli.ts` routes `flow` to `cmdFlow` here; we own
// the help text for `df flow --help` and dispatch on `rest[0]` to the
// per-subcommand runners. Sub-help (e.g. `df flow show --help`) is owned by
// each runner.
//
// We keep cmdFlow's I/O surface lifted into an io object so tests can drive
// the runners with captured stdout/stderr + a stub fetcher. The default
// runtime uses the real gh-api fetcher.

import { EXIT_ARG_ERROR, EXIT_OK } from "./common.js";
import { runShow } from "./show.js";
import { runAgent } from "./agent.js";
import { runPatterns } from "./patterns.js";
import { runCost } from "./cost.js";
import { runTrends } from "./trends.js";
import { runRollup } from "./rollup.js";
import type { GhFetcher } from "./gh-api.js";

const FLOW_HELP = [
  "df flow — surface the PR Flow Assessor's records from momentiq-ai/df-assessments.",
  "",
  "Usage:",
  "  df flow <subcommand> [flags]",
  "",
  "Subcommands:",
  "  show       Render the AssessmentArtifact for one PR",
  "  agent      Trust-ledger row for one agent",
  "  patterns   Rank pattern recurrence across the tenant",
  "  cost       Operational LLM spend (excludes replay/backfill)",
  "  trends     Weekly time-series for one metric",
  "  rollup     Aggregate scores for a Cycle: or Issue: query",
  "",
  "Run `df flow <subcommand> --help` for per-subcommand flags + exit codes.",
  "",
  "Trust boundary:",
  "  These subcommands read momentiq-ai/df-assessments directly via gh-api.",
  "  Repo read access is the trust boundary; no installation-id RBAC is",
  "  enforced (Cycle 11 Decision 5, LA-acceptable). The aggregation service",
  "  path lands in Phase 11.2.",
  "",
  "Exit codes (uniform across subcommands):",
  "  0  success",
  "  1  argument / parse error",
  "  2  data not found (404 on the requested artifact)",
  "  3  gh API error / rate limit / transport failure",
  "",
].join("\n");

export interface FlowIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  parseFlags: (
    rest: string[],
  ) => { flags: Record<string, string | boolean>; positional: string[] };
  fetcher?: GhFetcher;
}

export async function cmdFlow(rest: string[], io: FlowIo): Promise<number> {
  // Top-level `df flow` (no subcommand) and `df flow --help` print the
  // namespace help. We deliberately do NOT print it when a subcommand is
  // present alongside --help — that case routes to the subcommand's own
  // help printer.
  if (rest.length === 0) {
    io.stdout(FLOW_HELP);
    return EXIT_OK;
  }
  const sub = rest[0]!;
  if ((sub === "--help" || sub === "-h") && rest.length === 1) {
    io.stdout(FLOW_HELP);
    return EXIT_OK;
  }
  const rs = rest.slice(1);
  switch (sub) {
    case "show":
      return runShow(rs, io);
    case "agent":
      return runAgent(rs, io);
    case "patterns":
      return runPatterns(rs, io);
    case "cost":
      return runCost(rs, io);
    case "trends":
      return runTrends(rs, io);
    case "rollup":
      return runRollup(rs, io);
    case "--help":
    case "-h":
      io.stdout(FLOW_HELP);
      return EXIT_OK;
    default:
      io.stderr(
        `df flow: unknown subcommand "${sub}". Run \`df flow --help\` for the list.\n`,
      );
      return EXIT_ARG_ERROR;
  }
}
