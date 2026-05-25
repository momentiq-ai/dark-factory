import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import type { LoadedConfig } from "./policy/config.js";
import {
  artifactJsonPath,
  artifactLockPath,
  artifactMarkdownPath,
  resolveArtifactDir,
} from "./paths.js";
import {
  parseReviewArtifact,
  REVIEW_SEVERITIES,
  type CriticResult,
  type ReviewArtifact,
  type ReviewFinding,
  type ReviewSeverity,
  type ReviewVerdict,
} from "@momentiq/dark-factory-schemas";

export interface AggregateInputs {
  loaded: LoadedConfig;
  commit: string;
  parent: string;
  range: string;
  diffHash: string;
  criticResults: CriticResult[];
  status: ReviewArtifact["status"];
  createdAt: string;
  // Cycle 322.7 — when a profile is active, the runner threads the
  // profile's quorum value here so the persisted `gateVerdict` uses
  // the same effective quorum as the live gate evaluator. Without
  // this, `agent-review status/show` would report CHANGES_REQUESTED
  // from the root quorum while `gate --profile <name>` would pass —
  // a divergence Codex P2 caught on PR #1468.
  quorumOverride?: number;
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  note: 4,
};

export function buildAggregate(inputs: AggregateInputs): ReviewArtifact {
  const { loaded, commit, parent, range, diffHash, criticResults, status, createdAt, quorumOverride } = inputs;
  const repoName = loaded.repoRoot.split("/").pop() ?? loaded.repoRoot;
  const aggregationPolicy = loaded.config.aggregation.policy;
  const blockingSeverities = loaded.config.aggregation.blockingSeverities;

  let gateVerdict: ReviewVerdict | undefined;
  if (status === "complete") {
    gateVerdict = aggregateVerdict(criticResults, blockingSeverities, loaded, quorumOverride);
  }

  const artifact: ReviewArtifact = {
    version: 2,
    status,
    repo: repoName,
    commit,
    parent,
    range,
    diffHash,
    artifactScope: loaded.config.git.artifactScope,
    aggregationPolicy,
    criticResults,
    createdAt,
    ...(gateVerdict !== undefined ? { gateVerdict } : {}),
  };
  return artifact;
}

