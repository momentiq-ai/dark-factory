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
