// Policy boundary barrel.
//
// Created in Phase D to back the `./policy` subpath export declared
// in `package.json` since Phase B (the subpath pointed at a
// nonexistent index file from Phase B until this commit). All
// policy-layer symbols flow through here.

// Service #2 — Policy Engine (gate.ts is the bulk; aux modules below).
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
} from "./gate.js";
export {
  type TddVerdict,
} from "./tdd-classifier.js";
export {
  resolvePolicyBaseline,
  TRUSTED_SCRIPT_PATHS,
  type PolicyBaseline,
  type ResolveBaselineOptions,
} from "./baseline.js";
export {
  resolveProfile,
  resolveProfileWithConfig,
  applyProfileParamOverrides,
  applyProfileAuth,
  type ResolvedProfile,
} from "./profile.js";
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
} from "./config.js";

// Service #6 — Merge Queue Admission Policy (Phase D boundary).
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
  type PrFile,
  type AgenticEngineerRegistry,
  type PlanPrReview,
  type PlanPrGateInputs,
  type PlanPrGateVerdict,
  type MergeQueueRule,
  type PullRequestRule,
  type RequiredStatusChecksRule,
  type CopilotCodeReviewRule,
  type DeletionRule,
  type NonFastForwardRule,
  type RequiredLinearHistoryRule,
  type RulesetRule,
  type BypassActor,
  type RulesetShape,
} from "./merge-queue.js";
