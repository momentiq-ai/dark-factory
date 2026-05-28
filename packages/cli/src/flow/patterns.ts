// df flow patterns [--top <N>] [--tenant <slug>] [--json]
//
// Reads store/tenant/<slug>/recurrence/<pattern-id>.ndjson for each of the
// 10 tracked patterns. Aggregates per pattern: observation count, distinct
// PR count, last_seen.
//
// Patterns with zero observations are STILL included in JSON output (so the
// downstream MCP / dashboard surfaces can render a "0 obs" baseline card)
// but ranked at the bottom of the text table. The `--top N` flag truncates
// the text output to the top N by observation count.
//
// Exit codes:
//   0 success (including when all patterns have zero observations)
//   1 argument / parse error
//   3 gh API error / rate limit

import { DEFAULT_TENANT, FetchError } from "./_lib/df-assessments-client.js";
import type { DfAssessmentsClient } from "./_lib/df-assessments-client.js";
import { TRACKED_PATTERN_IDS } from "./patterns-catalog.js";
import type { PatternStat, RecurrenceEvent } from "./types.js";

export interface PatternsFlags {
  top: number;
  tenant: string;
  json: boolean;
  help: boolean;
}

export function parsePatternsArgs(rest: string[]): PatternsFlags {
  const flags: PatternsFlags = {
    top: 10,
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
    if (a === "--top" || a === "--tenant") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`flag ${a} requires a value`);
      }
      if (a === "--top") {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(`--top must be a positive integer, got: ${v}`);
        }
        flags.top = n;
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

export function patternsHelp(): string {
  return [
    "df flow patterns — list pattern recurrence across the tracked catalog.",
    "",
    "Usage:",
    "  df flow patterns [--top <N>] [--tenant <slug>] [--json]",
    "",
    "Reads the 10 tracked recurrence ndjson files from",
    "momentiq-ai/df-assessments and aggregates per pattern. --tenant",
    "defaults to `sage3c`. --top defaults to 10.",
    "",
    "Exit codes:",
    "  0 success (including zero observations)",
    "  1 argument / parse error",
    "  3 gh API error / rate limit",
    "",
  ].join("\n");
}

// Pure transform — given per-pattern event arrays, build the ranked stats.
export function buildPatternStats(
  perPattern: ReadonlyArray<{
    pattern_id: string;
    events: RecurrenceEvent[];
  }>,
): PatternStat[] {
  const stats: PatternStat[] = perPattern.map((p) => {
    const distinct = new Set<number>();
    let lastSeen: string | null = null;
    for (const e of p.events) {
      distinct.add(e.pr_number);
      if (lastSeen === null || e.observed_at > lastSeen) {
        lastSeen = e.observed_at;
      }
    }
    return {
      pattern_id: p.pattern_id,
      observations: p.events.length,
      distinct_prs: distinct.size,
      last_seen: lastSeen,
    };
  });
  // Sort: observations DESC, then pattern_id ASC for stability.
  return stats.sort(
    (a, b) =>
      b.observations - a.observations || a.pattern_id.localeCompare(b.pattern_id),
  );
}

export function renderPatternsText(stats: PatternStat[], top: number): string {
  const head = ["Pattern".padEnd(40), "Obs", "PRs", "Last seen"].join("  ");
  const sep = "-".repeat(80);
  const rows = stats.slice(0, top).map((s) => {
    const obs = String(s.observations).padStart(3);
    const prs = String(s.distinct_prs).padStart(3);
    const last = s.last_seen ?? "(never)";
    return [s.pattern_id.padEnd(40), obs, prs, last].join("  ");
  });
  return [head, sep, ...rows, ""].join("\n");
}

export interface PatternsOptions {
  client: DfAssessmentsClient;
  args: string[];
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export async function cmdPatterns(opts: PatternsOptions): Promise<number> {
  const stdout = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s: string) => process.stderr.write(s));

  let flags: PatternsFlags;
  try {
    flags = parsePatternsArgs(opts.args);
  } catch (err) {
    stderr(`df flow patterns: ${(err as Error).message}\n`);
    return 1;
  }
  if (flags.help) {
    stdout(patternsHelp());
    return 0;
  }

  try {
    const perPattern: Array<{ pattern_id: string; events: RecurrenceEvent[] }> = [];
    for (const id of TRACKED_PATTERN_IDS) {
      const events = await opts.client.getRecurrence(flags.tenant, id);
      perPattern.push({ pattern_id: id, events });
    }
    const stats = buildPatternStats(perPattern);
    if (flags.json) {
      stdout(`${JSON.stringify(stats)}\n`);
    } else {
      stdout(renderPatternsText(stats, flags.top));
    }
    return 0;
  } catch (err) {
    if (err instanceof FetchError) {
      stderr(`df flow patterns: ${err.message}\n`);
      return 3;
    }
    stderr(`df flow patterns: unexpected error: ${(err as Error).message}\n`);
    return 3;
  }
}
