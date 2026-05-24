import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { TelemetryEvent } from "@momentiq/dark-factory-schemas";

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
}

export class FileTelemetrySink implements TelemetrySink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }
  emit(event: TelemetryEvent): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

export class MemoryTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

export interface TelemetryStats {
  totalRuns: number;
  errorRuns: number;
  bypasses: number;
  blocks: number;
  passes: number;
  approvedCount: number;
  changesRequestedCount: number;
  byCritic: Record<string, CriticStats>;
  medianDurationMs: number | null;
  // Cycle 322.1 — retry summary. Counts unique runs (not events) by
  // segmenting on `retryCount` on terminal events. Without this the
  // operator can't tell whether a high `errorRuns` count is one
  // bad commit retried 3 times or three independent commits each
  // failing once — both look the same in the raw NDJSON.
  retry: RetrySummary;
}

export interface RetrySummary {
  // Successful terminal events (`critic_run_finished` with a verdict)
  // segmented by how many retries were needed to get there.
  firstAttemptSuccess: number;
  oneRetrySuccess: number;
  twoPlusRetrySuccess: number;
  // Runs that exhausted the retry budget and ended in error. Indexed
  // by error code where the SDK supplied one; `unknown` captures the
  // codeless fallback.
  exhaustedByErrorCode: Record<string, number>;
  // Total retry attempts observed (sum of `critic_run_error` events
  // that were followed by another attempt) — the operator alert
  // signal for "Cursor regression in progress".
  totalRetryAttempts: number;
}

export interface CriticStats {
  starts: number;
  finishes: number;
  errors: number;
  approved: number;
  changesRequested: number;
  totalFindings: number;
  totalBlockers: number;
  totalHigh: number;
  medianDurationMs: number | null;
}

