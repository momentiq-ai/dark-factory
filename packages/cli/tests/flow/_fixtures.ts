// Shared test fixtures for the df flow subcommand unit tests. Numbers and
// shapes match a real sage3c AssessmentArtifact (PR 2310, captured 2026-05-27)
// so the formatter tests catch regressions against a known-good record.

import type {
  AgentTrustSummary,
  AssessmentArtifact,
  CostTrackingRow,
  ContentsListEntry,
  RecurrenceEvent,
} from "../../src/commands/flow/types.js";
import type { GhFetcher } from "../../src/commands/flow/gh-api.js";

export function makeArtifact(overrides: Partial<AssessmentArtifact> = {}): AssessmentArtifact {
  return {
    schema_version: 1,
    pr_number: 2310,
    merged_at: "2026-05-27T15:05:11Z",
    merged_commit_sha: "00eb58bb1ef9eab3e94585df3ce32c104673aa61",
    base_commit_sha: "3fdf806d58292cf1df738156e53fc70124315431",
    outcome_quality: 0.88,
    input_quality: 0.84,
    process_quality: 0.52,
    iteration_count: 0,
    push_count: 9,
    time_to_merge_hours: 0.35,
    regressions_introduced: 0,
    admin_merge_used: false,
    bypass_used: false,
    patterns_detected: [
      {
        pattern_id: "agent-thrash-high-push-count",
        confidence: 0.96,
        evidence_snippets: ["push_count = 9 → thrash"],
      },
    ],
    root_causes: [
      {
        description: "Many same-day follow-up commits indicate missing up-front validation.",
        links_to_components: ["agent-review/cursor-sdk"],
      },
    ],
    improvement_actions: [
      {
        proposed_issue_title: "Pre-merge checklist for endpoint refactors",
        suggested_fix: "Require validation checklist before coding.",
        validation_criterion: "Next PR merges with ≤5 pushes.",
        pattern_id: "agent-thrash-high-push-count",
      },
    ],
    cost_observed: {
      tier1_haiku_input_tokens: 1108,
      tier1_haiku_output_tokens: 245,
      tier1_haiku_cost_usd: 0.002333,
      tier2_opus_input_tokens: 4174,
      tier2_opus_output_tokens: 887,
      tier2_opus_cost_usd: 0.043045,
      total_cost_usd: 0.045378,
    },
    critic_evidence_missing: true,
    degraded: false,
    assessment_run_id: "dark-factory-flow-assessor-2026-05-27-1505-2310",
    attempts: [
      {
        attempt_number: 1,
        started_at: "2026-05-27T18:29:44.947Z",
        ended_at: "2026-05-27T18:30:05.805Z",
        duration_ms: 20858,
        status: "succeeded",
      },
    ],
    cycle_id: "333",
    issue_ids: [38],
    ...overrides,
  };
}

export function makeCostRow(overrides: Partial<CostTrackingRow> = {}): CostTrackingRow {
  return {
    schema_version: 1,
    timestamp: "2026-05-27T18:30:05.805Z",
    pr_number: 2310,
    model: "cerebe:reasoning (opus-class)",
    tier: "deep",
    input_tokens: 5282,
    output_tokens: 1132,
    cost_usd: 0.045378,
    latency_ms: 20858,
    retry_count: 0,
    attempt_number: 1,
    assessment_run_id: "dark-factory-flow-assessor-2026-05-27-1505-2310",
    replay: false,
    backfill: false,
    degraded: false,
    ...overrides,
  };
}

export function makeRecurrence(overrides: Partial<RecurrenceEvent> = {}): RecurrenceEvent {
  return {
    schema_version: 1,
    pattern_id: "agent-thrash-high-push-count",
    pr_number: 2310,
    observed_at: "2026-05-27T18:30:05.805Z",
    assessment_run_id: "dark-factory-flow-assessor-2026-05-27-1505-2310",
    ...overrides,
  };
}

export function makeAgentSummary(
  agents: AgentTrustSummary["agents"],
): AgentTrustSummary {
  return {
    schema_version: 1,
    generated_at: "2026-05-29T00:00:00Z",
    rows_folded: Object.values(agents).reduce((sum, a) => sum + a.n_assessments, 0),
    agents,
  };
}

// A spy fetcher useful for runtime tests. Pass either canned file responses
// (path → text OR null for 404) or canned directory listings. Throws if a
// path isn't programmed (so tests fail loudly on unexpected calls).
export interface StubProgramming {
  files?: Record<string, string | null>;
  dirs?: Record<string, ContentsListEntry[] | null>;
}

export function stubFetcher(p: StubProgramming): GhFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchFileText(path: string) {
      calls.push(`file:${path}`);
      if (!p.files || !(path in p.files)) {
        throw new Error(`stubFetcher: file path "${path}" not programmed`);
      }
      return p.files[path] as string | null;
    },
    fetchDir(path: string) {
      calls.push(`dir:${path}`);
      if (!p.dirs || !(path in p.dirs)) {
        throw new Error(`stubFetcher: dir path "${path}" not programmed`);
      }
      return p.dirs[path] as ContentsListEntry[] | null;
    },
  };
}

// Mirrors parseFlags in cli.ts; copied here so tests don't have to import
// from the entrypoint (cli.ts has side-effecting top-level main() call).
export function parseFlags(rest: string[]): {
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export interface CapturedIo {
  io: {
    stdout: (s: string) => void;
    stderr: (s: string) => void;
    parseFlags: typeof parseFlags;
    fetcher?: GhFetcher;
  };
  out: () => string;
  err: () => string;
}

export function makeIo(opts: { fetcher?: GhFetcher } = {}): CapturedIo {
  const captured = { stdout: "", stderr: "" };
  const io = {
    stdout: (s: string) => {
      captured.stdout += s;
    },
    stderr: (s: string) => {
      captured.stderr += s;
    },
    parseFlags,
    ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
  };
  return {
    io,
    out: () => captured.stdout,
    err: () => captured.stderr,
  };
}
