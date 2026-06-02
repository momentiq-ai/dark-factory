// Issue dark-factory-platform#112 — in-aggregator self-consistency probe.
//
// One cheap LLM call per blocker|high finding produced by a critic. The
// probe compares the finding's empirical claim against the actual file
// content (or the diff hunk it implicates) and tags the finding as
// `selfInconsistent: true` when the claim fails to hold against the
// evidence. The aggregator (`report.ts`) then consults the
// `unilateralVetoRules.requireCorroborationFor` policy: a finding with
// `selfInconsistent: true` only vetoes the gate when at least one
// OTHER critic raises a blocker|high finding within
// `requireCorroborationOnHunkRadius` lines on the same file. Otherwise
// the finding becomes a `critic_disagreement` note.
//
// This module is the PURE core: take a finding + the file content +
// a probe callable, return a verdict. The runner constructs the probe
// callable using a vendor LLM (defaults to a cheap model — the purpose
// is contradiction detection, not re-judging the diff); tests pass a
// mock probe so the contradiction-bookkeeping is unit-testable without
// network I/O.
//
// Failure semantics (per the spec):
//   - Probe rejects → default to `consistent: true` (do NOT escalate
//     verdict on probe degradation; that's a separate cycle 10
//     critic-observability concern).
//   - Probe returns malformed JSON → same as reject.
//   - Probe times out → same as reject.
//
// Adapters do NOT call this — the runner orchestrates the probe pass
// after `Promise.all(adapter.review())` so the existing adapter contract
// is unchanged. This keeps the probe a deterministic post-step at the
// aggregator boundary.

import type { ReviewFinding } from "@momentiq/dark-factory-schemas";

/**
 * The probe callable. Returns the structured verdict from the
 * lightweight LLM call. Implementations should be relatively cheap
 * (lower-tier model is fine — purpose is contradiction detection, not
 * re-judging the diff). Should throw on transport / parse failures;
 * the caller handles the default-to-consistent fallback.
 */
export type SelfConsistencyProbeFn = (
  input: SelfConsistencyProbeInput,
) => Promise<SelfConsistencyProbeOutput>;

export interface SelfConsistencyProbeInput {
  /** Critic that produced the finding (vendor id for logging). */
  vendor: string;
  /** SHA being reviewed (for the probe prompt + audit log). */
  commitSha: string;
  /**
   * The finding under test. The probe sees the full shape so the LLM
   * has the claim text (`evidence`), the implicated location
   * (`file` + `line`), and the proposed fix (`requiredFix`).
   */
  finding: ReviewFinding;
  /**
   * Content of the file the finding cites, AS OF THE REVIEWED COMMIT.
   * `null` when the file couldn't be loaded (deleted, binary, etc.) —
   * the runner passes `null` to signal "probe can't run from
   * available evidence"; the caller defaults to consistent.
   */
  fileContent: string | null;
}

export interface SelfConsistencyProbeOutput {
  /** True when the LLM judges the finding's empirical claim valid. */
  consistent: boolean;
  /** Short explanation; surfaced in the `critic_disagreement` note. */
  reason: string;
}

export interface SelfConsistencyResult {
  /**
   * The verdict the aggregator should record on the finding. `true`
   * means "the probe found the finding inconsistent with the diff
   * evidence and the finding should be tagged `selfInconsistent:
   * true`". `false` means "consistent OR probe didn't run / failed
   * — leave the finding's `selfInconsistent` unset".
   */
  inconsistent: boolean;
  /**
   * One of:
   *   - "probe_skipped" — finding wasn't eligible (no file, non-blocking
   *     severity); we never invoked the probe.
   *   - "probe_consistent" — probe ran and judged the finding consistent.
   *   - "probe_inconsistent" — probe ran and judged the finding NOT
   *     consistent; finding is tagged.
   *   - "probe_error" — probe rejected or returned malformed output;
   *     default-to-consistent applies.
   *   - "no_evidence" — fileContent was null; probe wasn't invoked.
   */
  reason:
    | "probe_skipped"
    | "probe_consistent"
    | "probe_inconsistent"
    | "probe_error"
    | "no_evidence";
  /**
   * Probe-supplied reason when `probe_inconsistent` or
   * `probe_consistent`; the error message when `probe_error`;
   * `undefined` for `probe_skipped` / `no_evidence`.
   */
  detail?: string;
}