export function readTelemetryEvents(path: string): TelemetryEvent[] {
  if (!existsSync(path)) return [];
  const out: TelemetryEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as TelemetryEvent);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function summarizeTelemetry(events: TelemetryEvent[]): TelemetryStats {
  const byCritic = new Map<string, CriticStats>();
  const allDurations: number[] = [];
  let totalRuns = 0;
  let errorRuns = 0;
  let bypasses = 0;
  let blocks = 0;
  let passes = 0;
  let approvedCount = 0;
  let changesRequestedCount = 0;

  // Cycle 322.1 — retry counters. Segmented on the `retryCount` field
  // attached to terminal events (`critic_run_finished` for success;
  // the last `critic_run_error` of a run for exhausted-retries).
  // Intermediate `critic_run_error` events (those followed by another
  // attempt of the SAME run) count toward `totalRetryAttempts` and
  // are NOT counted as separate errored runs.
  let firstAttemptSuccess = 0;
  let oneRetrySuccess = 0;
  let twoPlusRetrySuccess = 0;
  const exhaustedByErrorCode: Record<string, number> = {};
  let totalRetryAttempts = 0;
  // Track which `critic_run_error` events were followed by another
  // attempt for the same run vs. were truly terminal. Key:
  // `${criticId}|${commit}` — the tuple that uniquely identifies a
  // single review run from the perspective of telemetry grouping.
  // Within that key, the terminal event is the one with the highest
  // `retryCount`; any earlier event with a smaller `retryCount` was
  // a retry attempt (NOT a terminal error).
  //
  // We deliberately do NOT include `agentId` / `runId` in the key —
  // they're SDK-assigned per-attempt identifiers, so each retry
  // attempt gets its own `agentId` / `runId`. Including them would
  // make every retry hash into its own bucket and break the
  // retry-vs-terminal segmentation. `criticId` + `commit` is the
  // observable identity of a logical run.
  type RunKey = string;
  const errorsByRun = new Map<RunKey, TelemetryEvent[]>();

  function runKey(e: TelemetryEvent): RunKey {
    // commit is the most stable component — pre-322.1 runs without
    // criticId or runId still group by commit. Add criticId to
    // disambiguate the multi-critic future (Cycle 322.2/322.3).
    return `${e.criticId ?? "?"}|${e.commit ?? "?"}`;
  }

  for (const e of events) {
    if (e.event === "critic_run_started" && e.criticId) {
      const stats = ensureStats(byCritic, e.criticId);
      stats.starts++;
      totalRuns++;
    } else if (e.event === "critic_run_finished" && e.criticId) {
      const stats = ensureStats(byCritic, e.criticId);
      stats.finishes++;
      if (e.verdict === "APPROVED") {
        stats.approved++;
        approvedCount++;
      } else if (e.verdict === "CHANGES_REQUESTED") {
        stats.changesRequested++;
        changesRequestedCount++;
      }
      stats.totalFindings += e.findingCount ?? 0;
      stats.totalBlockers += e.blockerCount ?? 0;
      stats.totalHigh += e.highCount ?? 0;
      if (typeof e.durationMs === "number") {
        allDurations.push(e.durationMs);
      }
      const rc = typeof e.retryCount === "number" ? e.retryCount : 0;
      if (rc === 0) firstAttemptSuccess++;
      else if (rc === 1) oneRetrySuccess++;
      else twoPlusRetrySuccess++;
      // NOTE: do NOT increment `totalRetryAttempts` here. The
      // second-pass bucket loop derives the retry count from the
      // intermediate-error events themselves (one per real retry).
      // Adding `rc` here would double-count those same retries. See
      // the bucket loop below for the single source of truth.
    } else if (e.event === "critic_run_error" && e.criticId) {
      const key = runKey(e);
      const bucket = errorsByRun.get(key) ?? [];
      bucket.push(e);
      errorsByRun.set(key, bucket);
    } else if (e.event === "gate_blocked") {
      blocks++;
    } else if (e.event === "gate_passed") {
      passes++;
    } else if (e.event === "gate_bypassed") {
      bypasses++;
    }
  }

  // Second pass: turn per-run error buckets into terminal-error stats
  // without double-counting intermediate retry events. The terminal
  // event for a run is the one with the highest `retryCount` (or the
  // sole event for pre-322.1 runs without retryCount).
  for (const [key, bucket] of errorsByRun) {
    // Sort by retryCount asc; the terminal failure is the last one
    // when retries are exhausted (because the loop never produced a
    // critic_run_finished for this key).
    const criticId = key.split("|", 1)[0];
    const finishedForKey = events.some(
      (e) => e.event === "critic_run_finished" && runKey(e) === key,
    );
    if (finishedForKey) {
      // A finished event exists — every error in this bucket was
      // intermediate (followed by another attempt that succeeded).
      // Count those as retry attempts, NOT errored runs.
      totalRetryAttempts += bucket.length;
      continue;
    }
    // No finished event — the LAST error in the bucket is the
    // terminal failure. Earlier errors are retry attempts.
    bucket.sort((a, b) => (a.retryCount ?? 0) - (b.retryCount ?? 0));
    const terminal = bucket[bucket.length - 1];
    if (!terminal) continue;
    const intermediates = bucket.length - 1;
    if (intermediates > 0) totalRetryAttempts += intermediates;

    if (criticId) {
      const stats = ensureStats(byCritic, criticId);
      stats.errors++;
    }
    errorRuns++;
    const codeKey =
      typeof terminal.errorCode === "string" && terminal.errorCode.length > 0
        ? terminal.errorCode
        : "unknown";
    exhaustedByErrorCode[codeKey] = (exhaustedByErrorCode[codeKey] ?? 0) + 1;
  }

  for (const [criticId, stats] of byCritic) {
    // Per-critic median: filter durations to events from THIS critic only.
    // Earlier loop body destructured `[, stats]` and dropped the criticId,
    // so `durs` collected every critic's durations and assigned the same
    // global median to each entry. (Cycle 3 #10)
    const durs = events
      .filter(
        (e) =>
          e.event === "critic_run_finished" &&
          e.criticId === criticId &&
          typeof e.durationMs === "number",
      )
      .map((e) => e.durationMs as number);
    stats.medianDurationMs = median(durs);
  }

  return {
    totalRuns,
    errorRuns,
    bypasses,
    blocks,
    passes,
    approvedCount,
    changesRequestedCount,
    byCritic: Object.fromEntries(byCritic),
    medianDurationMs: median(allDurations),
    retry: {
      firstAttemptSuccess,
      oneRetrySuccess,
      twoPlusRetrySuccess,
      exhaustedByErrorCode,
      totalRetryAttempts,
    },
  };
}

function ensureStats(map: Map<string, CriticStats>, key: string): CriticStats {
  let s = map.get(key);
  if (!s) {
    s = {
      starts: 0,
      finishes: 0,
      errors: 0,
      approved: 0,
      changesRequested: 0,
      totalFindings: 0,
      totalBlockers: 0,
      totalHigh: 0,
      medianDurationMs: null,
    };
    map.set(key, s);
  }
  return s;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
  }
  return sorted[mid] ?? null;
}

// ---------------------------------------------------------------------------
// Cycle 322.2 Phase F — multi-critic agreement-rate computation.
//
// For each commit where ≥2 critics produced a terminal `critic_run_finished`
// event, compare their verdicts. The eval-comparison artifact (Phase H) is
// the documentation surface; this function is the data source for both the
// CLI's agreement-rate output (in `cmdStats`) and the periodic eval refresh.

export interface CriticAgreement {
  // Total commits seen with ≥2 critics finishing (`comparedCommits`).
  comparedCommits: number;
  // Subset where ALL critics agreed on the verdict.
  agreedCommits: number;
  // Disagreement breakdown. Key is the sorted verdict tuple, formatted
  // as `<criticId>:<verdict> / <criticId>:<verdict>` (joined by " / ").
  // Value is the count of commits with that exact disagreement pattern.
  // Sorting by criticId makes the same disagreement comparable across
  // commits regardless of which critic finished first in the stream.
  disagreementsByPattern: Record<string, number>;
  // The set of critic ids observed across the compared commits (sorted),
  // useful for the CLI heading.
  comparedCriticIds: string[];
}

