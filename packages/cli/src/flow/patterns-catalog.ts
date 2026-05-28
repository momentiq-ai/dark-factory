// 10 PJ-ratified tracked patterns per cycle 333 Decision 4.
// Source of truth: momentiq-ai/sage3c:tools/df-flow-assessor/bootstrap/seed-branch/patterns.yaml
// Keep in sync by hand; the cycle 333 catalog is small and stable.

export const TRACKED_PATTERN_IDS = [
  "iteration-trap-large-doc",
  "iteration-trap-large-code",
  "bypass-without-issue-link",
  "critic-finding-regression-on-rebase",
  "bot-review-resolved-without-fix",
  "cycle-doc-trailer-missing",
  "admin-merge-pattern-recurrence",
  "time-to-merge-outlier",
  "agent-thrash-high-push-count",
  "incidentally-committed-secret-surfaced",
] as const;

export type TrackedPatternId = (typeof TRACKED_PATTERN_IDS)[number];
