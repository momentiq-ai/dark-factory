// Read-only consumer copy of the PR Flow Assessor schema. Source of truth
// lives upstream in momentiq-ai/sage3c:tools/df-flow-assessor/src/schema.ts;
// the assessor writes these shapes into momentiq-ai/df-assessments, which the
// `df flow` subcommands read via gh-api. Cycle 11 Decision 9 will own the
// canonical types at Phase 11.2 (OpenAPI 3.1 contract in
// services/aggregation/src/contract/types.ts); for Phase 11.1 the CLI keeps
// its own narrow mirror so it has no aggregation dependency.

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

export interface RecurrenceEvent {
  schema_version: SchemaVersion;
  pattern_id: string;
  pr_number: number;
  observed_at: string;
  assessment_run_id: string;
}

export interface CostTrackingRow {
  schema_version: SchemaVersion;
  timestamp: string;
  pr_number: number;
  model: string;
  tier: "triage" | "deep";
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

// gh Contents API directory entry (the shape returned when fetching a directory).
export interface ContentsListEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
}
