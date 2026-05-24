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
  runTddClassifier,
  enforceFindingRubric,
  buildRubricContext,
  classifyTdd,
  type EvaluateGateOptions,
  type EvaluatePushGateOptions,
  type EnforceRoutesOptions,
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

// Runner — drives the orchestrator end-to-end.
export {
  runReview,
  runCommitGate,
  type ReviewRunOptions,
  type ReviewRunOutcome,
  type GateRunOptions,
} from "./runner.js";

// Re-export schemas for ergonomic single-import.
export * from "@momentiq/dark-factory-schemas";