/**
 * Run the self-consistency probe for a single finding. Pure (no I/O,
 * no time): the probe callable is the only side-effect channel and is
 * injected by the caller.
 *
 * Eligibility:
 *   - Finding severity must be in `blockingSeverities` (typically
 *     ["blocker", "high"]). Non-blocking findings can't veto the
 *     gate, so the probe wouldn't change the outcome — skip.
 *   - Finding must have a `file` field. Without a file the probe
 *     can't load evidence — skip.
 *
 * On error, return `inconsistent: false` with `reason: "probe_error"`.
 * The default-to-consistent posture matches the spec (probe degradation
 * is NOT a verdict-flip concern).
 */
export async function runSelfConsistencyProbe(
  finding: ReviewFinding,
  vendor: string,
  commitSha: string,
  blockingSeverities: readonly string[],
  loadFileContent: (path: string) => Promise<string | null>,
  probe: SelfConsistencyProbeFn,
): Promise<SelfConsistencyResult> {
  if (!blockingSeverities.includes(finding.severity)) {
    return { inconsistent: false, reason: "probe_skipped" };
  }
  if (!finding.file) {
    return { inconsistent: false, reason: "probe_skipped" };
  }

  let fileContent: string | null;
  try {
    fileContent = await loadFileContent(finding.file);
  } catch {
    fileContent = null;
  }
  if (fileContent === null) {
    return { inconsistent: false, reason: "no_evidence" };
  }

  let output: SelfConsistencyProbeOutput;
  try {
    output = await probe({
      vendor,
      commitSha,
      finding,
      fileContent,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      inconsistent: false,
      reason: "probe_error",
      detail: message,
    };
  }

  if (typeof output?.consistent !== "boolean") {
    return {
      inconsistent: false,
      reason: "probe_error",
      detail: "probe returned malformed output (missing or non-boolean `consistent`)",
    };
  }

  if (output.consistent) {
    return {
      inconsistent: false,
      reason: "probe_consistent",
      detail: output.reason,
    };
  }
  return {
    inconsistent: true,
    reason: "probe_inconsistent",
    detail: output.reason,
  };
}

/**
 * Tag a finding with the probe's verdict. Returns a NEW finding
 * object (mutation-free, matches the rest of the codebase's
 * pure-aggregator posture). When `inconsistent === false`, returns
 * the input identity (no allocation) so the runner's hot path doesn't
 * churn the GC for the common case.
 */
export function applySelfConsistencyResult(
  finding: ReviewFinding,
  result: SelfConsistencyResult,
): ReviewFinding {
  if (!result.inconsistent) return finding;
  return { ...finding, selfInconsistent: true };
}

/**
 * Build the canonical probe prompt — exported so adapters / tests
 * can render it consistently. Kept short on purpose: the probe is a
 * contradiction detector, not a re-judgement. The model only sees
 * the finding text + the file content; it does NOT see the full
 * critic prompt, diff stat, or guidance files — that's the cost
 * lever (and the contradiction-detection-only scope).
 */
export function buildSelfConsistencyPrompt(input: SelfConsistencyProbeInput): string {
  const fileSection =
    input.fileContent === null
      ? "(file content unavailable)"
      : input.fileContent;
  const line =
    typeof input.finding.line === "number" ? `, line ${input.finding.line}` : "";
  return [
    `Critic "${input.vendor}" on commit ${input.commitSha} returned the following finding against ` +
      `${input.finding.file ?? "(no file)"}${line}:`,
    "",
    `  severity: ${input.finding.severity}`,
    `  category: ${input.finding.category}`,
    `  evidence: ${input.finding.evidence}`,
    `  impact:   ${input.finding.impact}`,
    `  required fix: ${input.finding.requiredFix}`,
    "",
    "File content (as of the reviewed commit):",
    "",
    "```",
    fileSection,
    "```",
    "",
    "Question: does the finding's empirical claim hold against the file content above?",
    "Answer with strict JSON of shape: " +
      `{"consistent": boolean, "reason": "short explanation"}.`,
    "Be conservative — when the claim is genuinely ambiguous, answer `consistent: true`.",
  ].join("\n");
}
