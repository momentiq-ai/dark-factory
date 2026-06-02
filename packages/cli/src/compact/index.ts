// ADR 0001 — bounded lockfile strategy. Barrel for the compact module.
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
} from "./lockfile.js";
