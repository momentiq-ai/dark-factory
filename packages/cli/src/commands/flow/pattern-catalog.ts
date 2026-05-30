// Hardcoded mirror of the 10 PJ-ratified patterns from
// momentiq-ai/sage3c:tools/df-flow-assessor/bootstrap/seed-branch/patterns.yaml.
// The CLI uses these for the `df flow patterns` text output so operators see
// the human description next to the pattern_id, not just the bare slug.
//
// Drift risk: this is hand-copied. If sage3c adds or promotes a pattern, the
// CLI does NOT auto-detect — `df flow patterns` will still surface the new
// pattern (it reads recurrence/<pattern-id>.ndjson) but the description will
// be blank. Tracking issue should refresh this catalog at GA / cycle 333
// follow-up. Until then the assessor's pattern catalog moves slowly enough
// (10 seeded patterns; new promotions require a PJ-merged sage3c PR) that
// stale entries here surface as visible gaps rather than wrong text.

export interface PatternCatalogEntry {
  id: string;
  severity_default: "low" | "medium" | "high" | "critical";
  description: string;
}

export const PATTERN_CATALOG: readonly PatternCatalogEntry[] = [
  {
    id: "iteration-trap-large-doc",
    severity_default: "high",
    description:
      "Multi-round critic loops on documentation PRs where each round introduces new findings on previously-clean surfaces.",
  },
  {
    id: "iteration-trap-large-code",
    severity_default: "high",
    description:
      "Multi-round critic loops on code PRs where each fix introduces new findings.",
  },
  {
    id: "bypass-without-issue-link",
    severity_default: "medium",
    description: "AGENT_REVIEW_BYPASS reason lacks a tracking issue number.",
  },
  {
    id: "critic-finding-regression-on-rebase",
    severity_default: "high",
    description:
      "A fix made to address a critic finding introduced a new finding on the same surface or a related one.",
  },
  {
    id: "bot-review-resolved-without-fix",
    severity_default: "low",
    description: "Review thread marked Resolved via reply (no commit addressing the comment).",
  },
  {
    id: "cycle-doc-trailer-missing",
    severity_default: "medium",
    description: "PR merged without a Cycle/Issue/ProjectItem trailer in any commit.",
  },
  {
    id: "admin-merge-pattern-recurrence",
    severity_default: "high",
    description:
      "Admin-merge used to bypass the merge queue for the same underlying cause more than once.",
  },
  {
    id: "time-to-merge-outlier",
    severity_default: "medium",
    description:
      "PR sat in the queue >24h with no clear blocker visible in CI or review threads.",
  },
  {
    id: "agent-thrash-high-push-count",
    severity_default: "medium",
    description:
      "PR has >5 pushes before merge with no clear architectural pivot recorded in PR comments.",
  },
  {
    id: "incidentally-committed-secret-surfaced",
    severity_default: "critical",
    description:
      "Secret-scrubber Stage-1 sanitizer redacted a value OR Stage-2 gitleaks reported a finding triggering fail-closed.",
  },
];

const PATTERN_INDEX = new Map(PATTERN_CATALOG.map((p) => [p.id, p]));

export function lookupPattern(id: string): PatternCatalogEntry | undefined {
  return PATTERN_INDEX.get(id);
}

export function patternIds(): readonly string[] {
  return PATTERN_CATALOG.map((p) => p.id);
}
