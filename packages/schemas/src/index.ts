export type ReviewSeverity = "blocker" | "high" | "medium" | "low" | "note";
export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = [
  "blocker",
  "high",
  "medium",
  "low",
  "note",
];

export type ReviewVerdict = "APPROVED" | "CHANGES_REQUESTED";
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["APPROVED", "CHANGES_REQUESTED"];

export type CriticStatus = "pending" | "running" | "complete" | "error";
export const CRITIC_STATUSES: readonly CriticStatus[] = [
  "pending",
  "running",
  "complete",
  "error",
];

export type ArtifactStatus = "pending" | "running" | "complete" | "error";
export const ARTIFACT_STATUSES: readonly ArtifactStatus[] = [
  "pending",
  "running",
  "complete",
  "error",
];

export type ArtifactScope = "git-common-dir" | "git-dir";
export const ARTIFACT_SCOPES: readonly ArtifactScope[] = ["git-common-dir", "git-dir"];

// Cycle 332 — artifact range-shape discriminator. "commit" is the
// legacy default (parent..sha range produced by `runReview`);
// "push" is the new per-push-delta range produced by review-push.
export const REVIEW_ARTIFACT_RANGE_KINDS = ["commit", "push"] as const;

// Cycle 322.3 — `min-complete-quorum` joins as a second policy variant.
// Activation is deferred to follow-up cycle 322.3.1 (which flips
// `.agent-review/config.json` to use the new policy once the
// calibration window data justifies it); 322.3 ships the schema +
// implementation so the policy is selectable but does not switch the
// live config. See `tools/agent-review/evals/grok-calibration-2026-05.md`
// for the calibration artifact that gates 322.3.1.
//
// `min-complete-quorum` semantics (validated in `parseAgentReviewConfig`):
//   - `quorum: number` is REQUIRED, >= 2, <= critics.length
//   - If `>= quorum` critics complete, verdict is the majority vote
//     among completed critics (ties → CHANGES_REQUESTED; conservative).
//   - If any completed critic raises a blocking-severity finding OR
//     `requiresHumanJudgment`, verdict is CHANGES_REQUESTED regardless
//     of vote — preserves manifesto §11 single-critic veto.
//   - If `< quorum` critics complete (and no veto), verdict is
//     CHANGES_REQUESTED with reason `quorum_unmet` (distinct from
//     a content block so operators can route alerts differently).
export type AggregationPolicy = "block-if-any" | "min-complete-quorum";
export const AGGREGATION_POLICIES: readonly AggregationPolicy[] = [
  "block-if-any",
  "min-complete-quorum",
];

export type PostCommitMode = "async" | "foreground";
export const POST_COMMIT_MODES: readonly PostCommitMode[] = ["async", "foreground"];

export type Confidence = "low" | "medium" | "high" | "unknown";
export const CONFIDENCES: readonly Confidence[] = ["low", "medium", "high", "unknown"];

export interface ModelParam {
  id: string;
  value: string | number | boolean;
}

export interface ModelConfig {
  id: string;
  params: ModelParam[];
}

export interface CriticConfig {
  id: string;
  name: string;
  adapter: string;
  required: boolean;
  runtime: string;
  model: ModelConfig;
  // Issue #2103 — runtime auth source the adapter MUST use when
  // invoking this critic. Set by `applyProfileAuth()` (profile.ts) from
  // `profile.auth[critic.id]`; the on-disk `.agent-review/config.json`
  // never carries `auth` at the critic level. String values are
  // adapter-specific (e.g., codex-sdk recognizes "chatgpt" and "api");
  // adapters that don't honor `auth` ignore this field.
  //
  // Strict-no-fallback contract: when an adapter HONORS `auth`, it MUST
  // fail loud if the configured source is unavailable, rather than
  // silently using the other source. The whole point of this field is
  // to remove the env-presence fallback that previously routed local
  // critics to per-token API billing whenever the env var was set
  // (codex `CODEX_API_KEY` leaking into local runs via Doppler — see
  // issue #2103).
  auth?: string;
}

export interface AggregationConfig {
  policy: AggregationPolicy;
  blockingSeverities: ReviewSeverity[];
  // Cycle 322.3 — required when policy === "min-complete-quorum".
  // Validated by `parseAgentReviewConfig`: integer, >= 2, <=
  // critics.length, and must NOT be present when policy is
  // "block-if-any" (a stale `quorum` field after a policy switch
  // would be a silent foot-gun).
  quorum?: number;
}

// Cycle 322.7 — Profile envelopes that let the same config drive
// multiple aggregation postures (local pre-push vs. cloud canonical
// gate) without duplicating the critic list. The selector
// (CLI `--profile <name>` > AGENT_REVIEW_PROFILE env > "local" default)
// chooses which envelope is active at runtime; the runner then filters
// `critics[]` to `profile.criticIds` and overrides the aggregation
// quorum with `profile.quorum`.
//
// Validation rules (`parseAgentReviewConfig`):
//   - Every `criticId` MUST exist in the root `critics[]` array
//     (no dangling references).
//   - `1 <= quorum <= criticIds.length`. Note that profile quorum
//     can be 1 — that's the whole point of the local pre-push profile
//     (1-of-2 subscription-billed critics). The root
//     `aggregation.quorum` still requires `>= 2` per the 322.3 schema
//     rule; profiles loosen that constraint at runtime only.
//   - `criticIds` must be non-empty and contain no duplicates
//     (duplicates would silently double-count toward quorum).
//
// Cycle 322.8 — `modelParamOverrides` lets a profile override per-critic
// `model.params` values without duplicating the critic config. Keyed by
// criticId → paramId → value. Validation rules (see
// `parseAgentReviewConfig`):
//   - Optional. A profile without overrides parses as it did pre-322.8.
//   - Every overridden criticId MUST appear in this profile's
//     `criticIds[]` (override of an excluded critic is rejected at load
//     time — overriding a critic the profile won't even invoke is a
//     foot-gun).
//   - Every paramId is a non-empty string; every value matches
//     `ModelParam.value` (`string | number | boolean`).
//
// Runtime: `applyProfileParamOverrides` in `profile.ts` clones the
// matching critic with the override applied to `model.params` (replacing
// an existing param by id, appending if absent) BEFORE the runner passes
// the critic to the adapter. Adapters need NO code change — they read
// from the cloned critic's `model.params` through their existing surface
// (e.g., codex-sdk's `resolveCodexReasoningEffort()`).
export interface ProfileConfig {
  criticIds: string[];
  quorum: number;
  modelParamOverrides?: {
    [criticId: string]: { [paramId: string]: string | number | boolean };
  };
  // Issue #2103 — per-critic auth source pinning. Each value is a
  // non-empty string that the matching adapter interprets; the schema
  // validator only enforces shape (object of criticId → non-empty
  // string) + cross-field rules (criticId MUST be in this profile's
  // `criticIds[]`, mirroring `modelParamOverrides`). Adapter-specific
  // validation (e.g., codex-sdk accepts only "chatgpt" | "api") happens
  // inside the adapter — keeps the schema agnostic to adapter
  // vocabulary as new critic families ship.
  //
  // Runtime: `applyProfileAuth()` (profile.ts) clones the matching
  // critic with `auth` set, mirroring `applyProfileParamOverrides()`.
  auth?: {
    [criticId: string]: string;
  };
}

export interface GitConfig {
  hookPath: string;
  artifactDir: string;
  artifactScope: ArtifactScope;
}

export interface PolicyConfig {
  blockOnMissingReview: boolean;
  blockOnReviewError: boolean;
  allowEmergencyBypass: boolean;
  postCommitMode: PostCommitMode;
}

// ADR 0001 — bounded lockfile strategy (issue #67).
// Three-valued mode lets a single config drive "no compaction"
// (full), "compactor stub" (compact), or "<path> diff omitted by
// policy" marker (omit). See § 2.2 of the ADR for the full schema
// + parser rules.
export type GeneratedFileMode = "full" | "compact" | "omit";
export const GENERATED_FILE_MODES: readonly GeneratedFileMode[] = [
  "full",
  "compact",
  "omit",
];

// ADR 0001 § 2.3.4 — refuse-and-block is the security-preserving
// default: an extractor parse error populates
// `ReviewPacket.parseErrorPaths` and the prompt builder adds a
// "treat as missing evidence" marker so critics route the case
// through the existing CHANGES_REQUESTED branch. The
// "compact-with-warning" opt-out emits the parse-error stub WITHOUT
// the synthetic injection, for operators who knowingly accept the
// trade-off (dogfood ramp-up where parse errors are noisy).
export type OnParseErrorMode = "refuse-and-block" | "compact-with-warning";
export const ON_PARSE_ERROR_MODES: readonly OnParseErrorMode[] = [
  "refuse-and-block",
  "compact-with-warning",
];

export interface GeneratedFileGlobOverride {
  glob: string;
  mode: GeneratedFileMode;
}

export interface GeneratedFilePolicy {
  mode: GeneratedFileMode;
  // ADR § 2.2 schema parser rule 2: optional. When omitted, the CLI
  // substitutes DEFAULT_GENERATED_LOCKFILE_GLOBS at packet-build
  // time (the schema package itself does NOT substitute; it stays
  // dependency-free). When present, non-empty array; duplicates
  // rejected; an explicitly-empty [] is rejected.
  globs?: string[];
  overrides?: GeneratedFileGlobOverride[];
  onParseError?: OnParseErrorMode;
}

export interface ContextConfig {
  guidanceFiles: string[];
  promptFragments: string[];
  maxChangedFileBytes: number;
  includeFullChangedFiles: boolean;
  // ADR 0001 — optional. Absent → behavior identical to today
  // (no compaction, no compactedDiff, no compactedContent, no
  // parseErrorPaths). See `docs/ADR/0001-bounded-lockfile-strategy.md`.
  generatedFilePolicy?: GeneratedFilePolicy;
}

export interface VerificationRoute {
  id: string;
  trigger: string[];
  // `null` means this route's only job is suppression: when `exclusive: true`
  // and every changed path matches the trigger, non-exclusive routes are
  // dropped. The docs-only route uses this shape — see `config.json`.
  command: string | null;
  // Path template for the evidence file the route's command writes.
  // `${sha}` is substituted at evaluation time. May be `null` only when
  // `command` is also `null` (suppression routes).
  evidencePath: string | null;
  category: string;
  exclusive?: boolean;
}

export interface TddClassifierConfigSchema {
  productionGlobs: string[];
  testGlobs: string[];
  exclusionGlobs: string[];
  justificationTrailer: string;
}

export interface TddConfig {
  classifier: TddClassifierConfigSchema;
}

export interface ValidationConfig {
  runBeforeReview: boolean;
  resultFile: string;
  requiredQualityGates: string[];
  optionalQualityGates: string[];
  // Added in version 2. v1 configs default to an empty list (no
  // route-based enforcement). Each route specifies a glob pattern of
  // changed-paths that activate the route, the command that produces
  // its evidence, and the per-SHA evidence file path.
  verificationRoutes: VerificationRoute[];
}

export interface SecurityConfig {
  redactSecretsInDiagnostics: boolean;
  treatDiffAsUntrustedInput: boolean;
}

export type AgentReviewConfigVersion = 1 | 2;

