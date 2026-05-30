// `df flow rollup --cycle <id> | --issue <ref> [--tenant <slug>] [--json]`
// Lists store/tenant/<slug>/pr/*.json, fetches each, filters by either the
// PR's cycle_id (when --cycle is set) or the PR's issue_ids (when --issue is
// set), and emits aggregate scores + contributing PR list across the matches.
// Mirror of the LangChain chat tool `find_assessments_for_cycle` (Phase 11.5).
//
// Spec accepts cycle args like "333" or "cycle333"; issue args like "#38",
// "38", or "dark-factory-platform#38". We normalize all forms before
// matching. Repo prefix on issues is informational at LA (single tenant
// implies repo); we just strip it.

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
import type { AssessmentArtifact } from "./types.js";

type RollupQuery =
  | { kind: "cycle"; cycleId: string }
  | { kind: "issue"; issueNumber: number };

interface RollupOptions {
  query: RollupQuery;
  tenant: string;
  json: boolean;
}

const CYCLE_RE = /^(?:cycle)?([\w.-]+)$/i;
// Accepted issue arg forms:
//   "38"                      -> bare integer
//   "#38"                     -> issue-reference shorthand
//   "momentiq-ai/sage3c#38"   -> repo-qualified reference
// Earlier shape `^(?:[\w./-]+)?#?(\d+)$` had ambiguous greediness: the
// `\w` class includes digits, so "38" greedily consumed "3" into the
// prefix and captured "8". Splitting the prefix into two alternatives —
// "<repo>#" OR a lone "#" — pins one digit run to the capture group.
const ISSUE_RE = /^(?:[\w./-]+#|#)?(\d+)$/;

export function normalizeCycleArg(raw: string): string | null {
  const m = CYCLE_RE.exec(raw.trim());
  if (!m) return null;
  return m[1]!.toLowerCase();
}

export function normalizeIssueArg(raw: string): number | null {
  const m = ISSUE_RE.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function parseRollupArgs(
  flags: Record<string, string | boolean>,
): { opts: RollupOptions } | { error: string } {
  const cycleRaw = flags["cycle"];
  const issueRaw = flags["issue"];
  const cycleSet = cycleRaw !== undefined && cycleRaw !== false;
  const issueSet = issueRaw !== undefined && issueRaw !== false;
  if (cycleSet && issueSet) {
    return { error: "df flow rollup: --cycle and --issue are mutually exclusive" };
  }
  if (!cycleSet && !issueSet) {
    return { error: "df flow rollup: one of --cycle <id> | --issue <ref> is required" };
  }
  let query: RollupQuery;
  if (cycleSet) {
    if (typeof cycleRaw !== "string") {
      return { error: "df flow rollup: --cycle requires a value (e.g. 333 or cycle333)" };
    }
    const c = normalizeCycleArg(cycleRaw);
    if (!c) {
      return { error: `df flow rollup: --cycle "${cycleRaw}" is not a valid cycle id` };
    }
    query = { kind: "cycle", cycleId: c };
  } else {
    if (typeof issueRaw !== "string") {
      return { error: "df flow rollup: --issue requires a value (e.g. #38 or 38)" };
    }
    const n = normalizeIssueArg(issueRaw);
    if (n === null) {
      return { error: `df flow rollup: --issue "${issueRaw}" is not a valid issue reference` };
    }
    query = { kind: "issue", issueNumber: n };
  }
  let tenant: string;
  try {
    tenant = resolveTenant(flags["tenant"]);
  } catch (err) {
    return { error: `df flow rollup: ${(err as Error).message}` };
  }
  const json = flags["json"] === true || flags["json"] === "true";
  return { opts: { query, tenant, json } };
}

export interface RollupAggregateScores {
  avg_outcome_quality: number;
  avg_input_quality: number;
  avg_process_quality: number;
  avg_iteration_count: number;
}

export interface RollupSummary {
  query: { kind: "cycle"; cycle_id: string } | { kind: "issue"; issue_number: number };
  contributing_prs: number[];
  pr_count: number;
  aggregate_scores: RollupAggregateScores;
  total_cost_usd: number;
  patterns_detected: string[];
  total_iterations: number;
}

export function matchesQuery(art: AssessmentArtifact, query: RollupQuery): boolean {
  if (query.kind === "cycle") {
    const got = typeof art.cycle_id === "string" ? art.cycle_id.toLowerCase() : "";
    return got !== "" && got === query.cycleId;
  }
  if (!Array.isArray(art.issue_ids)) return false;
  return art.issue_ids.includes(query.issueNumber);
}

export function aggregateRollup(
  artifacts: AssessmentArtifact[],
  query: RollupQuery,
): RollupSummary {
  const matching = artifacts.filter((a) => matchesQuery(a, query));
  matching.sort((a, b) => a.pr_number - b.pr_number);
  const prNumbers = matching.map((a) => a.pr_number);
  const patterns = new Set<string>();
  let totalCost = 0;
  let totalIterations = 0;
  let sumOutcome = 0;
  let sumInput = 0;
  let sumProcess = 0;
  let sumIter = 0;
  for (const a of matching) {
    for (const p of a.patterns_detected ?? []) {
      if (p && typeof p.pattern_id === "string") patterns.add(p.pattern_id);
    }
    totalCost += a.cost_observed?.total_cost_usd ?? 0;
    totalIterations += a.iteration_count ?? 0;
    sumOutcome += a.outcome_quality ?? 0;
    sumInput += a.input_quality ?? 0;
    sumProcess += a.process_quality ?? 0;
    sumIter += a.iteration_count ?? 0;
  }
  const n = matching.length;
  const aggregate_scores: RollupAggregateScores = {
    avg_outcome_quality: n === 0 ? 0 : round4(sumOutcome / n),
    avg_input_quality: n === 0 ? 0 : round4(sumInput / n),
    avg_process_quality: n === 0 ? 0 : round4(sumProcess / n),
    avg_iteration_count: n === 0 ? 0 : round4(sumIter / n),
  };
  return {
    query:
      query.kind === "cycle"
        ? { kind: "cycle", cycle_id: query.cycleId }
        : { kind: "issue", issue_number: query.issueNumber },
    contributing_prs: prNumbers,
    pr_count: n,
    aggregate_scores,
    total_cost_usd: round6(totalCost),
    patterns_detected: [...patterns].sort(),
    total_iterations: totalIterations,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export function formatRollupText(summary: RollupSummary, tenant: string): string {
  const lines: string[] = [];
  const q =
    summary.query.kind === "cycle"
      ? `Cycle ${summary.query.cycle_id}`
      : `Issue #${summary.query.issue_number}`;
  lines.push(`Rollup — tenant: ${tenant}  query: ${q}`);
  lines.push("");
  if (summary.pr_count === 0) {
    lines.push("  No PR assessments matched this query.");
    return lines.join("\n") + "\n";
  }
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const usd = (n: number) => `$${n.toFixed(4)}`;
  lines.push(`  contributing PRs:           ${summary.pr_count}`);
  lines.push(`  PR numbers:                 ${summary.contributing_prs.join(", ")}`);
  lines.push("");
  lines.push("  aggregate scores (mean across contributing PRs)");
  lines.push(`    outcome_quality:           ${pct(summary.aggregate_scores.avg_outcome_quality)}`);
  lines.push(`    input_quality:             ${pct(summary.aggregate_scores.avg_input_quality)}`);
  lines.push(`    process_quality:           ${pct(summary.aggregate_scores.avg_process_quality)}`);
  lines.push(`    iteration_count:           ${summary.aggregate_scores.avg_iteration_count.toFixed(2)}`);
  lines.push("");
  lines.push(`  total spend:                ${usd(summary.total_cost_usd)}`);
  lines.push(`  total iterations:           ${summary.total_iterations}`);
  if (summary.patterns_detected.length === 0) {
    lines.push(`  patterns_detected:          (none)`);
  } else {
    lines.push(`  patterns_detected (${summary.patterns_detected.length})`);
    for (const p of summary.patterns_detected) {
      lines.push(`    - ${p}`);
    }
  }
  return lines.join("\n") + "\n";
}

export async function runRollup(
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
    io.stdout(ROLLUP_HELP);
    return EXIT_OK;
  }
  const { flags } = io.parseFlags(rest);
  const parsed = parseRollupArgs(flags);
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
      io.stderr(`df flow rollup: ${err.message}\n`);
      return EXIT_GH_ERROR;
    }
    throw err;
  }
  if (entries === null) {
    io.stderr(`df flow rollup: no pr/ dir for tenant ${tenant}\n`);
    return EXIT_NOT_FOUND;
  }
  const artifacts: AssessmentArtifact[] = [];
  try {
    for (const e of entries) {
      if (e.type !== "file" || !e.name.endsWith(".json")) continue;
      const raw = fetcher.fetchFileText(`${prDir}/${e.name}`);
      if (raw === null) continue;
      try {
        artifacts.push(JSON.parse(raw) as AssessmentArtifact);
      } catch (parseErr) {
        io.stderr(
          `df flow rollup: skipping ${e.name}: parse error (${(parseErr as Error).message})\n`,
        );
        continue;
      }
    }
  } catch (err) {
    if (err instanceof DfFlowGhError) {
      io.stderr(`df flow rollup: ${err.message}\n`);
      return EXIT_GH_ERROR;
    }
    throw err;
  }
  const summary = aggregateRollup(artifacts, parsed.opts.query);
  if (parsed.opts.json) {
    io.stdout(`${stringifyJson(summary)}\n`);
  } else {
    io.stdout(formatRollupText(summary, tenant));
  }
  return EXIT_OK;
}

const ROLLUP_HELP = [
  "df flow rollup — aggregate scores across PRs that share a Cycle or Issue.",
  "",
  "Usage:",
  "  df flow rollup --cycle <id>  [--tenant <slug>] [--json]",
  "  df flow rollup --issue <ref> [--tenant <slug>] [--json]",
  "",
  "Lists store/tenant/<slug>/pr/*.json, filters to PRs whose cycle_id (or",
  "issue_ids) matches the query, then emits aggregate scores, total spend,",
  "and the set of patterns detected across contributing PRs.",
  "",
  "Argument forms accepted:",
  "  --cycle 333   --cycle cycle333",
  "  --issue 38    --issue #38   --issue momentiq-ai/sage3c#38",
  "",
  "Flags:",
  "  --cycle <id>     Match PRs whose cycle_id == <id> (mutually exclusive with --issue)",
  "  --issue <ref>    Match PRs whose issue_ids includes <ref>",
  "  --tenant <slug>  Tenant slug (default: sage3c)",
  "  --json           Emit the RollupSummary as JSON",
  "",
  "Exit codes:",
  "  0  success (zero matches is still success)",
  "  1  argument / parse error (e.g. both --cycle and --issue set)",
  "  2  no pr/ dir for tenant",
  "  3  gh API error / rate limit / transport failure",
  "",
].join("\n");