// Cycle 322.3 — quorum-aware stats for the multi-vendor calibration
// window. The runner emits `aggregateReason` on every
// `review_finished` event regardless of which aggregation policy is
// live. The value is ALWAYS one of "majority" | "veto" |
// "quorum_unmet" (the quorum interpretation of the critic results);
// operators correlate against the artifact's `aggregationPolicy` to
// interpret each value:
//   - Under `min-complete-quorum`: the reason is the actual
//     gate-decision path.
//   - Under `block-if-any` (322.3 default): the reason is the
//     hypothetical quorum outcome — operators see how the gate
//     WOULD behave once 322.3.1 promotes the policy, without
//     flipping the live policy. Calibration metrics aggregate
//     cleanly across the policy-promotion boundary because the
//     field shape doesn't change.
//
// Operators read this block to answer "is the 3-critic config
// reliable enough to switch policy?" — a non-trivial `quorum_unmet`
// count, especially correlated with a single adapter via
// `quorumUnmetByCritic`, means the gate would flap on that
// adapter's outage patterns. That's the actionable calibration
// signal that gates Cycle 322.3.1's promotion decision.
export interface QuorumStats {
  // Total review_finished events with an aggregateReason field.
  totalAggregateEvents: number;
  // Distribution of aggregateReason. Keys are exhaustive per the
  // TelemetryEvent.aggregateReason union.
  byReason: Record<string, number>;
  // Per-critic contribution to `quorum_unmet`: for each review where
  // the aggregate reason was `quorum_unmet`, which critics were in
  // the `errored` completion state. This pinpoints which adapter is
  // responsible for triggering the unmet quorum (e.g., a sustained
  // pattern of cursor:8, gemini:1, grok:0 means Cursor is the
  // dominant failure mode and gates would flap on Cursor outages —
  // exactly the scenario the quorum policy is designed to absorb).
  quorumUnmetByCritic: Record<string, number>;
}

export function computeQuorumStats(events: TelemetryEvent[]): QuorumStats {
  let totalAggregateEvents = 0;
  const byReason: Record<string, number> = {};
  const quorumUnmetByCritic: Record<string, number> = {};
  for (const e of events) {
    if (e.event !== "review_finished") continue;
    const reason = e.aggregateReason;
    if (!reason) continue;
    totalAggregateEvents++;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (reason === "quorum_unmet" && e.criticCompletionStates) {
      for (const [id, state] of Object.entries(e.criticCompletionStates)) {
        if (state === "errored" || state === "pending") {
          quorumUnmetByCritic[id] = (quorumUnmetByCritic[id] ?? 0) + 1;
        }
      }
    }
  }
  return { totalAggregateEvents, byReason, quorumUnmetByCritic };
}

export function computeCriticAgreement(events: TelemetryEvent[]): CriticAgreement {
  // Group `critic_run_finished` events by commit. Within each commit,
  // dedupe on criticId so a retry-success (which may emit one finished
  // event after retries) doesn't double-weight that critic.
  const finishedByCommit = new Map<string, Map<string, "APPROVED" | "CHANGES_REQUESTED">>();
  for (const e of events) {
    if (e.event !== "critic_run_finished") continue;
    if (!e.commit || !e.criticId || !e.verdict) continue;
    let m = finishedByCommit.get(e.commit);
    if (!m) {
      m = new Map();
      finishedByCommit.set(e.commit, m);
    }
    // The LAST verdict wins per (commit, criticId) — successful retries
    // may produce earlier failed-error events, but only the success is
    // tagged with a verdict (failed events have no verdict field).
    m.set(e.criticId, e.verdict);
  }

  let comparedCommits = 0;
  let agreedCommits = 0;
  const disagreementsByPattern: Record<string, number> = {};
  const allCriticIds = new Set<string>();

  for (const verdicts of finishedByCommit.values()) {
    if (verdicts.size < 2) continue;
    comparedCommits++;
    for (const id of verdicts.keys()) allCriticIds.add(id);
    const distinct = new Set(verdicts.values());
    if (distinct.size === 1) {
      agreedCommits++;
      continue;
    }
    // Build a sorted-by-criticId pattern string so the same disagreement
    // (regardless of stream-order) hashes into the same bucket.
    const pattern = [...verdicts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, v]) => `${id}:${v}`)
      .join(" / ");
    disagreementsByPattern[pattern] = (disagreementsByPattern[pattern] ?? 0) + 1;
  }

  return {
    comparedCommits,
    agreedCommits,
    disagreementsByPattern,
    comparedCriticIds: [...allCriticIds].sort(),
  };
}