export interface AgentReviewConfig {
  // v2 enables the TDD classifier, verification routes, and the
  // enforceFindingRubric stripper. v1 keeps the previous gate semantics
  // for downstream-repo compatibility during the migration window.
  version: AgentReviewConfigVersion;
  critics: CriticConfig[];
  aggregation: AggregationConfig;
  git: GitConfig;
  policy: PolicyConfig;
  context: ContextConfig;
  validation: ValidationConfig;
  security: SecurityConfig;
  // Optional in v1, required in v2. When absent (v1), the TDD classifier
  // is not invoked by gate-push.
  tdd?: TddConfig;
  secrets?: SecretsConfig;
  // Cycle 322.7 — optional named profiles for environment-tuned critic
  // sets and quorum thresholds. When absent, the runner uses the full
  // `critics[]` list and root `aggregation.quorum` (back-compat).
  // When present, the CLI selector picks one profile by name and the
  // runner filters critics + overrides quorum accordingly.
  profiles?: { [name: string]: ProfileConfig };
}

export interface SecretsConfig {
  doppler?: { project: string; config: string };
}

export interface QualityGateResult {
  command: string;
  exitCode: number;
  durationMs: number;
  logExcerpt: string;
  startedAt: string;
  finishedAt: string;
  // When the result came from a verification route, record the route id
  // so consumers can map result → route without re-parsing the command.
  // Omitted for legacy "required gates" results that aren't route-scoped.
  routeId?: string;
}

export interface QualityGateEvidence {
  // version: 1 — legacy single-file results
  // version: 2 — per-SHA file at <artifactDir>/quality-gates/<sha>.json
  //               with optional `gateResults[routeId]` map populated by
  //               verification routes (Component 2/3 of cycle 318.2).
  version: 1 | 2;
  commit: string;
  results: QualityGateResult[];
  generatedAt: string;
  // Route-id keyed results map written by verification routes. Present
  // when version === 2. Each entry's `exitCode === 0` is the deterministic
  // pass condition for the route in gate-push.
  gateResults?: Record<string, QualityGateResult>;
}

export type ChangedFileStatus = "A" | "M" | "D" | "R" | "T" | "C" | "U" | "X";

export interface ChangedFile {
  path: string;
  status: ChangedFileStatus;
  oldPath?: string;
  bytes?: number;
  content?: string;
  contentHash?: string;
  omittedReason?: "binary" | "too_large" | "missing";
  // ADR 0001 — optional. Present only for paths whose effective
  // mode (per the generatedFilePolicy resolver) is !== "full". When
  // present, the prompt's `<file>` block uses this stub instead of
  // `content`, AND `content` is cleared on the packet (so a
  // downstream consumer that JSON-stringifies the packet doesn't
  // accidentally serialize both forms). Stub is byte-capped at
  // MAX_COMPACTED_CONTENT_BYTES (defined in the CLI).
  compactedContent?: string;
}

export interface CommitMetadata {
  sha: string;
  parent: string;
  author: string;
  email: string;
  subject: string;
  body: string;
  timestamp: string;
}

export interface GuidanceFile {
  path: string;
  content: string;
}

export interface ReviewPacketValidation {
  requiredQualityGates: string[];
  optionalQualityGates: string[];
  evidence: QualityGateResult[];
  missing: string[];
  stale: boolean;
}

export interface ReviewPacket {
  repoRoot: string;
  branch: string;
  commit: CommitMetadata;
  range: string;
  diffHash: string;
  stat: string;
  diff: string;
  diffTruncated: boolean;
  changedFiles: ChangedFile[];
  guidanceFiles: GuidanceFile[];
  promptFragments: GuidanceFile[];
  validation: ReviewPacketValidation;
  // ADR 0001 — optional, present when at least one path under the
  // effective generatedFilePolicy has a non-"full" mode AND the
  // diff carries a matching per-file section. Built from the
  // UNTRUNCATED fullDiff returned by commitDiff() (ADR § 2.1.1
  // pipeline order); the post-compaction result is byte-capped at
  // MAX_COMPACTED_DIFF_BYTES then DEFAULT_DIFF_BUDGET. When present,
  // the prompt builder uses this for the `<diff>` section instead
  // of `packet.diff`.
  compactedDiff?: string;
  // ADR 0001 § 2.3.4 — present only when at least one matched
  // lockfile failed extractor parsing AND the policy mode is the
  // default "refuse-and-block". The prompt builder uses this to
  // emit a top-of-diff "[DF-COMPACT PARSE-ERROR — treat as missing
  // evidence]" marker that routes the critic through the existing
  // "missing evidence ⇒ CHANGES_REQUESTED" branch. Under
  // "compact-with-warning" the field is omitted (parse-error stub
  // still appears in compactedDiff but without the synthetic
  // injection).
  parseErrorPaths?: string[];
}

export interface ReviewFinding {
  severity: ReviewSeverity;
  category: string;
  file?: string;
  line?: number;
  symbol?: string;
  evidence: string;
  impact: string;
  requiredFix: string;
  manifestoSection?: string;
  // Added in cycle 318.2 Component 5 — the three-way rubric. A blocker/high
  // finding survives `enforceFindingRubric` if ANY of these is present:
  //   - `evidencePath` pointing to a per-SHA gate artifact whose
  //     `gateResults[routeId].exitCode !== 0` (gate-failure evidence).
  //     The `routeId` field below names which route is the source.
  //     Without `routeId`, evidencePath alone is insufficient — the
  //     critic must name the specific failing gate it is citing.
  //   - `file` + `line` + `evidence` (concrete code-review evidence;
  //     existing fields, already required for blocker severity by the
  //     schema parser)
  //   - `justification` value from a recognized commit trailer
  //     (`Tdd-Justification:`, `Evidence:`, `Migration-Justification:`,
  //     etc.) — the human-override path; the critic populates this
  //     field with the trailer value to honor a specific override for
  //     this finding.
  evidencePath?: string;
  routeId?: string;
  justification?: string;
  // Cycle 332 — optional content-hash on the cited evidence file. When a
  // critic emits a finding against `file`, the runner may stamp
  // `sha256(gitShowFile(review_sha, file))` here so downstream cache
  // writers can persist the hash without recomputing. Distinct from the
  // finding-cache record's `anchor_content_hash` (which keys the cache by
  // the pass-target file, not by the cited-evidence file). Existing
  // artifacts that predate the field parse identically.
  contentHash?: string;
  // Issue #106 — LLM self-flag: the model believes this finding cannot be
  // objectively verified from its sandbox and warrants human judgement.
  // Optional; the wire-level distinction between omitted (`undefined`)
  // and explicit `false` is load-bearing so consumers can tell "the
  // critic didn't report" from "the critic reported false". Adapters
  // copy this through from the model's structured output; they do NOT
  // derive it heuristically. Aggregation is unchanged — this is a
  // presentation/routing hint for consumers; the gate decision is
  // unchanged at the CLI layer (mirrors the result-level
  // `CriticResult.requiresHumanJudgment` semantic but at per-finding
  // granularity).
  requiresHumanJudgment?: boolean;
}

export interface CriticReviewerInfo {
  name: string;
  adapter: string;
  model: ModelConfig;
  runtime: string;
  agentId?: string;
  runId?: string;
}

export interface CriticValidationView {
  qualityGateResults: QualityGateResult[];
  qualityGatesMissing: string[];
}

export interface CriticError {
  message: string;
  retryable?: boolean;
  rawSamplePath?: string;
  // Cycle 322.1 — SDK-supplied structured error code. Captured from the
  // terminal RunResult (Cursor SDK shape: `errorCode | error_code | code
  // | error.code`). Operators grep `_runs.ndjson` for
  // `errorCode=capacity_exceeded` to confirm a vendor outage hypothesis.
  code?: string;
  // Cycle 322.1 — How many retry attempts preceded this final outcome.
  // 0 = first-attempt result (no retries used).
  // RETRY_BACKOFF_MS.length is the ceiling (currently 2).
  retryCount?: number;
}

export interface CriticResult {
  criticId: string;
  status: CriticStatus;
  verdict?: ReviewVerdict;
  requiresHumanJudgment: boolean;
  reviewer: CriticReviewerInfo;
  summary: string;
  findings: ReviewFinding[];
  validation: CriticValidationView;
  confidence: Confidence;
  durationMs?: number;
  // Cycle 6.3 — optional per-critic telemetry. Populated by adapters
  // that surface vendor token usage on the SDK response (codex,
  // gemini, grok-direct). Subscription-CLI / opaque-result adapters
  // (cursor-sdk, cursor-cli, codex-cli) leave them undefined when the
  // upstream API doesn't expose usage data. Hosted runtimes persist
  // these fields and compute cost via a versioned pricing table; OSS
  // consumers are free to ignore them.
  /** Input tokens for the critic's LLM call (excludes cached prefix). */
  tokensInput?: number;
  /** Output tokens generated by the critic's LLM call. */
  tokensOutput?: number;
  /** Cached input tokens (prompt-cache hits). Subset of total input. */
  tokensCached?: number;
  /** Internal retries the adapter performed against this critic
   *  during the run (0-N). Distinct from CriticError.retryCount, which
   *  is only stamped on terminal-error results. */
  retries?: number;
  error?: CriticError;
}

export interface BypassRecord {
  reason: string;
  at: string;
  user?: string;
}

// Cycle 332 — explicit shape discriminator on ReviewArtifact. Old
// artifacts (commit-shaped) omit the field and `parseReviewArtifact`
// preserves that absence as `rangeKind === undefined`; defaulting to
// "commit" semantics happens at gate dispatch (`evaluateCommitGate`
// accepts `undefined` for back-compat; `evaluatePushGate` requires
// "push" explicitly). New push-shaped artifacts written by
// review-push set "push". The gate evaluators precondition-check
// this so feeding a push-range artifact to the commit gate (or vice
// versa) yields a clear shape-mismatch error rather than silently
// failing the downstream diff-hash recompute. The artifact schema
// version stays at 2 — only the optional discriminator is new (per
// cycle doc "Out of scope" §`ReviewArtifact.version` bump).
export type ReviewArtifactRangeKind = "commit" | "push";

export interface ReviewArtifact {
  version: 2;
  status: ArtifactStatus;
  repo: string;
  commit: string;
  parent: string;
  range: string;
  diffHash: string;
  artifactScope: ArtifactScope;
  gateVerdict?: ReviewVerdict;
  aggregationPolicy: AggregationPolicy;
  criticResults: CriticResult[];
  createdAt: string;
  updatedAt?: string;
  bypass?: BypassRecord;
  rangeKind?: ReviewArtifactRangeKind;
}

// ---------------------------------------------------------------------
// Cycle 332 — finding cache schema (per-push delta + content-hash
// carry-forward). NDJSON file at
// `.git/agent-reviews/_pr-<N>/findings.ndjson`. Line 1 is the header;
// subsequent lines are either finding records or clean-coverage records
// (discriminated by `kind`). See Q1/Q2/Q3 of the cycle doc for the
// authoritative narrative.
// ---------------------------------------------------------------------

export const FINDING_CACHE_SCHEMA_VERSION = 1;

export interface FindingCacheHeader {
  schemaVersion: 1;
  prNumber: number;
  lastReviewedHeadSha: string;
  lastReviewedBaseSha: string;
  configHash: string; // "sha256:<64-hex>" — review-input set hash (cycle doc §Subtleties 4)
  createdAt: string;
  updatedAt: string;
}

