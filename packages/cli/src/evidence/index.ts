// Service #4 — Per-SHA Evidence Store
// Service #8 — Audit / Compliance Trail
//
// Phase C boundary added service #4 (per-SHA quality-gate evidence
// path helpers + the quality-gates runner). Phase D boundary adds
// service #8 (the `_runs.ndjson` audit/compliance trail) — the
// runtime telemetry sink + the read/summarize helpers that back
// `make agent-review-stats` / `df audit stats`.
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

// Cycle 21 (momentiq-ai/dark-factory#185) — the generalized route-runner:
// the producer that runs each armed route's command and writes per-SHA
// QualityGateEvidence under gateResults[routeId] with the 0/1/2 exit-code
// contract (the generalization of the #141 Docker build-evidence shim).
export {
  runRoutes,
  classifyExit,
  type RunRoutesOptions,
  type RouteRunResult,
  type RouteRunSummary,
  type RouteOutcome,
} from "./route-runner.js";

// Docker-build evidence — closes the DFP #141 verification gap (critic
// adapter sandboxes can't reach a Docker socket; the consumer's
// `scripts/check-dockerfile.sh` shim stamps build results here so the
// prompt builder can suppress the requiresHumanJudgment finding pattern
// for verified builds and amplify confirmed failures into [blocker]s).
export {
  readDockerBuildEvidence,
  dockerBuildEvidencePath,
  DOCKER_BUILD_EVIDENCE_FILENAME,
} from "./docker-build.js";

// Service #8 — Audit / Compliance Trail (Phase D boundary).
//
// `_runs.ndjson` is the structural audit log: every critic run, every
// gate verdict, every bypass invocation appends here. Operators read
// it via `df audit stats` (or the legacy `make agent-review-stats`).
//
// The sink classes (FileTelemetrySink, MemoryTelemetrySink) are the
// write side; readTelemetryEvents + summarizeTelemetry +
// computeQuorumStats + computeCriticAgreement are the read/analyze
// side. Keeping them in the same module ensures the schema cannot
// drift between writer and reader.
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
} from "./audit-trail.js";
