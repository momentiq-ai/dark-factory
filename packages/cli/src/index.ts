// Barrel exports for @momentiq/dark-factory-cli.
// Top-level entry: re-exports the three services and the runner.

// Service #1 — Critic Orchestrator
export * from "./adapters/critic.js";
export * from "./adapters/critic-result-schema.js";

// Service #2 — Policy Engine
export {
  evaluateCommitGate,
  evaluatePushGate,
  evaluateQuorumCriticResults,
  summarizeGate,
  enforceVerificationRoutes,
  planRoutes,
  tableArmedRoutes,
  runTddClassifier,
  enforceFindingRubric,
  buildRubricContext,
  classifyTdd,
  type EvaluateGateOptions,
  type EvaluatePushGateOptions,
  type EnforceRoutesOptions,
  type RoutePlanner,
  type RouteEvaluation,
  type RouteResult,
  type RubricStripContext,
  type RubricResult,
  type StrippedFinding,
  type BuildRubricContextOptions,
  type RunTddClassifierOptions,
  type TddClassifierConfig,
  type TddClassifierResult,
} from "./policy/gate.js";
export {
  classifyTdd as tddClassify,
  type TddClassifierConfig as TddConfig,
  type TddClassifierResult as TddResult,
  type TddVerdict,
} from "./policy/tdd-classifier.js";
export {
  resolvePolicyBaseline,
  TRUSTED_SCRIPT_PATHS,
  type PolicyBaseline,
  type ResolveBaselineOptions,
  // Issue #57 — public surface of `runReview`/`runCommitGate`'s
  // `onPolicyNotice` option; re-exported for symmetry with the other
  // runner-option types above so an embedder can type its callback without
  // reaching into the `./policy` subpath.
  type PolicyNotice,
  type PolicyNoticeLevel,
} from "./policy/baseline.js";
export {
  resolveProfile,
  resolveProfileWithConfig,
  applyProfileParamOverrides,
  applyProfileAuth,
  type ResolvedProfile,
} from "./policy/profile.js";
export {
  loadAgentReviewConfig,
  loadAgentReviewConfigFromRef,
  applyEnvOverrides,
  CONFIG_RELATIVE_PATH,
  POLICY_OVERRIDE_ENV,
  type LoadedConfig,
  type LoadConfigOptions,
  type PolicyOverrideRecord,
  type ApplyEnvOverridesOptions,
  type ApplyEnvOverridesResult,
} from "./policy/config.js";

// Service #3 — Trusted-Surface Rebind
export {
  buildReviewPacket,
  readContainedFiles,
  type BuildPacketOptions,
} from "./trusted-surface/rebind.js";

// Service #4 — Per-SHA Evidence Store (Phase C boundary)
export {
  parseCommitTrailers,
  getTrailer,
  perShaQualityGatePath,
  collectChangedPaths,
  QUALITY_GATES_SUBDIR,
  runQualityGates,
  readQualityGateEvidence,
  type CommitTrailers,
  type QualityGateRunOptions,
  type ReadEvidenceResult,
} from "./evidence/index.js";

// Service #5 — Cycle-Doc Trailer Validator (Phase C — Python-wrapped)
export {
  runValidateCycleDoc,
  getValidateCycleDocScriptPath,
  type ValidateCycleDocOptions,
  type ValidateCycleDocResult,
} from "./cycle-doc-validator/index.js";

// Service #7 — Branch-Protection Drift Detector (Phase C — Python-wrapped)
export {
  runAuditBranchProtection,
  getAuditBranchProtectionScriptPath,
  getBundledDefaultSpecPath,
  type AuditBranchProtectionOptions,
  type AuditBranchProtectionResult,
} from "./branch-protection/index.js";

// Service #9 — Cycle Tracker Sync + PR Attribution (Phase C — Python-wrapped)
export {
  runSyncCycleTrackers,
  runAttributePrCycleRef,
  getSyncCycleTrackersScriptPath,
  getAttributePrCycleRefScriptPath,
  type SyncCycleTrackersOptions,
  type AttributePrCycleRefOptions,
  type PythonScriptResult,
} from "./cycle-tracker-sync/index.js";

// Service #6 — Merge Queue Admission Policy (Phase D boundary).
// Plan-vs-code PR classifier + merge-queue rule shape (the ruleset
// contract that audit_branch_protection.py compares against).
export {
  classifyPrKind,
  classifyPrKindFromFiles,
  resolveChiefEngineerLogin,
  evaluatePlanPrReviewGate,
  defaultMergeQueueRule,
  defaultMainRulesetShape,
  defaultCeReviewRulesetShape,
  PR_PLAN_DOC_PATTERN,
  PR_DOC_ROOT,
  type PrKind,
  type PlanPrGateInputs,
  type PlanPrGateVerdict,
  type MergeQueueRule,
  type RulesetShape,
} from "./policy/merge-queue.js";

// Service #8 — Audit / Compliance Trail (Phase D boundary).
// `_runs.ndjson` sink + read/summarize helpers.
export {
  FileTelemetrySink,
  MemoryTelemetrySink,
  readTelemetryEvents,
  summarizeTelemetry,
  computeQuorumStats,
  computeCriticAgreement,
  type TelemetrySink,
  type TelemetryStats,
  type RetrySummary,
  type CriticStats,
  type CriticAgreement,
  type QuorumStats,
} from "./evidence/audit-trail.js";

// ADR 0001 — bounded lockfile strategy (issue #67).
// Compactor primitives re-exported so consumer code + tests can
// inspect the per-format extractors, default globs, and caps.
export {
  identifyLockfileKind,
  extractFromUnifiedDiff,
  renderDiffStub,
  renderContentStub,
  effectiveMode,
  compactDiff,
  splitDiffByFile,
  DEFAULT_GENERATED_LOCKFILE_GLOBS,
  MAX_COMPACTED_DIFF_BYTES,
  MAX_COMPACTED_CONTENT_BYTES,
  type LockfileKind,
  type CompactedPackageDelta,
  type CompactedLockfileDelta,
  type CompactedContentInput,
  type CompactDiffOutput,
} from "./compact/index.js";

// Runner — drives the orchestrator end-to-end.
export {
  runReview,
  runCommitGate,
  type ReviewRunOptions,
  type ReviewRunOutcome,
  type GateRunOptions,
} from "./runner.js";

// DFP #192 — bundled-skill installer (df skills install / df_skills_install).
// Public API for downstream callers that want to render the templates
// programmatically (e.g. a future `df init` flow that runs install --all).
export {
  installSkill,
  listBundledSkills,
  resolveSkillsRoot,
  KNOWN_SKILLS,
  loadDarkFactoryConfig,
  resolveSkillOverrides,
  enabledSkillNames,
  inferGitOriginOwnerRepo,
  parseGitRemoteOwnerRepo,
  DarkFactoryConfigSchema,
  CONFIG_FILENAME,
  renderTemplateBody,
  extractReferencedVariables,
  type InstallOptions,
  type InstallResult,
  type InstalledFile,
  type ListedSkill,
  type DarkFactoryConfig,
  type LoadedDarkFactoryConfig,
  type ResolveSkillOverridesOptions,
  type SkillManifest,
  type SkillVariableDef,
  type RenderResult,
  type RenderTemplateOptions,
  type VariableOverride,
} from "./skills/index.js";

// Re-export schemas for ergonomic single-import.
export * from "@momentiq/dark-factory-schemas";