export interface FindingCacheSupportingPath {
  path: string;
  contentHash: string; // "sha256:<64-hex>" — frozen at lodging time
}

// Finding record (`kind: "finding"`) — a critic-emitted finding whose
// content-hash bound is the anchor file. `file`/`line`/`evidence` always
// reflect the actual defective location (preserves the review contract);
// `anchorFile`/`anchorContentHash` are the cache-keying surface.
export interface FindingCacheFindingRecord {
  kind: "finding";
  reviewSha: string;
  file: string; // truthful cited-evidence location
  contentHash: string | null; // sha256 of `file` at reviewSha; null when file absent (deletion-finding cross-file-normalized case)
  findingFingerprint: string; // "sha256:<64-hex>" canonical-JSON fingerprint
  ruleId: string; // "<critic-id>:<category>"
  severity: ReviewSeverity;
  verdict: ReviewVerdict;
  evidence: string;
  impact: string;
  requiredFix: string;
  line: number | null;
  symbol: string | null;
  anchorFile: string; // cache-keying file (pass target); always a live file at reviewSha
  anchorContentHash: string; // sha256 of anchorFile at reviewSha
  supportingPaths: FindingCacheSupportingPath[]; // opt-in cross-file invalidation
  firstSeenPush: number;
  lastCarriedPush: number;
}

// Clean-coverage record (`kind: "clean"`) — emitted when ≥1 critic
// completed cleanly on a file in the recording pass. `completedCritics`
// names every critic that completed-clean on this (file, content_hash).
// `deletion: true` records mark a file that was absent at reviewSha;
// carry-forward is existence-based (not hash-based) for those.
export interface FindingCacheCleanRecord {
  kind: "clean";
  reviewSha: string;
  file: string;
  contentHash: string | null; // null when deletion === true
  deletion?: boolean;
  completedCritics: string[];
  firstSeenPush: number;
  lastCarriedPush: number;
}

export type FindingCacheRecord = FindingCacheFindingRecord | FindingCacheCleanRecord;

export interface FindingCache {
  header: FindingCacheHeader;
  records: FindingCacheRecord[];
}

// Reason a cache restore was discarded. Surfaces in `_runs.ndjson` as
// `cache_invalidated_reason` telemetry so operators correlate post-deploy
// behavior with config drift, base retarget, etc.
export type CacheInvalidationReason =
  | "no_cache"
  | "missing_header"
  | "schema_version_mismatch"
  | "config_hash_mismatch"
  | "base_sha_mismatch"
  | "previous_head_unreachable";

export interface GateBlock {
  reason: string;
  criticId?: string;
  detail?: string;
}

export interface GateWarning {
  reason: string;
  criticId?: string;
  detail?: string;
}

export interface GateResult {
  blocked: boolean;
  blocks: GateBlock[];
  warnings: GateWarning[];
  bypass?: BypassRecord;
}

export interface DoctorCheck {
  name: string;
  passed: boolean;
  detail: string;
  remediation?: string;
  // Cycle 322.3 Codex PR-1429 P2 #4 — checks tied to optional
  // (`required: false`, shadow-mode) critics are informational only:
  // `cmdDoctor` prints them but does NOT exit non-zero when they
  // fail. Without this flag a fresh worktree without an optional
  // critic's key (e.g. `XAI_API_KEY` pre-provisioning for the Grok
  // shadow critic) would fail `make agent-review-doctor` solely
  // because of an opt-in adapter, defeating the shadow-mode promise
  // operators see in `.agent-review/config.json` (`required: false`).
  // Required critics keep the fail-closed default — the flag is
  // omitted (or `false`) for them, and `cmdDoctor` exits 1 on any
  // un-flagged failure.
  optional?: boolean;
}

// Consumer issue dark-factory-platform#56 — `df doctor --json` schema.
// Emitted on stdout when the operator (or a consumer-side pre-push
// hook) passes `--json`. The shape is intentionally stable so
// downstream consumers can pin against `schema: "df-doctor-report-v1"`
// and rely on the field set without re-parsing the human-readable
// INFO/OK/FAIL block.
//
// Shape contract (v1):
//   - `version: 1` + `schema: "df-doctor-report-v1"` — bump together
//     for breaking changes; additive fields stay on v1.
//   - `triage` — the same headline `cmdDoctor` prints (state + line).
//   - `cloudEnv` — the structured detection result (detected + which
//     markers fired). Consumer-side pre-push hooks read this BEFORE
//     reading `triage` so the cloud-env bypass remediation is one
//     branch upstream of the auth_pending branch.
//   - `profile` — the resolved profile name. Always a concrete string
//     (`resolveProfile` defaults to `"local"` when neither `--profile`
//     nor `AGENT_REVIEW_PROFILE` is supplied), so consumer hooks can
//     pattern-match on `report.profile` without an `undefined` branch.
//     `JSON.stringify` omits properties whose value is `undefined`, so
//     this typing is load-bearing for the stable-field-set contract.
//   - `ok` — the same exit-code-equivalent flag (true ⇒ all required
//     checks passed, identical to `process.exit(0)` from `cmdDoctor`).
//   - `checks` — the full per-check array `runDoctor` returns, in
//     emission order, so consumers can render their own UI on top.
export interface DoctorReportV1 {
  version: 1;
  schema: "df-doctor-report-v1";
  triage: {
    state: "config_missing" | "auth_pending" | "ok";
    line: string;
  };
  cloudEnv: {
    detected: boolean;
    /**
     * The subset of cloud-env markers whose env values were truthy.
     * Stable token list (extended in additive bumps; never reordered
     * — append-only). Current set:
     *   - `CODESPACES`            (GitHub Codespaces)
     *   - `REMOTE_CONTAINERS`     (VS Code Dev Containers)
     *   - `CLAUDE_CODE_SANDBOX`   (Claude Code web sandbox)
     *   - `DEVCONTAINER`          (generic devcontainer images)
     */
    markers: string[];
  };
  profile: string;
  ok: boolean;
  checks: DoctorCheck[];
}

// Cycle 322.1 — SDK status messages stream before the terminal event.
// Capturing the SDK's own explanation (e.g.,
// "Upstream model gpt-5.5 returned capacity_exceeded after retry policy
// exhausted") gives operators an actionable signal without re-parsing
// the agent stream.
export interface CriticStatusMessage {
  status: string;
  message: string;
}