function aggregateVerdict(
  results: CriticResult[],
  blockingSeverities: ReviewSeverity[],
  loaded: LoadedConfig,
  quorumOverride?: number,
): ReviewVerdict {
  // Cycle 322.3 — dispatch on policy. `min-complete-quorum` uses the
  // quorum aggregator below; everything else falls through to the
  // existing 322.2 `required`-flag-threaded `block-if-any` path.
  if (loaded.config.aggregation.policy === "min-complete-quorum") {
    // Cycle 322.7 — profile.quorum (when supplied) overrides root
    // aggregation.quorum. Without this, a 1-of-2 local profile with
    // one APPROVED + one ERRORED critic would have `gate --profile local`
    // pass (uses quorumOverride=1) but `agent-review status/show`
    // report CHANGES_REQUESTED (uses root quorum=2). Codex P2 caught
    // this divergence on PR #1468.
    const quorum = quorumOverride ?? loaded.config.aggregation.quorum;
    // Schema validation guarantees `quorum` is set when the policy
    // is `min-complete-quorum`; the defensive fallback to 2 is for
    // hand-constructed configs in tests (the parser would already
    // have rejected a real on-disk config without quorum).
    return quorumAggregateVerdict(results, blockingSeverities, quorum ?? 2).verdict;
  }

  // Cycle 322.2 Component 4 — `required` flag threading.
  //
  // Optional (`required: false`) critics produce findings that appear in
  // the artifact for inspection but cannot flip the aggregate verdict to
  // CHANGES_REQUESTED. This implements the §11 "shadow mode" semantics
  // correctly: an optional critic must produce inspectable findings AND
  // disagreement metrics without blocking — anything else makes "shadow
  // mode" a name only.
  //
  // Below-the-line: `required: false` critics are still inspected for
  // disagreement metrics (computed in agent-review-stats), so the
  // calibration window data accumulates even though the gate doesn't
  // block on them.
  const requiredIds = new Set(loaded.config.critics.filter((c) => c.required).map((c) => c.id));
  for (const r of results) {
    if (requiredIds.has(r.criticId) && (r.status === "error" || r.status === "running" || r.status === "pending")) {
      return "CHANGES_REQUESTED";
    }
    if (r.status !== "complete") continue;
    // Optional critics' verdicts / human-judgment / blocking findings are
    // informational only — they cannot flip the aggregate.
    if (!requiredIds.has(r.criticId)) continue;
    if (r.verdict === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
    if (r.requiresHumanJudgment) return "CHANGES_REQUESTED";
    if (hasBlockingFinding(r.findings, blockingSeverities)) return "CHANGES_REQUESTED";
  }
  return "APPROVED";
}

function hasBlockingFinding(findings: ReviewFinding[], blockingSeverities: ReviewSeverity[]): boolean {
  return findings.some((f) => blockingSeverities.includes(f.severity));
}

// ---------------------------------------------------------------------------
// Cycle 322.3 — `min-complete-quorum` aggregation.
//
// Shared with `gate.ts:evaluateQuorumCriticResults` via these
// exports so the verdict and the gate-block enforcement cannot
// drift: any change to the "what counts as a veto" or "what counts
// as completed" semantics lands in one place.
//
// Vocabulary:
//   - **Completed**: `status === "complete"` AND has a verdict
//     (i.e., not pending/running/error). The schema enforces verdict
//     presence on completed results, so this is a single field check.
//   - **Vetoer**: a completed critic that the gate must treat as
//     blocking regardless of vote count. The veto condition is the
//     same as the block-if-any single-critic block trigger:
//     CHANGES_REQUESTED verdict, OR `requiresHumanJudgment`, OR a
//     blocking-severity finding.

/**
 * Cycle 322.3 — does this critic count toward the quorum?
 *
 * Exported for `gate.ts` so the gate evaluator and the verdict
 * computation see the same definition of "completed".
 */
export function isCriticCompleted(r: CriticResult): boolean {
  return r.status === "complete";
}

/**
 * Cycle 322.3 — does this completed critic veto the gate?
 *
 * Manifesto §11 "first principles veto": any rigorous critic with a
 * blocking finding (or `requiresHumanJudgment`, or a
 * CHANGES_REQUESTED verdict) blocks the gate regardless of how many
 * other critics approved. Returns `false` for non-completed critics
 * — only a completed critic can veto.
 */
export function criticVetoesGate(
  r: CriticResult,
  blockingSeverities: ReviewSeverity[],
): boolean {
  if (!isCriticCompleted(r)) return false;
  if (r.verdict === "CHANGES_REQUESTED") return true;
  if (r.requiresHumanJudgment) return true;
  if (hasBlockingFinding(r.findings, blockingSeverities)) return true;
  return false;
}

export interface QuorumAggregateOutcome {
  verdict: ReviewVerdict;
  /**
   * Which gate-decision path drove the verdict. Distinct telemetry
   * value so operators can route alerts differently:
   *   - `veto` — a completed critic raised a blocking finding /
   *     CHANGES_REQUESTED verdict / requiresHumanJudgment. The
   *     manifesto §11 invariant: a single rigorous critic vetoes
   *     regardless of quorum status.
   *   - `majority` — >= quorum critics completed and majority voted
   *     APPROVED (no veto). Ties favor CHANGES_REQUESTED.
   *   - `quorum_unmet` — < quorum critics completed (no veto).
   *     Distinct from a content block: a sustained spike correlated
   *     with `critic_run_error` on adapter X is a vendor-incident
   *     pattern operators page on.
   */
  reason: "majority" | "veto" | "quorum_unmet";
  // For telemetry / `agent-review-stats`: how many critics actually
  // completed (`status === "complete"`). When < quorum and no veto,
  // the gate blocks with `quorum_unmet`.
  completedCount: number;
  totalCount: number;
}

/**
 * Cycle 322.3 — compute the aggregate verdict under
 * `min-complete-quorum`. Pure: takes only the critic results, the
 * blocking severities, and the quorum value; no config / I/O / time
 * dependence. Used by both `aggregateVerdict` (writes the artifact)
 * and `runner.runReview` (emits the `review_finished` telemetry
 * with the reason for downstream alerting).
 *
 * Verdict rules, in priority order:
 *   1. Any completed critic vetoes → CHANGES_REQUESTED, reason `veto`.
 *   2. completedCount >= quorum → majority verdict among completed
 *      critics. Ties favor CHANGES_REQUESTED (conservative).
 *   3. completedCount < quorum → CHANGES_REQUESTED, reason
 *      `quorum_unmet`. (The veto-preserves-quorum semantics in (1)
 *      ensures a single rigorous critic can still block even when
 *      quorum is unmet — §11 invariant.)
 *
 * The "veto wins over quorum_unmet" precedence is the key §11
 * property: an outage that knocks out two critics doesn't paralyze
 * the third critic's BLOCKER finding.
 */
export function quorumAggregateVerdict(
  results: CriticResult[],
  blockingSeverities: ReviewSeverity[],
  quorum: number,
): QuorumAggregateOutcome {
  const completed = results.filter(isCriticCompleted);
  const vetoer = completed.find((r) => criticVetoesGate(r, blockingSeverities));
  if (vetoer) {
    return {
      verdict: "CHANGES_REQUESTED",
      reason: "veto",
      completedCount: completed.length,
      totalCount: results.length,
    };
  }
  if (completed.length < quorum) {
    return {
      verdict: "CHANGES_REQUESTED",
      reason: "quorum_unmet",
      completedCount: completed.length,
      totalCount: results.length,
    };
  }
  // Quorum met and no veto — vote the majority of completed critics.
  // Without veto, every completed critic has APPROVED OR (no verdict
  // — schema impossible, but defensive). Count APPROVED vs other.
  const approveCount = completed.filter((r) => r.verdict === "APPROVED").length;
  const changesCount = completed.length - approveCount;
  // Ties favor CHANGES_REQUESTED (conservative). With 0 changes, all
  // approved → APPROVED. With any changes >= approveCount → CHANGES_REQUESTED.
  // (The veto path above caught CHANGES_REQUESTED via vetoer, so
  // changesCount in practice will be 0 here unless a critic returned
  // CHANGES_REQUESTED with no blocking findings + no requiresHumanJudgment
  // — schema-legal but unusual; we still honor the verdict.)
  const verdict: ReviewVerdict = approveCount > changesCount ? "APPROVED" : "CHANGES_REQUESTED";
  return {
    verdict,
    reason: "majority",
    completedCount: completed.length,
    totalCount: results.length,
  };
}

// ---------------------------------------------------------------------------
// sage3c#2213 — observability: surface per-critic errors + a loud degradation
// warning in the `df critic` CLI output (stdout + $GITHUB_STEP_SUMMARY).
//
// Background: when a critic errors at `review()` time the per-critic
// `error.message`/`error.code` were written ONLY to the per-SHA artifact
// JSON, which is destroyed at CI-runner teardown unless explicitly
// uploaded. The CLI's own stdout printed just `<id>: error — findings=0`,
// so an operator reading the CI log could not recover WHY a critic
// errored. This helper turns the artifact's `criticResults[]` into a
// human-readable report that names each errored critic's message + code
// and shouts when the completed-critic count fell below the total.
//
// PURE: takes only the artifact + the json path; no I/O, no env reads, no
// time. `cmdCritic` writes `.stdout` to stdout and appends `.stepSummary`
// to `$GITHUB_STEP_SUMMARY` (when that env var is set). Kept here, beside
// the verdict logic it mirrors, so the presentation and the gate-decision
// vocabulary cannot drift.
// ---------------------------------------------------------------------------

export interface CriticReport {
  /** Full multi-line block for stdout (CI log + local terminal). */
  stdout: string;
  /**
   * Markdown block for `$GITHUB_STEP_SUMMARY`. Includes the per-critic
   * error detail and the degradation warning so a reader of the run
   * summary (not just the raw step log) sees the failure mode at a
   * glance. Empty string is never returned — there is always at least a
   * verdict line.
   */
  stepSummary: string;
  /** completed (`status === "complete"`) critic count. */
  completedCount: number;
  /** total critic count in the artifact. */
  totalCount: number;
  /** true when `completedCount < totalCount` (the degraded case). */
  degraded: boolean;
}

/**
 * sage3c#2213 — build the per-critic report for `df critic`.
 *
 * `completedCount`/`totalCount` mirror the values
 * `quorumAggregateVerdict` computes (`status === "complete"` is the
 * single completion predicate, identical to `isCriticCompleted`), so the
 * "X/Y critics errored" line agrees with the quorum aggregator's view.
 */
export function buildCriticReport(
  artifact: ReviewArtifact,
  jsonPath: string,
): CriticReport {
  const results = artifact.criticResults;
  const verdict = artifact.gateVerdict ?? "(no verdict)";
  const reviewedSha = artifact.commit;
  const findingCount = results.reduce((acc, r) => acc + r.findings.length, 0);
  const completedCount = results.filter((r) => r.status === "complete").length;
  const totalCount = results.length;
  const degraded = completedCount < totalCount;

  const perCriticLines = results.map(
    (r) =>
      `    ${r.criticId}: ${r.status}` +
      (r.verdict ? ` (${r.verdict})` : "") +
      ` — findings=${r.findings.length}`,
  );

  // Per-critic error detail. `[critic-error]` prefix mirrors the existing
  // `[critic-degraded]` audit-grep convention used by the catch path so
  // operators can grep one family of markers for "a critic didn't run
  // cleanly". Today the CLI only printed the one-line `error — findings=0`
  // status; these lines add the message + code that previously lived
  // ONLY in the artifact JSON (lost at runner teardown without the
  // upload-artifact step).
  const errorLines: string[] = [];
  for (const r of results) {
    if (r.status !== "error") continue;
    const message = r.error?.message ?? "(no error message captured)";
    const code = r.error?.code ? ` [code=${r.error.code}]` : "";
    errorLines.push(`  [critic-error] ${r.criticId}: ${message}${code}`);
  }

  // Loud degradation warning. `completedCount < totalCount` means the
  // verdict was computed from fewer critics than configured — exactly the
  // sage3c#2213 failure shape (3 of 4 errored, verdict from 1). Make it
  // impossible to miss in the run summary.
  const degradationBanner = degraded
    ? `⚠ ${results.length - completedCount}/${totalCount} critics errored — verdict computed from ${completedCount} critic${completedCount === 1 ? "" : "s"}`
    : null;

  const stdoutLines: string[] = [
    `df critic: review complete for ${reviewedSha}`,
    `  verdict: ${verdict}`,
    `  total findings: ${findingCount}`,
    `  per-critic:`,
    ...perCriticLines,
    ...errorLines,
    `  artifact: ${jsonPath}`,
  ];
  if (degradationBanner) {
    stdoutLines.push(degradationBanner);
  }
  stdoutLines.push("");

  // GITHUB_STEP_SUMMARY markdown. Headed so it nests under the job's
  // existing "## agent-critic Summary" section visually. The degradation
  // warning is rendered as a blockquote so GitHub surfaces it prominently.
  const summaryLines: string[] = [
    "### df critic — per-critic results",
    "",
    `- **Verdict:** \`${verdict}\``,
    `- **Critics completed:** ${completedCount}/${totalCount}`,
    `- **Total findings:** ${findingCount}`,
    "",
  ];
  if (degradationBanner) {
    summaryLines.push(`> ${degradationBanner}`, "");
  }
  if (errorLines.length > 0) {
    summaryLines.push("**Per-critic errors:**", "");
    for (const r of results) {
      if (r.status !== "error") continue;
      const message = r.error?.message ?? "(no error message captured)";
      const code = r.error?.code ? ` \`code=${r.error.code}\`` : "";
      summaryLines.push(`- \`${r.criticId}\` — ${message}${code}`);
    }
    summaryLines.push("");
  }

  return {
    stdout: `${stdoutLines.join("\n")}\n`,
    stepSummary: `${summaryLines.join("\n")}\n`,
    completedCount,
    totalCount,
    degraded,
  };
}

export interface WriteResult {
  jsonPath: string;
  // null when markdown render or write failed; the JSON is still authoritative.
  markdownPath: string | null;
}

// JSON is the authoritative gate-input; markdown is a presentation artifact.
// The write order is JSON-first, markdown best-effort, so a broken markdown
// path (e.g., a previously-created directory at the markdown filename) cannot
// turn a successful review into a terminal error via the runner's catch path,
// or leave a pending JSON stuck on disk via writePending. Without best-effort
// markdown handling, the runner's recovery either overwrites the completed
// JSON with status=error (for success-path failures) or skips the recovery
// entirely (for partial-write failures during writePending).
//
// `markdownPath` is `null` when markdown render or write fails so the
// degradation is observable to callers and the CLI — silently swallowing
// the failure while still returning the path would hide artifact-write
// failures from operators.
export async function writeArtifacts(
  loaded: LoadedConfig,
  artifact: ReviewArtifact,
): Promise<WriteResult> {
  const dir = await resolveArtifactDir(loaded);
  mkdirSync(dir, { recursive: true });
  const jsonPath = artifactJsonPath(dir, artifact.commit);
  const markdownPath = artifactMarkdownPath(dir, artifact.commit);
  writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  let writtenMarkdownPath: string | null = null;
  try {
    writeFileSync(markdownPath, renderMarkdown(artifact), "utf8");
    writtenMarkdownPath = markdownPath;
  } catch (err) {
    // Surface the degradation on stderr so operators see it instead of
    // having a silent failure with a returned-but-empty markdown path.
    process.stderr.write(
      `agent-review: markdown render/write failed for ${markdownPath} (${(err as Error).message}); JSON artifact at ${jsonPath} is authoritative.\n`,
    );
  }
  return { jsonPath, markdownPath: writtenMarkdownPath };
}

export async function readArtifact(
  loaded: LoadedConfig,
  commit: string,
): Promise<ReviewArtifact | null> {
  const dir = await resolveArtifactDir(loaded);
  const path = artifactJsonPath(dir, commit);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return parseReviewArtifact(raw, loaded.config.aggregation.blockingSeverities);
}

export function renderMarkdown(artifact: ReviewArtifact): string {
  const lines: string[] = [];
  lines.push(`# Local Critic Review — ${artifact.commit.slice(0, 12)}`);
  lines.push("");
  lines.push(`- **Status:** ${artifact.status}`);
  lines.push(`- **Verdict:** ${artifact.gateVerdict ?? "(pending)"}`);
  lines.push(`- **Range:** ${artifact.range}`);
  lines.push(`- **Diff hash:** ${artifact.diffHash}`);
  lines.push(`- **Aggregation:** ${artifact.aggregationPolicy}`);
  lines.push(`- **Artifact scope:** ${artifact.artifactScope}`);
  lines.push(`- **Created at:** ${artifact.createdAt}`);
  if (artifact.bypass) {
    lines.push(`- **Bypass:** ${artifact.bypass.reason} (at ${artifact.bypass.at})`);
  }
  lines.push("");
  for (const result of artifact.criticResults) {
    lines.push(`## Critic: ${result.criticId} (${result.reviewer.name})`);
    lines.push("");
    lines.push(`- **Adapter:** ${result.reviewer.adapter}`);
    lines.push(`- **Model:** ${result.reviewer.model.id}`);
    lines.push(`- **Runtime:** ${result.reviewer.runtime}`);
    if (result.reviewer.agentId) lines.push(`- **Agent ID:** ${result.reviewer.agentId}`);
    if (result.reviewer.runId) lines.push(`- **Run ID:** ${result.reviewer.runId}`);
    lines.push(`- **Status:** ${result.status}`);
    if (result.verdict) lines.push(`- **Verdict:** ${result.verdict}`);
    lines.push(`- **Confidence:** ${result.confidence}`);
    if (result.requiresHumanJudgment) lines.push(`- **Requires human judgment:** yes`);
    if (typeof result.durationMs === "number") {
      lines.push(`- **Duration:** ${result.durationMs} ms`);
    }
    if (result.error) {
      lines.push(`- **Error:** ${result.error.message}${result.error.retryable ? " (retryable)" : ""}`);
      // Cycle 322.1 — surface the SDK-supplied error code and total
      // retries used so a reader can immediately tell whether the
      // failure was a transient upstream outage (`code:
      // capacity_exceeded, retries: 2`) or a permanent
      // misconfiguration (`code: invalid_api_key, retries: 0`).
      if (result.error.code) {
        lines.push(`- **Error code:** \`${result.error.code}\``);
      }
      if (typeof result.error.retryCount === "number" && result.error.retryCount > 0) {
        lines.push(`- **Retries used:** ${result.error.retryCount}`);
      }
      if (result.error.rawSamplePath) {
        lines.push(`- **Raw sample:** ${result.error.rawSamplePath}`);
      }
    }
    if (result.summary) {
      lines.push("");
      lines.push("### Summary");
      lines.push("");
      lines.push(result.summary);
    }
    lines.push("");
    lines.push("### Findings");
    if (result.findings.length === 0) {
      lines.push("");
      lines.push("_No findings._");
    } else {
      const sorted = [...result.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
      for (const sev of REVIEW_SEVERITIES) {
        const subset = sorted.filter((f) => f.severity === sev);
        if (subset.length === 0) continue;
        lines.push("");
        lines.push(`#### ${sev.toUpperCase()} (${subset.length})`);
        for (const f of subset) {
          lines.push("");
          const tag = f.manifestoSection ? ` ${f.manifestoSection}` : "";
          lines.push(`- **${f.category}${tag}** — \`${f.file ?? "(no file)"}\`${f.line !== undefined ? `:${f.line}` : ""}${f.symbol ? ` (\`${f.symbol}\`)` : ""}`);
          lines.push(`  - Evidence: ${f.evidence}`);
          lines.push(`  - Impact: ${f.impact}`);
          lines.push(`  - Required fix: ${f.requiredFix}`);
        }
      }
    }
    lines.push("");
    lines.push("### Validation evidence consumed");
    if (result.validation.qualityGateResults.length === 0) {
      lines.push("");
      lines.push("_No quality-gate evidence consumed._");
    } else {
      lines.push("");
      lines.push("| Command | Exit | Duration |");
      lines.push("|---------|------|----------|");
      for (const r of result.validation.qualityGateResults) {
        lines.push(`| ${r.command} | ${r.exitCode} | ${r.durationMs} ms |`);
      }
    }
    if (result.validation.qualityGatesMissing.length > 0) {
      lines.push("");
      lines.push(`**Missing required gates:** ${result.validation.qualityGatesMissing.join(", ")}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function writePending(
  loaded: LoadedConfig,
  inputs: Omit<AggregateInputs, "criticResults" | "status">,
): Promise<WriteResult> {
  const artifact = buildAggregate({
    ...inputs,
    criticResults: [],
    status: "pending",
  });
  return writeArtifacts(loaded, artifact);
}


export interface AcquireLockResult {
  acquired: boolean;
  lockPath: string;
}

export async function acquireCommitLock(
  loaded: LoadedConfig,
  commit: string,
): Promise<AcquireLockResult> {
  const dir = await resolveArtifactDir(loaded);
  mkdirSync(dir, { recursive: true });
  const lockPath = artifactLockPath(dir, commit);
  if (existsSync(lockPath)) {
    return { acquired: false, lockPath };
  }
  try {
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, { flag: "wx" });
    return { acquired: true, lockPath };
  } catch {
    return { acquired: false, lockPath };
  }
}

export function releaseCommitLock(lockPath: string): void {
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath);
    }
  } catch {
    // best-effort
  }
}
