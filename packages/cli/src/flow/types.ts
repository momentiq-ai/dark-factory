// Cycle 6 Phase 6.1 — `df flow` typed shapes.
//
// These mirror the canonical PR Flow Assessor schema authored in sage3c at
// `tools/df-flow-assessor/src/schema.ts`. Per Decision 5 / the cycle 6
// handoff, this CLI OWNS its copies (no vendored import) and keeps them in
// sync by hand. The assessor's `AssessmentArtifact` is the source of truth.
//
// The non-AssessmentArtifact shapes (CostTrackingRow, AgentTrustSummary,
// AgentTrustLedgerRow, RecurrenceEvent) are read from NDJSON / JSON files
// the assessor writes to the df-assessments git-as-database repo.

export type SchemaVersion = 1;
export type Verdict01 = number;

export interface AttributedPattern {
  pattern_id: string;
  confidence: Verdict01;
  evidence_snippets: string[];
}

export interface RootCause {
  description: string;
  links_to_components: string[];
}

export interface ImprovementAction {
  proposed_issue_title: string;
  pattern_id?: string;
  suggested_fix: string;
  validation_criterion: string;
  existing_issue_url?: string;
}

export interface CostObservation {
  tier1_haiku_input_tokens: number;
  tier1_haiku_output_tokens: number;
  tier1_haiku_cost_usd: number;
  tier2_opus_input_tokens?: number;
  tier2_opus_output_tokens?: number;
  tier2_opus_cost_usd?: number;
  total_cost_usd: number;
}

export interface AttemptSummary {
  attempt_number: number;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  status: "succeeded" | "transient_failure" | "permanent_failure";
  error_class?: string;
  error_message?: string;
}

// store/tenant/<slug>/pr/<N>.json
export interface AssessmentArtifact {
  schema_version: SchemaVersion;
  pr_number: number;
  merged_at: string;
  merged_commit_sha: string;
  base_commit_sha: string;
  cycle_id?: string;
  issue_ids?: number[];
  outcome_quality: Verdict01;
  input_quality: Verdict01;
  process_quality: Verdict01;
  iteration_count: number;
  push_count: number;
  time_to_merge_hours: number;
  regressions_introduced: number;
  admin_merge_used: boolean;
  bypass_used: boolean;
  bypass_reason_classification?: string;
  patterns_detected: AttributedPattern[];
  root_causes: RootCause[];
  improvement_actions: ImprovementAction[];
  cost_observed: CostObservation;
  critic_evidence_missing: boolean;
  degraded: boolean;
  assessment_run_id: string;
  attempts: AttemptSummary[];
  backfill?: boolean;
}

// store/tenant/<slug>/agents-trust.ndjson — one row per assessment
export interface AgentTrustLedgerRow {
  schema_version: SchemaVersion;
  pr_number: number;
  merged_at: string;
  agent_id: string;
  process_quality: Verdict01;
  outcome_quality: Verdict01;
  iteration_count: number;
  regressions_introduced: number;
  admin_merge_used: boolean;
  bypass_used: boolean;
  bypass_reason_classification?: string;
  patterns_attributed: string[];
  assessment_run_id: string;
}

// store/tenant/<slug>/agents-trust-summary.json — folded snapshot
export interface AgentTrustAgentSummary {
  n_assessments: number;
  avg_process_quality: number;
  avg_iteration_count: number;
  total_regressions_introduced: number;
  admin_merge_count: number;
  bypass_count: number;
  last_seen_at: string;
}

export interface AgentTrustSummary {
  schema_version: SchemaVersion;
  generated_at: string | null;
  rows_folded: number;
  agents: Record<string, AgentTrustAgentSummary>;
}

// store/tenant/<slug>/recurrence/<pattern-id>.ndjson — one row per observation
export interface RecurrenceEvent {
  schema_version: SchemaVersion;
  pattern_id: string;
  pr_number: number;
  observed_at: string;
  assessment_run_id: string;
}

// store/tenant/<slug>/cost-tracking.ndjson — one row per LLM call
// Tier values observed in live data: "triage" (tier1/Haiku) | "deep" (tier2/Opus).
export type CostTier = "triage" | "deep";

export interface CostTrackingRow {
  schema_version: SchemaVersion;
  timestamp: string;
  pr_number: number;
  model: string;
  tier: CostTier;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  retry_count: number;
  attempt_number: number;
  assessment_run_id: string;
  replay: boolean;
  backfill: boolean;
  degraded: boolean;
  degrade_reason?: string;
}

// ---------------------------------------------------------------------------
// Output shapes — what the CLI emits in `--json` mode. These are STABLE
// contracts: cycle 5 (MCP server) wraps each subcommand as an MCP resource,
// and the dashboard chat tools in Phase 6.5 consume the same shapes.
// Changing these requires updating downstream consumers.

export interface AgentRollupRow {
  agent_id: string;
  n_assessments: number;
  avg_process_quality: number;
  avg_outcome_quality: number;
  avg_iteration_count: number;
  total_regressions_introduced: number;
  admin_merge_count: number;
  bypass_count: number;
  most_frequent_pattern: string | null;
  last_seen_at: string;
}

export interface PatternStat {
  pattern_id: string;
  observations: number;
  distinct_prs: number;
  last_seen: string | null;
}

export interface CostDayBreakdown {
  date: string;
  total_usd: number;
  tier1_usd: number;
  tier2_usd: number;
  pr_count: number;
}

export interface CostSummary {
  total_usd: number;
  tier1_usd: number;
  tier2_usd: number;
  avg_per_pr_usd: number;
  pr_count: number;
  from?: string;
  to?: string;
  days: CostDayBreakdown[];
}

export type TrendMetric =
  | "process_quality"
  | "outcome_quality"
  | "cost"
  | "iteration_count";

export interface TrendBucket {
  week_start: string;
  value: number;
  pr_count: number;
}

export interface TrendSeries {
  metric: TrendMetric;
  buckets: TrendBucket[];
  min: number;
  max: number;
  mean: number;
  direction: "up" | "down" | "flat";
}

export type RollupQueryKind = "cycle" | "issue";

export interface RollupQuery {
  kind: RollupQueryKind;
  value: string;
}

export interface RollupAggregateScores {
  avg_outcome_quality: number;
  avg_input_quality: number;
  avg_process_quality: number;
  total_iteration_count: number;
}

export interface RollupSummary {
  query: RollupQuery;
  contributing_prs: number[];
  aggregate_scores: RollupAggregateScores | null;
  total_cost_usd: number;
  patterns_detected: string[];
}