export interface TelemetryEvent {
  ts: string;
  event:
    | "review_started"
    | "review_finished"
    | "review_error"
    | "critic_run_started"
    | "critic_run_finished"
    | "critic_run_error"
    | "gate_blocked"
    | "gate_passed"
    | "gate_bypassed"
    | "doctor_check"
    // Cycle 318.2 Component 5: emitted by `enforceFindingRubric` when a
    // blocker/high finding is stripped for failing the three-way rubric.
    | "rubric_strip"
    // Cycle 322.7 — emitted by `runReview` when a named profile is
    // selected (profile is present in the config AND the resolved
    // profile name matches a config entry). Carries `profile` name,
    // `criticIds` selected, and `quorum` override so operators can
    // see at-a-glance which posture the run used. Not emitted in the
    // back-compat no-profiles path.
    | "profile_selected"
    // Cycle 322.7 Phase C — emitted by the config-load path when
    // `AGENT_REVIEW_AGGREGATION_POLICY` overrides the on-disk policy.
    // The emergency revert toggle lets operators flip the live policy
    // back to `block-if-any` without a new PR; this event is the
    // audit trail. Operators grep `_runs.ndjson` for `event=
    // aggregation_policy_overridden` to confirm a revert was used.
    // Carries:
    //   - `configured`: the on-disk policy (what the file says).
    //   - `overridden`: the runtime policy (what the env stamped).
    //   - `autoPromotedCritics`: critics whose `required` flag was
    //     auto-promoted to `true` to preserve the block-if-any safety
    //     invariant (only populated when overriding TO block-if-any
    //     AND the source config had zero required critics).
    | "aggregation_policy_overridden"
    // Issue #68 — emitted by the codex-sdk adapter when a critic's
    // `model.params[].sandbox_mode` opts out of the default `read-only`
    // host-level sandbox. Mirrors the `aggregation_policy_overridden`
    // pattern: the operator-visible audit trail for a safety knob
    // being relaxed. Used in hosted/trusted-container contexts where
    // the container itself is the security boundary (the bwrap-based
    // read-only sandbox cannot be granted SYS_ADMIN on GKE Autopilot
    // and similar locked-down runtimes). Fires exactly once per
    // critic run (on the first attempt) and is suppressed when
    // sandbox_mode resolves to "read-only" (the default — no override
    // happened). Carries:
    //   - `criticId`, `adapter`, `commit`, `model`: standard critic-run
    //     identifiers so operators can correlate with the matching
    //     `critic_run_started`.
    //   - `sandboxMode`: the resolved sandbox mode (one of
    //     "workspace-write" | "danger-full-access" — `read-only`
    //     never appears here because it's the default).
    | "sandbox_mode_overridden"
    // Cycle 332 — review-push (per-push delta) telemetry. Operators
    // correlate these events to confirm carry-forward is operating
    // as designed and to investigate cache invalidations.
    //
    // `findings_carried_forward` — emitted once per review-push run
    // with `findingCount` set to the total carried (no LLM call)
    // and `replayMode = "per-push-delta"`. The optional
    // `perFileCounts` payload is JSON-stringified into `detail` for
    // grep-friendly inspection (NDJSON keeps it flat; do not nest
    // nested objects here).
    //
    // `findings_re_evaluated` — emitted once per run with
    // `findingCount` set to the count of findings that were
    // re-evaluated via single-file critic passes.
    //
    // `cache_invalidated_reason` — emitted when shouldInvalidateCache
    // returns a non-null reason; carries the reason in `detail`.
    //
    // `cache_save_aborted_stale_head` — emitted by the workflow's
    // save-side freshness guard (cycle doc Q1) when the run's head
    // SHA no longer matches the PR's current head at save time.
    // Carried in `detail`: "expected=<liveHead> got=<runHead>".
    //
    // `cross_file_finding_normalized` — emitted by the
    // output-scope normalization step (Mechanism B) when a critic
    // emitted a finding against a file other than the single-pass
    // target AND the cited file is live at reviewSha. Carries the
    // pass target in `criticId`-adjacent fields via `detail`.
    //
    // `cross_file_finding_normalized_deletion` — the deletion-variant
    // of the above; the cited file was absent at reviewSha. The
    // anchor falls back to the pass target (or the run-level
    // fallback anchor) and the cited path stays truthful in
    // `finding.file` for evidence reporting.
    //
    // `supporting_path_missing` — emitted when a re-evaluation's
    // output references a deleted supporting path; the cache writer
    // rejects the new finding and drops the anchor's prior findings.
    //
    // `replay_mode` — emitted once at the start of each
    // review-push / per-commit-loop run; carries the active mode in
    // `detail` so audit logs distinguish post-deploy carry-forward
    // runs from rolled-back runs.
    | "findings_carried_forward"
    | "findings_re_evaluated"
    | "cache_invalidated_reason"
    | "cache_save_aborted_stale_head"
    | "cross_file_finding_normalized"
    | "cross_file_finding_normalized_deletion"
    | "supporting_path_missing"
    | "replay_mode"
    // ADR 0001 § 2.5 — emitted once per runReview() when the bounded
    // lockfile strategy fires (at least one path has effective mode
    // !== "full" AND the compaction step ran). Payload reuses
    // existing fields: `findingCount` carries the count of paths
    // compacted, `perFileCounts` carries a JSON-stringified
    // `{path: lockfileKind}` map (mirroring cycle-332 convention).
    // Operators detect glob-miss regressions by greppping for this
    // event and confirming expected paths appear in perFileCounts.
    | "compacted_files";
  commit?: string;
  criticId?: string;
  adapter?: string;
  model?: string;
  agentId?: string;
  runId?: string;
  durationMs?: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsdEstimate?: number | null;
  verdict?: ReviewVerdict;
  findingCount?: number;
  blockerCount?: number;
  highCount?: number;
  status?: string;
  error?: string;
  bypassReason?: string;
  // Cycle 322.1 — retry telemetry. `errorCode` carries the SDK's
  // structured failure code on `critic_run_error`; `statusMessage`
  // carries the SDK's own explanation when an SDKStatusMessage stream
  // event preceded the terminal failure; `retryCount` is the attempt
  // index for this specific event (0 = initial attempt, 1 = first
  // retry, …) — for `critic_run_finished` it represents the attempt
  // that succeeded, so retryCount > 0 means at least one retry was
  // needed.
  errorCode?: string;
  statusMessage?: CriticStatusMessage;
  retryCount?: number;
  // Cycle 322.3 — quorum-aware review_finished telemetry. Populated
  // by `runner.runReview` from `quorumAggregateVerdict` regardless
  // of which aggregation policy is live: under the shadow-mode
  // quorum (322.3 default-config of `block-if-any`), these fields
  // surface the hypothetical quorum outcome so operators can observe
  // how the gate WOULD behave once 322.3.1 promotes the policy.
  // Under `min-complete-quorum` they reflect the actual gate
  // decision. Operators correlate `aggregateReason` with the
  // artifact's `aggregationPolicy` to interpret which case applies.
  //   - `aggregateReason`: which path the quorum aggregator chose.
  //     ALWAYS one of: "majority" (quorum-met majority among
  //     completed critics), "veto" (single rigorous critic vetoed
  //     via blocking finding or `requiresHumanJudgment`), or
  //     "quorum_unmet" (fewer than `quorum` critics completed, no
  //     veto). The value is the quorum interpretation regardless of
  //     the live policy — this is intentional so that calibration
  //     metrics aggregate cleanly across the policy-promotion
  //     boundary (Cycle 322.3.1).
  //   - `criticVerdicts`: per-critic verdict map (criticId → verdict)
  //   - `criticCompletionStates`: per-critic terminal status (criticId →
  //     "completed" | "errored" | "pending")
  aggregateReason?: "majority" | "veto" | "quorum_unmet";
  criticVerdicts?: Record<string, ReviewVerdict>;
  criticCompletionStates?: Record<string, "completed" | "errored" | "pending">;
  // Cycle 322.7 — populated on `profile_selected` events when the
  // runner narrows critic invocations to a profile's `criticIds`
  // subset. Operators correlate `profile` with `aggregateReason` to
  // see which posture the run used (local 1-of-2 vs cloud 3-of-4).
  profile?: string;
  criticIds?: string[];
  quorum?: number;
  // Cycle 322.7 Phase C — populated on `aggregation_policy_overridden`
  // events. `configured` is the on-disk policy, `overridden` is the
  // env-stamped runtime policy, `autoPromotedCritics` lists the
  // critic ids whose `required` flag was auto-promoted to true to
  // preserve the block-if-any safety invariant. Empty array when no
  // promotion was needed (e.g., override TO min-complete-quorum, or
  // override TO block-if-any with a required critic already set).
  configured?: AggregationPolicy;
  overridden?: AggregationPolicy;
  autoPromotedCritics?: string[];
  // Issue #68 — populated on `sandbox_mode_overridden` events emitted
  // by the codex-sdk adapter. Carries the resolved Codex sandbox mode
  // ("workspace-write" | "danger-full-access" — "read-only" never
  // appears here because it's the default and produces no event).
  // The field is typed as `string` to keep the schemas package
  // adapter-agnostic; vocabulary validation lives in the adapter
  // (see `CODEX_SANDBOX_MODES` in `adapters/codex-sdk.ts`).
  sandboxMode?: string;
  // Cycle 332 — push-delta telemetry payload fields. Populated only
  // on the events introduced this cycle; legacy events keep these
  // undefined.
  //   - replayMode: "per-push-delta" | "per-commit" (default vs
  //     rollback path).
  //   - prNumber: GitHub PR number the cache is scoped to.
  //   - baseSha / headSha: range endpoints for the review-push run.
  //   - lastReviewedHeadSha: header value at read time (when present).
  //   - cacheInvalidationReason: surface for the discriminated reason
  //     enum surfaced by shouldInvalidateCache.
  //   - perFileCounts: JSON-stringified `{ path: count }` map; flat
  //     stringification keeps NDJSON greppable.
  //   - normalizationTarget: pass-target file when a normalization
  //     event fires.
  replayMode?: "per-push-delta" | "per-commit";
  prNumber?: number;
  baseSha?: string;
  headSha?: string;
  lastReviewedHeadSha?: string;
  cacheInvalidationReason?: CacheInvalidationReason;
  perFileCounts?: string;
  normalizationTarget?: string;
}

export class SchemaError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`schema(${path}): ${message}`);
    this.name = "SchemaError";
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isString = (v: unknown): v is string => typeof v === "string";
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInteger = (v: unknown): v is number => Number.isInteger(v);
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isArray = (v: unknown): v is unknown[] => Array.isArray(v);

function need<T>(
  pred: (v: unknown) => v is T,
  value: unknown,
  path: string,
  expected: string,
): T {
  if (pred(value)) return value;
  const repr =
    typeof value === "object"
      ? JSON.stringify(value).slice(0, 80)
      : value === undefined
        ? "undefined"
        : String(value);
  throw new SchemaError(path, `expected ${expected}, got ${repr}`);
}

function needEnum<T extends string>(
  values: readonly T[],
  value: unknown,
  path: string,
): T {
  const s = need(isString, value, path, `one of ${values.join(", ")}`);
  if (!values.includes(s as T)) {
    throw new SchemaError(path, `expected one of ${values.join(", ")}, got ${s}`);
  }
  return s as T;
}

function optional<T>(
  pred: (v: unknown) => v is T,
  value: unknown,
  path: string,
  expected: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return need(pred, value, path, expected);
}

function parseModelParam(raw: unknown, path: string): ModelParam {
  const obj = need(isObject, raw, path, "object");
  const id = need(isNonEmptyString, obj["id"], `${path}.id`, "non-empty string");
  const value = obj["value"];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new SchemaError(`${path}.value`, "expected string|number|boolean");
  }
  return { id, value };
}

function parseModelConfig(raw: unknown, path: string): ModelConfig {
  const obj = need(isObject, raw, path, "object");
  const id = need(isNonEmptyString, obj["id"], `${path}.id`, "non-empty string");
  const paramsRaw = obj["params"] ?? [];
  const paramsArr = need(isArray, paramsRaw, `${path}.params`, "array");
  const params = paramsArr.map((p, i) => parseModelParam(p, `${path}.params[${i}]`));
  return { id, params };
}

function parseCriticConfig(raw: unknown, path: string): CriticConfig {
  const obj = need(isObject, raw, path, "object");
  return {
    id: need(isNonEmptyString, obj["id"], `${path}.id`, "non-empty string"),
    name: need(isNonEmptyString, obj["name"], `${path}.name`, "non-empty string"),
    adapter: need(isNonEmptyString, obj["adapter"], `${path}.adapter`, "non-empty string"),
    required: need(isBoolean, obj["required"], `${path}.required`, "boolean"),
    runtime: need(isNonEmptyString, obj["runtime"], `${path}.runtime`, "non-empty string"),
    model: parseModelConfig(obj["model"], `${path}.model`),
  };
}

function parseStringArray(raw: unknown, path: string): string[] {
  const arr = need(isArray, raw, path, "array");
  return arr.map((v, i) => need(isString, v, `${path}[${i}]`, "string"));
}

// Cycle 322.7 — parse a single profile envelope. Validation rules are
// enforced in `parseAgentReviewConfig` because they depend on the root
// `critics[]` list (criticId existence + quorum bounds).
//
// Cycle 322.8 — `modelParamOverrides` is parsed here for shape (object,
// non-empty paramId, primitive value); the cross-field rule that every
// overridden criticId must be present in this profile's `criticIds[]`
// is enforced here (intra-profile reference integrity).
//
// Issue #2103 — `auth` map parsed here for shape (object of criticId →
// non-empty string) + the same cross-field rule as `modelParamOverrides`
// (criticId MUST be in this profile's `criticIds[]`). Value validation
// (which strings each adapter accepts) is intentionally NOT enforced
// here — that's adapter-vocabulary and lives in the adapter's
// `attemptReview()` / `doctor()`. The schema only guarantees shape so
// new critic families can ship their own auth tokens without touching
// the parser.
function parseProfileConfig(raw: unknown, path: string): ProfileConfig {
  const obj = need(isObject, raw, path, "object");
  const criticIdsRaw = need(isArray, obj["criticIds"], `${path}.criticIds`, "array");
  if (criticIdsRaw.length === 0) {
    throw new SchemaError(`${path}.criticIds`, "must contain at least one critic id");
  }
  const criticIds = criticIdsRaw.map((v, i) =>
    need(isNonEmptyString, v, `${path}.criticIds[${i}]`, "non-empty string"),
  );
  const seen = new Set<string>();
  for (const id of criticIds) {
    if (seen.has(id)) {
      throw new SchemaError(`${path}.criticIds`, `duplicate critic id: ${id}`);
    }
    seen.add(id);
  }
  const quorum = need(isInteger, obj["quorum"], `${path}.quorum`, "integer");

  // Cycle 322.8 — optional modelParamOverrides
  const overridesRaw = obj["modelParamOverrides"];
  let modelParamOverrides:
    | { [criticId: string]: { [paramId: string]: string | number | boolean } }
    | undefined;
  if (overridesRaw !== undefined && overridesRaw !== null) {
    const overridesObj = need(
      isObject,
      overridesRaw,
      `${path}.modelParamOverrides`,
      "object",
    );
    const validProfileCriticIds = new Set(criticIds);
    const out: {
      [criticId: string]: { [paramId: string]: string | number | boolean };
    } = {};
    for (const [criticId, paramMapRaw] of Object.entries(overridesObj)) {
      if (criticId.length === 0) {
        throw new SchemaError(
          `${path}.modelParamOverrides`,
          "criticId key must be non-empty",
        );
      }
      if (!validProfileCriticIds.has(criticId)) {
        throw new SchemaError(
          `${path}.modelParamOverrides.${criticId}`,
          `criticId "${criticId}" is not in this profile's criticIds[] (${[...validProfileCriticIds].join(", ")}); overriding an excluded critic is a foot-gun`,
        );
      }
      const paramMap = need(
        isObject,
        paramMapRaw,
        `${path}.modelParamOverrides.${criticId}`,
        "object",
      );
      const params: { [paramId: string]: string | number | boolean } = {};
      for (const [paramId, value] of Object.entries(paramMap)) {
        if (paramId.length === 0) {
          throw new SchemaError(
            `${path}.modelParamOverrides.${criticId}`,
            "paramId key must be non-empty",
          );
        }
        if (
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        ) {
          throw new SchemaError(
            `${path}.modelParamOverrides.${criticId}.${paramId}`,
            "expected string|number|boolean",
          );
        }
        params[paramId] = value;
      }
      out[criticId] = params;
    }
    modelParamOverrides = out;
  }

  // Issue #2103 — optional auth map
  const authRaw = obj["auth"];
  let auth: { [criticId: string]: string } | undefined;
  if (authRaw !== undefined && authRaw !== null) {
    const authObj = need(isObject, authRaw, `${path}.auth`, "object");
    const validProfileCriticIds = new Set(criticIds);
    const out: { [criticId: string]: string } = {};
    for (const [criticId, value] of Object.entries(authObj)) {
      if (criticId.length === 0) {
        throw new SchemaError(`${path}.auth`, "criticId key must be non-empty");
      }
      if (!validProfileCriticIds.has(criticId)) {
        throw new SchemaError(
          `${path}.auth.${criticId}`,
          `criticId "${criticId}" is not in this profile's criticIds[] (${[...validProfileCriticIds].join(", ")}); pinning auth on an excluded critic is a foot-gun`,
        );
      }
      if (typeof value !== "string" || value.length === 0) {
        throw new SchemaError(
          `${path}.auth.${criticId}`,
          "expected non-empty string (adapter-specific token, e.g. 'chatgpt' | 'api')",
        );
      }
      out[criticId] = value;
    }
    auth = out;
  }

  const base: ProfileConfig = { criticIds, quorum };
  if (modelParamOverrides !== undefined) base.modelParamOverrides = modelParamOverrides;
  if (auth !== undefined) base.auth = auth;
  return base;
}

