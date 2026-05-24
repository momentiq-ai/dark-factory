// Service #4 — Per-SHA Evidence Store
//
// Phase C boundary. Holds the per-SHA quality-gate evidence path helpers
// and the quality-gates runner that writes/reads evidence files at the
// per-SHA path.
//
// Note: `per-sha.ts` currently also exports `parseCommitTrailers` and
// `collectChangedPaths` which logically belong under `policy/` and `git/`
// respectively. Whole-file move is intentional per Phase C extraction
// brief (preserve behavior + minimize import churn). Tracked for cleanup
// in a follow-up tech-debt issue.

export {
  parseCommitTrailers,
  getTrailer,
  perShaQualityGatePath,
  collectChangedPaths,
  QUALITY_GATES_SUBDIR,
  type CommitTrailers,
} from "./per-sha.js";

export {
  runQualityGates,
  readQualityGateEvidence,
  type QualityGateRunOptions,
  type ReadEvidenceResult,
} from "./quality-gates.js";