export function parseAgentReviewConfig(raw: unknown): AgentReviewConfig {
  const root = need(isObject, raw, "$", "object");
  const version = need(isNumber, root["version"], "$.version", "number");
  if (version !== 1 && version !== 2) {
    throw new SchemaError("$.version", `expected 1 or 2, got ${version}`);
  }
  const configVersion = version as AgentReviewConfigVersion;

  const criticsRaw = need(isArray, root["critics"], "$.critics", "array");
  if (criticsRaw.length === 0) throw new SchemaError("$.critics", "must contain at least one critic");
  const critics = criticsRaw.map((c, i) => parseCriticConfig(c, `$.critics[${i}]`));
  const ids = new Set<string>();
  for (const c of critics) {
    if (ids.has(c.id)) throw new SchemaError(`$.critics`, `duplicate critic id: ${c.id}`);
    ids.add(c.id);
  }

  const aggregationRaw = need(isObject, root["aggregation"], "$.aggregation", "object");
  const aggregationPolicy = needEnum(
    AGGREGATION_POLICIES,
    aggregationRaw["policy"],
    "$.aggregation.policy",
  );
  // Cycle 322.3 — `min-complete-quorum` requires a validated quorum
  // integer. A stale `quorum` field on a `block-if-any` policy is
  // rejected so a policy roll-back (which leaves the quorum integer
  // in the file) surfaces as a config error rather than silently
  // ignoring a now-meaningless field.
  const quorumRaw = aggregationRaw["quorum"];
  let quorum: number | undefined;
  if (aggregationPolicy === "min-complete-quorum") {
    quorum = need(isInteger, quorumRaw, "$.aggregation.quorum", "integer");
    if (quorum < 2) {
      throw new SchemaError(
        "$.aggregation.quorum",
        `min-complete-quorum requires quorum >= 2, got ${quorum}`,
      );
    }
    if (quorum > critics.length) {
      throw new SchemaError(
        "$.aggregation.quorum",
        `quorum (${quorum}) exceeds configured critic count (${critics.length})`,
      );
    }
  } else if (quorumRaw !== undefined && quorumRaw !== null) {
    throw new SchemaError(
      "$.aggregation.quorum",
      `quorum is only valid for policy="min-complete-quorum"; remove it or switch policy`,
    );
  }
  const aggregation: AggregationConfig = {
    policy: aggregationPolicy,
    blockingSeverities: parseStringArray(
      aggregationRaw["blockingSeverities"],
      "$.aggregation.blockingSeverities",
    ).map((s, i) =>
      needEnum(REVIEW_SEVERITIES, s, `$.aggregation.blockingSeverities[${i}]`),
    ),
    ...(quorum !== undefined ? { quorum } : {}),
  };

  const gitRaw = need(isObject, root["git"], "$.git", "object");
  const git: GitConfig = {
    hookPath: need(isNonEmptyString, gitRaw["hookPath"], "$.git.hookPath", "non-empty string"),
    artifactDir: need(
      isNonEmptyString,
      gitRaw["artifactDir"],
      "$.git.artifactDir",
      "non-empty string",
    ),
    artifactScope: needEnum(ARTIFACT_SCOPES, gitRaw["artifactScope"], "$.git.artifactScope"),
  };

  const policyRaw = need(isObject, root["policy"], "$.policy", "object");
  const policy: PolicyConfig = {
    blockOnMissingReview: need(
      isBoolean,
      policyRaw["blockOnMissingReview"],
      "$.policy.blockOnMissingReview",
      "boolean",
    ),
    blockOnReviewError: need(
      isBoolean,
      policyRaw["blockOnReviewError"],
      "$.policy.blockOnReviewError",
      "boolean",
    ),
    allowEmergencyBypass: need(
      isBoolean,
      policyRaw["allowEmergencyBypass"],
      "$.policy.allowEmergencyBypass",
      "boolean",
    ),
    postCommitMode: needEnum(
      POST_COMMIT_MODES,
      policyRaw["postCommitMode"],
      "$.policy.postCommitMode",
    ),
  };

  const contextRaw = need(isObject, root["context"], "$.context", "object");
  const generatedFilePolicy = parseGeneratedFilePolicy(
    contextRaw["generatedFilePolicy"],
    "$.context.generatedFilePolicy",
  );
  const context: ContextConfig = {
    guidanceFiles: parseStringArray(contextRaw["guidanceFiles"], "$.context.guidanceFiles"),
    promptFragments: parseStringArray(contextRaw["promptFragments"], "$.context.promptFragments"),
    maxChangedFileBytes: need(
      isInteger,
      contextRaw["maxChangedFileBytes"],
      "$.context.maxChangedFileBytes",
      "integer",
    ),
    includeFullChangedFiles: need(
      isBoolean,
      contextRaw["includeFullChangedFiles"],
      "$.context.includeFullChangedFiles",
      "boolean",
    ),
    ...(generatedFilePolicy !== undefined ? { generatedFilePolicy } : {}),
  };

  const validationRaw = need(isObject, root["validation"], "$.validation", "object");
  const verificationRoutesRaw = validationRaw["verificationRoutes"];
  let verificationRoutes: VerificationRoute[] = [];
  if (verificationRoutesRaw !== undefined && verificationRoutesRaw !== null) {
    const arr = need(
      isArray,
      verificationRoutesRaw,
      "$.validation.verificationRoutes",
      "array",
    );
    verificationRoutes = arr.map((r, i) =>
      parseVerificationRoute(r, `$.validation.verificationRoutes[${i}]`),
    );
    const seenIds = new Set<string>();
    for (const r of verificationRoutes) {
      if (seenIds.has(r.id)) {
        throw new SchemaError(
          "$.validation.verificationRoutes",
          `duplicate route id: ${r.id}`,
        );
      }
      seenIds.add(r.id);
    }
  } else if (configVersion === 2) {
    // v2 requires the routes key to exist (even as empty array) — make
    // the omission a parse error so operators can't drift back to v1
    // semantics by leaving the field out.
    throw new SchemaError(
      "$.validation.verificationRoutes",
      "version 2 config must declare verificationRoutes (use [] if none configured)",
    );
  }
  const validation: ValidationConfig = {
    runBeforeReview: need(
      isBoolean,
      validationRaw["runBeforeReview"],
      "$.validation.runBeforeReview",
      "boolean",
    ),
    resultFile: need(
      isNonEmptyString,
      validationRaw["resultFile"],
      "$.validation.resultFile",
      "non-empty string",
    ),
    requiredQualityGates: parseStringArray(
      validationRaw["requiredQualityGates"],
      "$.validation.requiredQualityGates",
    ),
    optionalQualityGates: parseStringArray(
      validationRaw["optionalQualityGates"],
      "$.validation.optionalQualityGates",
    ),
    verificationRoutes,
  };

  const securityRaw = need(isObject, root["security"], "$.security", "object");
  const security: SecurityConfig = {
    redactSecretsInDiagnostics: need(
      isBoolean,
      securityRaw["redactSecretsInDiagnostics"],
      "$.security.redactSecretsInDiagnostics",
      "boolean",
    ),
    treatDiffAsUntrustedInput: need(
      isBoolean,
      securityRaw["treatDiffAsUntrustedInput"],
      "$.security.treatDiffAsUntrustedInput",
      "boolean",
    ),
  };

  let tdd: TddConfig | undefined;
  const tddRaw = root["tdd"];
  if (tddRaw !== undefined && tddRaw !== null) {
    tdd = parseTddConfig(tddRaw, "$.tdd");
  } else if (configVersion === 2) {
    throw new SchemaError(
      "$.tdd",
      "version 2 config must declare tdd.classifier (production/test/exclusion globs + trailer)",
    );
  }

  let secrets: SecretsConfig | undefined;
  const secretsRaw = root["secrets"];
  if (secretsRaw !== undefined) {
    const sObj = need(isObject, secretsRaw, "$.secrets", "object");
    const dop = sObj["doppler"];
    if (dop !== undefined) {
      const dObj = need(isObject, dop, "$.secrets.doppler", "object");
      secrets = {
        doppler: {
          project: need(
            isNonEmptyString,
            dObj["project"],
            "$.secrets.doppler.project",
            "non-empty string",
          ),
          config: need(
            isNonEmptyString,
            dObj["config"],
            "$.secrets.doppler.config",
            "non-empty string",
          ),
        },
      };
    } else {
      secrets = {};
    }
  }

  // Cycle 322.7 — optional `profiles` map. Each profile carries its own
  // critic subset + quorum, selected at runtime by the CLI. Validation
  // happens here because criticId existence depends on the parsed
  // `critics[]` array, and quorum bounds depend on the profile's
  // criticIds length.
  let profiles: { [name: string]: ProfileConfig } | undefined;
  const profilesRaw = root["profiles"];
  if (profilesRaw !== undefined && profilesRaw !== null) {
    const profilesObj = need(isObject, profilesRaw, "$.profiles", "object");
    const validCriticIds = new Set(critics.map((c) => c.id));
    const out: { [name: string]: ProfileConfig } = {};
    for (const [name, value] of Object.entries(profilesObj)) {
      if (name.length === 0) {
        throw new SchemaError("$.profiles", "profile name must be non-empty");
      }
      const path = `$.profiles["${name}"]`;
      const profile = parseProfileConfig(value, path);
      // Reference integrity: every criticId must exist in the root list.
      for (const id of profile.criticIds) {
        if (!validCriticIds.has(id)) {
          throw new SchemaError(
            `${path}.criticIds`,
            `unknown critic id "${id}"; valid ids: ${[...validCriticIds].join(", ")}`,
          );
        }
      }
      // Quorum bounds: 1 <= quorum <= criticIds.length. Profile quorum
      // can be 1 (the local 1-of-N posture) — that's the whole point of
      // Cycle 322.7 profile envelopes. Only the root `aggregation.quorum`
      // is bound to >= 2 (validated earlier).
      if (profile.quorum < 1) {
        throw new SchemaError(
          `${path}.quorum`,
          `profile quorum must be >= 1, got ${profile.quorum}`,
        );
      }
      if (profile.quorum > profile.criticIds.length) {
        throw new SchemaError(
          `${path}.quorum`,
          `profile quorum (${profile.quorum}) exceeds criticIds.length (${profile.criticIds.length})`,
        );
      }
      out[name] = profile;
    }
    profiles = out;
  }

  // Cycle 322.7 — Safety invariant (Codex P1 on PR #1456 / preserved by PR #1459).
  // Under `aggregation.policy: "block-if-any"`, `gate.ts:evaluateCommitGate`
  // only blocks pushes on critics with `required: true`. A `block-if-any` config
  // with all `required: false` critics would silently downgrade blocker findings
  // to warnings — the exact unsafe state that motivated the env-override
  // auto-promotion in Component 4. Reject at load time so the on-disk shape can
  // never ship the unsafe combination.
  //
  // Two complementary checks under `block-if-any`:
  //
  //  (a) FULL critics list must have at least one `required: true`. Without
  //      this, no profile narrowing can recover a required critic (the
  //      profile filter can only subset the full list, not promote flags).
  //
  //  (b) Every PROFILE'S `criticIds` must intersect the required set. A
  //      profile that narrows away every required critic would yield the
  //      same unsafe runtime state under block-if-any: the gate evaluator
  //      would see only optional critics in the artifact and demote
  //      blockers to warnings. (Cursor critic on PR #1467 flagged this
  //      gap; the cycle doc anticipated it in the Component 2 Validation
  //      Rules section but ambiguous about whether check (b) belongs to
  //      Phase B or Phase C. Closing it here keeps Phase B safety-complete
  //      against the documented attack: an operator declaring a profile
  //      that selects only optional critics under block-if-any.)
  if (aggregationPolicy === "block-if-any") {
    if (!critics.some((c) => c.required)) {
      throw new SchemaError(
        "$.aggregation.policy",
        'policy "block-if-any" requires at least one critic with `required: true`; ' +
          "all configured critics are `required: false`. Under block-if-any, the gate " +
          "only blocks pushes on required critics, so this combination would silently " +
          "downgrade blocker findings to warnings. Either promote at least one critic " +
          "to required, or switch policy to `min-complete-quorum` (where every critic " +
          "contributes to the quorum count regardless of `required`).",
      );
    }
    // (b) — every profile must include at least one required critic.
    // Sort profile names before iterating so multi-profile violations
    // produce deterministic error messages across engines / config shapes
    // (Cursor medium finding on the Phase B commit).
    if (profiles) {
      const requiredIds = new Set(critics.filter((c) => c.required).map((c) => c.id));
      const sortedRequiredIds = [...requiredIds].sort();
      const profileNames = Object.keys(profiles).sort();
      for (const name of profileNames) {
        const profile = profiles[name]!;
        const hasRequired = profile.criticIds.some((id) => requiredIds.has(id));
        if (!hasRequired) {
          throw new SchemaError(
            `$.profiles["${name}"].criticIds`,
            `under policy "block-if-any", profile "${name}" narrows critics to an ` +
              "all-optional subset (zero `required: true` critics). The gate would " +
              "silently downgrade blocker findings to warnings under this profile. " +
              `Include at least one of: ${sortedRequiredIds.join(", ")}; or switch ` +
              'policy to "min-complete-quorum".',
          );
        }
      }
    }
  }

  return {
    version: configVersion,
    critics,
    aggregation,
    git,
    policy,
    context,
    validation,
    security,
    ...(tdd !== undefined ? { tdd } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
    ...(profiles !== undefined ? { profiles } : {}),
  };
}

// ADR 0001 § 2.2 — generatedFilePolicy parser. Returns undefined when
// the field is absent (back-compat: today's behavior preserved). When
// present, enforces the validation rules documented in the ADR + the
// `generated-file-policy.test.ts` test matrix.
function parseGeneratedFilePolicy(
  raw: unknown,
  path: string,
): GeneratedFilePolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = need(isObject, raw, path, "object");
  const mode = needEnum(GENERATED_FILE_MODES, obj["mode"], `${path}.mode`);

  // globs: optional. When present, must be a non-empty array of
  // non-empty strings with no duplicates. An explicitly-empty
  // `globs: []` is rejected so a misconfigured CLI version-bump
  // doesn't silently fall back to defaults without operator intent.
  let globs: string[] | undefined;
  const globsRaw = obj["globs"];
  if (globsRaw !== undefined && globsRaw !== null) {
    const arr = need(isArray, globsRaw, `${path}.globs`, "array");
    if (arr.length === 0) {
      throw new SchemaError(
        `${path}.globs`,
        "non-empty array required when present; omit the field to fall back to DEFAULT_GENERATED_LOCKFILE_GLOBS",
      );
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < arr.length; i++) {
      const g = need(
        isNonEmptyString,
        arr[i],
        `${path}.globs[${i}]`,
        "non-empty string",
      );
      if (seen.has(g)) {
        throw new SchemaError(`${path}.globs`, `duplicate glob: ${g}`);
      }
      seen.add(g);
      out.push(g);
    }
    globs = out;
  }

  // overrides: optional. Each entry is `{glob, mode}`. Duplicate
  // override glob rejected.
  let overrides: GeneratedFileGlobOverride[] | undefined;
  const overridesRaw = obj["overrides"];
  if (overridesRaw !== undefined && overridesRaw !== null) {
    const arr = need(isArray, overridesRaw, `${path}.overrides`, "array");
    const out: GeneratedFileGlobOverride[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < arr.length; i++) {
      const entry = need(isObject, arr[i], `${path}.overrides[${i}]`, "object");
      const g = need(
        isNonEmptyString,
        entry["glob"],
        `${path}.overrides[${i}].glob`,
        "non-empty string",
      );
      const m = needEnum(
        GENERATED_FILE_MODES,
        entry["mode"],
        `${path}.overrides[${i}].mode`,
      );
      if (seen.has(g)) {
        throw new SchemaError(
          `${path}.overrides`,
          `duplicate override glob: ${g}`,
        );
      }
      seen.add(g);
      out.push({ glob: g, mode: m });
    }
    overrides = out;
  }

  // onParseError: optional. Default ("refuse-and-block") is applied
  // at the packet-build site, not by the parser — parser preserves
  // absence as undefined per ADR § 5.2 #9.
  let onParseError: OnParseErrorMode | undefined;
  const opeRaw = obj["onParseError"];
  if (opeRaw !== undefined && opeRaw !== null) {
    onParseError = needEnum(
      ON_PARSE_ERROR_MODES,
      opeRaw,
      `${path}.onParseError`,
    );
  }

  return {
    mode,
    ...(globs !== undefined ? { globs } : {}),
    ...(overrides !== undefined ? { overrides } : {}),
    ...(onParseError !== undefined ? { onParseError } : {}),
  };
}

function parseVerificationRoute(raw: unknown, path: string): VerificationRoute {
  const obj = need(isObject, raw, path, "object");
  const id = need(isNonEmptyString, obj["id"], `${path}.id`, "non-empty string");
  const triggerArr = need(isArray, obj["trigger"], `${path}.trigger`, "array");
  if (triggerArr.length === 0) {
    throw new SchemaError(`${path}.trigger`, "must contain at least one glob");
  }
  const trigger = triggerArr.map((t, i) =>
    need(isNonEmptyString, t, `${path}.trigger[${i}]`, "non-empty string"),
  );
  const category = need(
    isNonEmptyString,
    obj["category"],
    `${path}.category`,
    "non-empty string",
  );
  const commandRaw = obj["command"];
  let command: string | null = null;
  if (commandRaw !== null && commandRaw !== undefined) {
    command = need(isNonEmptyString, commandRaw, `${path}.command`, "non-empty string or null");
  }
  const evidenceRaw = obj["evidencePath"];
  let evidencePath: string | null = null;
  if (evidenceRaw !== null && evidenceRaw !== undefined) {
    evidencePath = need(
      isNonEmptyString,
      evidenceRaw,
      `${path}.evidencePath`,
      "non-empty string or null",
    );
  }
  // command and evidencePath must agree: both null (suppression route) or
  // both set (executable route). A route with command:null but evidencePath
  // set is meaningless; one with command set but evidencePath null can't
  // be evaluated by gate-push.
  if ((command === null) !== (evidencePath === null)) {
    throw new SchemaError(
      path,
      "command and evidencePath must both be set or both be null",
    );
  }
  const exclusive = optional(isBoolean, obj["exclusive"], `${path}.exclusive`, "boolean");
  return {
    id,
    trigger,
    command,
    evidencePath,
    category,
    ...(exclusive !== undefined ? { exclusive } : {}),
  };
}

function parseTddConfig(raw: unknown, path: string): TddConfig {
  const obj = need(isObject, raw, path, "object");
  const classifierRaw = need(isObject, obj["classifier"], `${path}.classifier`, "object");
  const productionGlobs = parseStringArray(
    classifierRaw["productionGlobs"],
    `${path}.classifier.productionGlobs`,
  );
  const testGlobs = parseStringArray(
    classifierRaw["testGlobs"],
    `${path}.classifier.testGlobs`,
  );
  const exclusionGlobs = parseStringArray(
    classifierRaw["exclusionGlobs"],
    `${path}.classifier.exclusionGlobs`,
  );
  const justificationTrailer = need(
    isNonEmptyString,
    classifierRaw["justificationTrailer"],
    `${path}.classifier.justificationTrailer`,
    "non-empty string",
  );
  return {
    classifier: {
      productionGlobs,
      testGlobs,
      exclusionGlobs,
      justificationTrailer,
    },
  };
}

function parseFinding(raw: unknown, path: string, blockingSeverities: ReviewSeverity[]): ReviewFinding {
  const obj = need(isObject, raw, path, "object");
  const severity = needEnum(REVIEW_SEVERITIES, obj["severity"], `${path}.severity`);
  const category = need(isNonEmptyString, obj["category"], `${path}.category`, "non-empty string");
  const evidence = need(isNonEmptyString, obj["evidence"], `${path}.evidence`, "non-empty string");
  const impact = need(isNonEmptyString, obj["impact"], `${path}.impact`, "non-empty string");
  const requiredFix = need(
    isNonEmptyString,
    obj["requiredFix"],
    `${path}.requiredFix`,
    "non-empty string",
  );
  const file = optional(isString, obj["file"], `${path}.file`, "string");
  const line = optional(isInteger, obj["line"], `${path}.line`, "integer");
  const symbol = optional(isString, obj["symbol"], `${path}.symbol`, "string");
  const manifestoSection = optional(
    isString,
    obj["manifestoSection"],
    `${path}.manifestoSection`,
    "string",
  );
  // Cycle 318.2 Component 5: critic-supplied evidence routing. When a
  // finding cites a gate failure, evidencePath points to the per-SHA
  // evidence file the critic relied on. When a finding's blocking rule
  // is waived by a recognized commit trailer, the critic carries the
  // trailer value forward as `justification` so the rubric strip step
  // can honor the human override without re-parsing the commit body.
  const evidencePath = optional(
    isString,
    obj["evidencePath"],
    `${path}.evidencePath`,
    "string",
  );
  const routeId = optional(isString, obj["routeId"], `${path}.routeId`, "string");
  const justification = optional(
    isString,
    obj["justification"],
    `${path}.justification`,
    "string",
  );
  // Cycle 332 — optional contentHash on the cited evidence file.
  // Parsed via the same `optional()` pattern as other v2 extensions
  // (evidencePath, routeId, justification) so existing v1/v2 artifacts
  // that predate the field still parse identically.
  const contentHash = optional(
    isString,
    obj["contentHash"],
    `${path}.contentHash`,
    "string",
  );
  // Issue #106 — optional LLM self-flag. Preserve the omitted-vs-false
  // distinction at the wire level: absent → undefined, explicit false
  // → false, true → true. Consumers must be able to tell "the critic
  // didn't report" from "the critic reported false", so this field
  // uses the same conditional-spread pattern as other optional fields
  // (do NOT default to false).
  const requiresHumanJudgment = optional(
    isBoolean,
    obj["requiresHumanJudgment"],
    `${path}.requiresHumanJudgment`,
    "boolean",
  );
  if (blockingSeverities.includes(severity) && !file) {
    throw new SchemaError(`${path}.file`, `blocking severity ${severity} requires file`);
  }
  return {
    severity,
    category,
    evidence,
    impact,
    requiredFix,
    ...(file !== undefined ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(manifestoSection !== undefined ? { manifestoSection } : {}),
    ...(evidencePath !== undefined ? { evidencePath } : {}),
    ...(routeId !== undefined ? { routeId } : {}),
    ...(justification !== undefined ? { justification } : {}),
    ...(contentHash !== undefined ? { contentHash } : {}),
    ...(requiresHumanJudgment !== undefined ? { requiresHumanJudgment } : {}),
  };
}

export function parseQualityGateResult(raw: unknown, path: string): QualityGateResult {
  const obj = need(isObject, raw, path, "object");
  const routeId = optional(isString, obj["routeId"], `${path}.routeId`, "string");
  return {
    command: need(isNonEmptyString, obj["command"], `${path}.command`, "non-empty string"),
    exitCode: need(isInteger, obj["exitCode"], `${path}.exitCode`, "integer"),
    durationMs: need(isInteger, obj["durationMs"], `${path}.durationMs`, "integer"),
    logExcerpt: need(isString, obj["logExcerpt"], `${path}.logExcerpt`, "string"),
    startedAt: need(isNonEmptyString, obj["startedAt"], `${path}.startedAt`, "ISO timestamp"),
    finishedAt: need(isNonEmptyString, obj["finishedAt"], `${path}.finishedAt`, "ISO timestamp"),
    ...(routeId !== undefined ? { routeId } : {}),
  };
}

export function parseQualityGateEvidence(raw: unknown): QualityGateEvidence {
  const root = need(isObject, raw, "$", "object");
  const version = need(isNumber, root["version"], "$.version", "number");
  if (version !== 1 && version !== 2) {
    throw new SchemaError("$.version", `expected 1 or 2, got ${version}`);
  }
  const commit = need(isNonEmptyString, root["commit"], "$.commit", "non-empty string");
  const generatedAt = need(
    isNonEmptyString,
    root["generatedAt"],
    "$.generatedAt",
    "ISO timestamp",
  );
  const resultsRaw = need(isArray, root["results"], "$.results", "array");
  const results = resultsRaw.map((r, i) => parseQualityGateResult(r, `$.results[${i}]`));
  let gateResults: Record<string, QualityGateResult> | undefined;
  const gateResultsRaw = root["gateResults"];
  if (gateResultsRaw !== undefined && gateResultsRaw !== null) {
    const obj = need(isObject, gateResultsRaw, "$.gateResults", "object");
    gateResults = {};
    for (const [key, value] of Object.entries(obj)) {
      gateResults[key] = parseQualityGateResult(value, `$.gateResults["${key}"]`);
    }
  }
  return {
    version: version as 1 | 2,
    commit,
    generatedAt,
    results,
    ...(gateResults !== undefined ? { gateResults } : {}),
  };
}

export function parseCriticResult(
  raw: unknown,
  blockingSeverities: ReviewSeverity[],
): CriticResult {
  const root = need(isObject, raw, "$", "object");
  const criticId = need(isNonEmptyString, root["criticId"], "$.criticId", "non-empty string");
  const status = needEnum(CRITIC_STATUSES, root["status"], "$.status");
  const requiresHumanJudgment = need(
    isBoolean,
    root["requiresHumanJudgment"],
    "$.requiresHumanJudgment",
    "boolean",
  );
  const summary = need(isString, root["summary"], "$.summary", "string");
  const findingsRaw = need(isArray, root["findings"], "$.findings", "array");
  const findings = findingsRaw.map((f, i) =>
    parseFinding(f, `$.findings[${i}]`, blockingSeverities),
  );
  const validationRaw = need(isObject, root["validation"], "$.validation", "object");
  const qualityGateResultsRaw = need(
    isArray,
    validationRaw["qualityGateResults"],
    "$.validation.qualityGateResults",
    "array",
  );
  const validation: CriticValidationView = {
    qualityGateResults: qualityGateResultsRaw.map((r, i) =>
      parseQualityGateResult(r, `$.validation.qualityGateResults[${i}]`),
    ),
    qualityGatesMissing: parseStringArray(
      validationRaw["qualityGatesMissing"],
      "$.validation.qualityGatesMissing",
    ),
  };
  const reviewerRaw = need(isObject, root["reviewer"], "$.reviewer", "object");
  const reviewer: CriticReviewerInfo = {
    name: need(isNonEmptyString, reviewerRaw["name"], "$.reviewer.name", "non-empty string"),
    adapter: need(
      isNonEmptyString,
      reviewerRaw["adapter"],
      "$.reviewer.adapter",
      "non-empty string",
    ),
    model: parseModelConfig(reviewerRaw["model"], "$.reviewer.model"),
    runtime: need(
      isNonEmptyString,
      reviewerRaw["runtime"],
      "$.reviewer.runtime",
      "non-empty string",
    ),
    ...(reviewerRaw["agentId"] !== undefined && reviewerRaw["agentId"] !== null
      ? { agentId: need(isString, reviewerRaw["agentId"], "$.reviewer.agentId", "string") }
      : {}),
    ...(reviewerRaw["runId"] !== undefined && reviewerRaw["runId"] !== null
      ? { runId: need(isString, reviewerRaw["runId"], "$.reviewer.runId", "string") }
      : {}),
  };

  const confidence = needEnum(CONFIDENCES, root["confidence"], "$.confidence");

  let verdict: ReviewVerdict | undefined;
  if (status === "complete") {
    verdict = needEnum(REVIEW_VERDICTS, root["verdict"], "$.verdict");
    if (verdict === "CHANGES_REQUESTED" && requiresHumanJudgment && findings.length === 0) {
      throw new SchemaError(
        "$.findings",
        "CHANGES_REQUESTED with requiresHumanJudgment must include at least one explanatory finding",
      );
    }
  } else {
    const v = root["verdict"];
    if (v !== undefined && v !== null) {
      verdict = needEnum(REVIEW_VERDICTS, v, "$.verdict");
    }
  }

  const error =
    root["error"] !== undefined && root["error"] !== null
      ? parseCriticError(root["error"], "$.error")
      : undefined;

  const durationMs = optional(isInteger, root["durationMs"], "$.durationMs", "integer");

  // Cycle 6.3 — optional per-critic telemetry fields. All non-negative
  // integers when present. Older artifacts (pre-6.3) omit them; the
  // parser preserves absence as `undefined`.
  const tokensInput = optional(isInteger, root["tokensInput"], "$.tokensInput", "non-negative integer");
  if (tokensInput !== undefined && tokensInput < 0) {
    throw new SchemaError("$.tokensInput", "tokensInput must be >= 0");
  }
  const tokensOutput = optional(isInteger, root["tokensOutput"], "$.tokensOutput", "non-negative integer");
  if (tokensOutput !== undefined && tokensOutput < 0) {
    throw new SchemaError("$.tokensOutput", "tokensOutput must be >= 0");
  }
  const tokensCached = optional(isInteger, root["tokensCached"], "$.tokensCached", "non-negative integer");
  if (tokensCached !== undefined && tokensCached < 0) {
    throw new SchemaError("$.tokensCached", "tokensCached must be >= 0");
  }
  const retries = optional(isInteger, root["retries"], "$.retries", "non-negative integer");
  if (retries !== undefined && retries < 0) {
    throw new SchemaError("$.retries", "retries must be >= 0");
  }

  return {
    criticId,
    status,
    requiresHumanJudgment,
    reviewer,
    summary,
    findings,
    validation,
    confidence,
    ...(verdict !== undefined ? { verdict } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tokensInput !== undefined ? { tokensInput } : {}),
    ...(tokensOutput !== undefined ? { tokensOutput } : {}),
    ...(tokensCached !== undefined ? { tokensCached } : {}),
    ...(retries !== undefined ? { retries } : {}),
  };
}

function parseCriticError(raw: unknown, path: string): CriticError {
  const obj = need(isObject, raw, path, "object");
  const message = need(isNonEmptyString, obj["message"], `${path}.message`, "non-empty string");
  const retryable = optional(isBoolean, obj["retryable"], `${path}.retryable`, "boolean");
  const rawSamplePath = optional(isString, obj["rawSamplePath"], `${path}.rawSamplePath`, "string");
  // Cycle 322.1 — round-trip optional retry metadata when the artifact
  // was produced by the retry-aware adapter. Older artifacts (no
  // code/retryCount fields) parse identically to before.
  const code = optional(isNonEmptyString, obj["code"], `${path}.code`, "non-empty string");
  const retryCount = optional(isInteger, obj["retryCount"], `${path}.retryCount`, "non-negative integer");
  if (retryCount !== undefined && retryCount < 0) {
    throw new SchemaError(`${path}.retryCount`, "retryCount must be >= 0");
  }
  return {
    message,
    ...(retryable !== undefined ? { retryable } : {}),
    ...(rawSamplePath !== undefined ? { rawSamplePath } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
  };
}

export function parseReviewArtifact(raw: unknown, blockingSeverities: ReviewSeverity[]): ReviewArtifact {
  const root = need(isObject, raw, "$", "object");
  const version = need(isNumber, root["version"], "$.version", "number");
  if (version !== 2) throw new SchemaError("$.version", `expected 2, got ${version}`);
  const status = needEnum(ARTIFACT_STATUSES, root["status"], "$.status");
  const repo = need(isNonEmptyString, root["repo"], "$.repo", "non-empty string");
  const commit = need(isNonEmptyString, root["commit"], "$.commit", "non-empty string");
  const parent = need(isString, root["parent"], "$.parent", "string");
  const range = need(isNonEmptyString, root["range"], "$.range", "non-empty string");
  const diffHash = need(isNonEmptyString, root["diffHash"], "$.diffHash", "non-empty string");
  const artifactScope = needEnum(ARTIFACT_SCOPES, root["artifactScope"], "$.artifactScope");
  const aggregationPolicy = needEnum(
    AGGREGATION_POLICIES,
    root["aggregationPolicy"],
    "$.aggregationPolicy",
  );
  const criticResultsRaw = need(isArray, root["criticResults"], "$.criticResults", "array");
  const criticResults = criticResultsRaw.map((c) => parseCriticResult(c, blockingSeverities));
  const createdAt = need(isNonEmptyString, root["createdAt"], "$.createdAt", "ISO timestamp");
  const updatedAt = optional(isString, root["updatedAt"], "$.updatedAt", "string");
  let gateVerdict: ReviewVerdict | undefined;
  if (status === "complete") {
    gateVerdict = needEnum(REVIEW_VERDICTS, root["gateVerdict"], "$.gateVerdict");
  } else {
    const v = root["gateVerdict"];
    if (v !== undefined && v !== null) {
      gateVerdict = needEnum(REVIEW_VERDICTS, v, "$.gateVerdict");
    }
  }
  const bypass =
    root["bypass"] !== undefined && root["bypass"] !== null
      ? parseBypassRecord(root["bypass"], "$.bypass")
      : undefined;

  // Cycle 332 — optional rangeKind discriminator. Legacy artifacts
  // omit the field; the parser preserves that case (downstream gate
  // dispatch treats "undefined" as "commit" for back-compat).
  const rangeKindRaw = root["rangeKind"];
  let rangeKind: ReviewArtifactRangeKind | undefined;
  if (rangeKindRaw !== undefined && rangeKindRaw !== null) {
    rangeKind = needEnum(REVIEW_ARTIFACT_RANGE_KINDS, rangeKindRaw, "$.rangeKind");
  }

  return {
    version: 2,
    status,
    repo,
    commit,
    parent,
    range,
    diffHash,
    artifactScope,
    aggregationPolicy,
    criticResults,
    createdAt,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(gateVerdict !== undefined ? { gateVerdict } : {}),
    ...(bypass !== undefined ? { bypass } : {}),
    ...(rangeKind !== undefined ? { rangeKind } : {}),
  };
}

// ---------------------------------------------------------------------
// Cycle 332 — finding-cache parser. Used by `finding-cache.ts` to read
// the persisted PR-scoped NDJSON cache. Round-tripping JSON
// (`{header, records}`) produces an identical `FindingCache`. The on-disk
// shape is one JSON document per line (header on line 1, then records).
// The line-by-line read happens in `finding-cache.ts`; this parser
// accepts the in-memory `{header, records}` shape.
// ---------------------------------------------------------------------

export function parseFindingCacheHeader(raw: unknown, path: string = "$.header"): FindingCacheHeader {
  const obj = need(isObject, raw, path, "object");
  const schemaVersion = need(isInteger, obj["schemaVersion"], `${path}.schemaVersion`, "integer");
  if (schemaVersion !== FINDING_CACHE_SCHEMA_VERSION) {
    throw new SchemaError(
      `${path}.schemaVersion`,
      `expected ${FINDING_CACHE_SCHEMA_VERSION}, got ${schemaVersion}`,
    );
  }
  const prNumber = need(isInteger, obj["prNumber"], `${path}.prNumber`, "integer");
  const lastReviewedHeadSha = need(
    isNonEmptyString,
    obj["lastReviewedHeadSha"],
    `${path}.lastReviewedHeadSha`,
    "non-empty string",
  );
  const lastReviewedBaseSha = need(
    isNonEmptyString,
    obj["lastReviewedBaseSha"],
    `${path}.lastReviewedBaseSha`,
    "non-empty string",
  );
  const configHash = need(
    isNonEmptyString,
    obj["configHash"],
    `${path}.configHash`,
    "non-empty string",
  );
  const createdAt = need(
    isNonEmptyString,
    obj["createdAt"],
    `${path}.createdAt`,
    "non-empty string",
  );
  const updatedAt = need(
    isNonEmptyString,
    obj["updatedAt"],
    `${path}.updatedAt`,
    "non-empty string",
  );
  return {
    schemaVersion: FINDING_CACHE_SCHEMA_VERSION,
    prNumber,
    lastReviewedHeadSha,
    lastReviewedBaseSha,
    configHash,
    createdAt,
    updatedAt,
  };
}

function parseFindingCacheSupportingPaths(raw: unknown, path: string): FindingCacheSupportingPath[] {
  const arr = need(isArray, raw, path, "array");
  return arr.map((entry, i) => {
    const obj = need(isObject, entry, `${path}[${i}]`, "object");
    return {
      path: need(isNonEmptyString, obj["path"], `${path}[${i}].path`, "non-empty string"),
      contentHash: need(
        isNonEmptyString,
        obj["contentHash"],
        `${path}[${i}].contentHash`,
        "non-empty string",
      ),
    };
  });
}

function parseFindingCacheFindingRecord(
  raw: unknown,
  path: string,
  blockingSeverities: ReviewSeverity[],
): FindingCacheFindingRecord {
  const obj = need(isObject, raw, path, "object");
  const severity = needEnum(REVIEW_SEVERITIES, obj["severity"], `${path}.severity`);
  const reviewSha = need(isNonEmptyString, obj["reviewSha"], `${path}.reviewSha`, "non-empty string");
  const file = need(isNonEmptyString, obj["file"], `${path}.file`, "non-empty string");
  const contentHashRaw = obj["contentHash"];
  let contentHash: string | null;
  if (contentHashRaw === null) {
    contentHash = null;
  } else {
    contentHash = need(
      isNonEmptyString,
      contentHashRaw,
      `${path}.contentHash`,
      "non-empty string or null",
    );
  }
  const findingFingerprint = need(
    isNonEmptyString,
    obj["findingFingerprint"],
    `${path}.findingFingerprint`,
    "non-empty string",
  );
  const ruleId = need(isNonEmptyString, obj["ruleId"], `${path}.ruleId`, "non-empty string");
  const verdict = needEnum(REVIEW_VERDICTS, obj["verdict"], `${path}.verdict`);
  const evidence = need(isNonEmptyString, obj["evidence"], `${path}.evidence`, "non-empty string");
  const impact = need(isNonEmptyString, obj["impact"], `${path}.impact`, "non-empty string");
  const requiredFix = need(
    isNonEmptyString,
    obj["requiredFix"],
    `${path}.requiredFix`,
    "non-empty string",
  );
  const lineRaw = obj["line"];
  const line = lineRaw === null ? null : need(isInteger, lineRaw, `${path}.line`, "integer or null");
  const symbolRaw = obj["symbol"];
  const symbol = symbolRaw === null ? null : need(isString, symbolRaw, `${path}.symbol`, "string or null");
  const anchorFile = need(
    isNonEmptyString,
    obj["anchorFile"],
    `${path}.anchorFile`,
    "non-empty string",
  );
  const anchorContentHash = need(
    isNonEmptyString,
    obj["anchorContentHash"],
    `${path}.anchorContentHash`,
    "non-empty string",
  );
  const supportingPaths = parseFindingCacheSupportingPaths(
    obj["supportingPaths"] ?? [],
    `${path}.supportingPaths`,
  );
  const firstSeenPush = need(
    isInteger,
    obj["firstSeenPush"],
    `${path}.firstSeenPush`,
    "integer",
  );
  const lastCarriedPush = need(
    isInteger,
    obj["lastCarriedPush"],
    `${path}.lastCarriedPush`,
    "integer",
  );
  // blockingSeverities sanity: blocking-severity records must have a
  // truthful file (preserves review-contract requirement).
  if (blockingSeverities.includes(severity) && !file) {
    throw new SchemaError(`${path}.file`, `blocking severity ${severity} requires file`);
  }
  return {
    kind: "finding",
    reviewSha,
    file,
    contentHash,
    findingFingerprint,
    ruleId,
    severity,
    verdict,
    evidence,
    impact,
    requiredFix,
    line,
    symbol,
    anchorFile,
    anchorContentHash,
    supportingPaths,
    firstSeenPush,
    lastCarriedPush,
  };
}

function parseFindingCacheCleanRecord(raw: unknown, path: string): FindingCacheCleanRecord {
  const obj = need(isObject, raw, path, "object");
  const reviewSha = need(isNonEmptyString, obj["reviewSha"], `${path}.reviewSha`, "non-empty string");
  const file = need(isNonEmptyString, obj["file"], `${path}.file`, "non-empty string");
  const deletionRaw = obj["deletion"];
  const deletion =
    deletionRaw === undefined ? undefined : need(isBoolean, deletionRaw, `${path}.deletion`, "boolean");
  const contentHashRaw = obj["contentHash"];
  let contentHash: string | null;
  if (contentHashRaw === null) {
    contentHash = null;
  } else {
    contentHash = need(
      isNonEmptyString,
      contentHashRaw,
      `${path}.contentHash`,
      "non-empty string or null",
    );
  }
  // Schema invariant: deletion=true records have contentHash=null
  // (absent file has no content to hash); deletion=false (or absent)
  // records have a non-null contentHash.
  if (deletion === true && contentHash !== null) {
    throw new SchemaError(
      `${path}.contentHash`,
      "deletion=true clean record must have contentHash=null",
    );
  }
  if (deletion !== true && contentHash === null) {
    throw new SchemaError(
      `${path}.contentHash`,
      "non-deletion clean record must have non-null contentHash",
    );
  }
  const completedCriticsRaw = need(
    isArray,
    obj["completedCritics"],
    `${path}.completedCritics`,
    "array",
  );
  const completedCritics = completedCriticsRaw.map((c, i) =>
    need(isNonEmptyString, c, `${path}.completedCritics[${i}]`, "non-empty string"),
  );
  const firstSeenPush = need(
    isInteger,
    obj["firstSeenPush"],
    `${path}.firstSeenPush`,
    "integer",
  );
  const lastCarriedPush = need(
    isInteger,
    obj["lastCarriedPush"],
    `${path}.lastCarriedPush`,
    "integer",
  );
  return {
    kind: "clean",
    reviewSha,
    file,
    contentHash,
    ...(deletion !== undefined ? { deletion } : {}),
    completedCritics,
    firstSeenPush,
    lastCarriedPush,
  };
}

export function parseFindingCacheRecord(
  raw: unknown,
  path: string,
  blockingSeverities: ReviewSeverity[],
): FindingCacheRecord {
  const obj = need(isObject, raw, path, "object");
  const kind = obj["kind"];
  if (kind === "finding") {
    return parseFindingCacheFindingRecord(raw, path, blockingSeverities);
  }
  if (kind === "clean") {
    return parseFindingCacheCleanRecord(raw, path);
  }
  throw new SchemaError(`${path}.kind`, `expected "finding" or "clean", got ${JSON.stringify(kind)}`);
}

export function parseFindingCache(
  raw: unknown,
  blockingSeverities: ReviewSeverity[],
): FindingCache {
  const obj = need(isObject, raw, "$", "object");
  const header = parseFindingCacheHeader(obj["header"], "$.header");
  const recordsRaw = need(isArray, obj["records"], "$.records", "array");
  const records = recordsRaw.map((r, i) =>
    parseFindingCacheRecord(r, `$.records[${i}]`, blockingSeverities),
  );
  return { header, records };
}

function parseBypassRecord(raw: unknown, path: string): BypassRecord {
  const obj = need(isObject, raw, path, "object");
  return {
    reason: need(isNonEmptyString, obj["reason"], `${path}.reason`, "non-empty string"),
    at: need(isNonEmptyString, obj["at"], `${path}.at`, "ISO timestamp"),
    ...(obj["user"] !== undefined && obj["user"] !== null
      ? { user: need(isString, obj["user"], `${path}.user`, "string") }
      : {}),
  };
}
