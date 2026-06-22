import { setMaxListeners } from "node:events";

import type { LoadedConfig } from "./policy/config.js";
import type { AdapterRegistry, CriticReviewOptions } from "./adapters/critic.js";
import { buildErrorResult } from "./adapters/_shared.js";
import { buildReviewPacket } from "./trusted-surface/rebind.js";
import { collectChangedPaths } from "./evidence/index.js";
import {
  buildRubricContext,
  enforceVerificationRoutes,
  evaluateCommitGate,
  runTddClassifier,
} from "./policy/gate.js";
import { changedFiles, commitDiff, commitParent, diffHash, resolveCommit } from "./git.js";
import { diagnosticsDir, resolveArtifactDir } from "./paths.js";
import { resolvePolicyBaseline, type PolicyNotice } from "./policy/baseline.js";
import {
  applyProfileAuth,
  applyProfileParamOverrides,
  resolveProfileWithConfig,
} from "./policy/profile.js";
import { runQualityGates } from "./evidence/index.js";
import {
  acquireCommitLock,
  buildAggregate,
  quorumAggregateVerdict,
  releaseCommitLock,
  writeArtifacts,
  writePending,
  type WriteResult,
} from "./report.js";
import {
  applySelfConsistencyResult,
  runSelfConsistencyProbe,
  type SelfConsistencyProbeFn,
} from "./self-consistency.js";
import { gitShowFile } from "./git.js";
// Service #8 — Audit Trail (Phase D boundary). Telemetry sink is the
// runtime side of the `_runs.ndjson` audit log; the read/analyze side
// lives in the same module so they evolve in lockstep.
import type { TelemetrySink } from "./evidence/audit-trail.js";
import type {
  CriticConfig,
  CriticResult,
  GateBlock,
  GateResult,
  ReviewArtifact,
  ReviewPacket,
  TelemetryEvent,
} from "@momentiq/dark-factory-schemas";

export interface ReviewRunOptions {
  loaded: LoadedConfig;
  registry: AdapterRegistry;
  ref?: string;
  cwd?: string;
  telemetry?: TelemetrySink;
  signal?: AbortSignal;
  // Cycle 322.7 — caller-supplied resolved profile name. The runner
  // looks this up in `loaded.config.profiles` to filter `critics[]`
  // and override `aggregation.quorum`. When undefined OR when the
  // loaded config has no `profiles` map, the runner takes the
  // back-compat path (full critic list, root quorum). When the
  // config HAS profiles but the name doesn't match, the runner
  // throws — a mistyped profile name should fail loudly. The CLI
  // resolves the name via `resolveProfile()` (precedence flag > env
  // > "local") and passes it here; tests pass it directly.
  profileName?: string;
  // Issue #56 — when true, the caller-injected `loaded` config is the
  // authoritative gate config: the self-modification baseline guard does NOT
  // re-read the parent ref when this commit touches the trusted policy surface
  // (`.agent-review/**` etc.). This is for embedding/hosted callers (the W3
  // worker) that inject `loaded` out-of-band; the customer's committed config
  // has no authority over the injected gate. Default false: the CLI's own
  // `df review` never sets it. See `ResolveBaselineOptions.injectedConfigAuthoritative`.
  injectedConfigAuthoritative?: boolean;
  // Issue #57 — structured sink for the trusted-surface self-modification
  // notices emitted by the policy-baseline guard. Each notice carries a
  // `level` (info | warn). When omitted, the guard writes to process.stderr
  // (CLI back-compat). A hosted embedder passes a sink that maps level → its
  // own structured logger so the benign info notice doesn't land at
  // severity:ERROR. See `ResolveBaselineOptions.notify`.
  onPolicyNotice?: (notice: PolicyNotice) => void;
  // Issue dark-factory-platform#112 — optional self-consistency probe.
  // When supplied, the runner runs one cheap LLM call per blocker|high
  // finding (after `Promise.all(adapter.review())`) to detect findings
  // whose empirical claim does NOT hold against the implicated file.
  // Findings the probe judges inconsistent are tagged
  // `selfInconsistent: true`; the aggregator's
  // `unilateralVetoRules.requireCorroborationFor` policy then decides
  // whether the demoted finding still vetoes or becomes a
  // `critic_disagreement` note. When omitted the runner skips the
  // probe entirely (back-compat — adapters never produced the tag
  // themselves; the probe is the sole writer). Pure injectable so
  // tests and operators-without-keys can run normally.
  selfConsistencyProbe?: SelfConsistencyProbeFn;
}

export interface ReviewRunOutcome {
  artifact: ReviewArtifact;
  paths: WriteResult;
  packet: ReviewPacket;
  acquired: boolean;
}

// Issue #29 — the EventTarget max-listener cap on the shared AbortSignal.
//
// `runReview` fans `reviewOptions.signal` out to N critic adapters via
// `Promise.all`; each adapter's SDK call (Cursor, Codex, Gemini, Grok, the
// undici-backed `fetch` inside the OpenAI SDK) attaches one or more abort
// listeners to that signal. With 4 critics × up-to-3 retry attempts × 1–2
// SDK-internal listeners each, the count crosses the EventTarget cap that
// undici primes to `defaultMaxListeners` (10) on first fetch. The 11th
// listener triggers a `MaxListenersExceededWarning` — informational, but
// it surfaced right at the workflow's old 10m boundary and read as a flake
// to operators. Bound the worst case at 4 critics × (3 retries + sleep
// listener + cursor-cli kill-handler) × 2x safety factor = 64.
const CRITIC_SIGNAL_MAX_LISTENERS = 64;

// Resolve the AbortSignal `runReview` will thread through to adapters AND
// quality-gate subprocesses. Precedence:
//   1. Caller-supplied `options.signal` — the embedding worker (W3) owns
//      cancellation and may already have its own deadline; we never override
//      that signal, only adopt it.
//   2. CLI-internal deadline from `DF_CRITIC_TIMEOUT_MS` — the workflow
//      wires this env to a value STRICTLY LESS than the job's
//      `timeout-minutes`, so the CLI aborts its own work and surfaces a
//      structured `error` CriticResult (degrade-and-pass under
//      `min-complete-quorum`) instead of being killed by the runner's
//      job-level timeout (issue #29).
//   3. Unbounded — older sage3c posture; the workflow's job timeout is
//      the only deadline.
//
// In every branch we call `setMaxListeners(CRITIC_SIGNAL_MAX_LISTENERS,
// signal)` so the per-critic SDK listener accumulation can never re-trip
// `MaxListenersExceededWarning`. Returns the `cleanup` thunk the caller
// MUST invoke in `finally` to clear the internal timer (no-op when no
// internal timer was created).
//
// Issue #180 — also returns `internalDeadlineMs`: the `DF_CRITIC_TIMEOUT_MS`
// value WHEN (and only when) the runner created its OWN internal deadline.
// It is `undefined` whenever the caller supplied their own signal OR no
// internal deadline was created (env unset / invalid). The per-critic
// deadline race (see `dispatchWithDeadline`) is armed ONLY when this is set,
// so today's behavior is preserved for callers that own cancellation or that
// run unbounded.
function resolveEffectiveSignal(callerSignal: AbortSignal | undefined): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
  internalDeadlineMs?: number;
} {
  if (callerSignal !== undefined) {
    setMaxListeners(CRITIC_SIGNAL_MAX_LISTENERS, callerSignal);
    return { signal: callerSignal, cleanup: () => {} };
  }
  const raw = process.env["DF_CRITIC_TIMEOUT_MS"];
  if (!raw) return { signal: undefined, cleanup: () => {} };
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    // A non-numeric or non-positive value is operator error; falling back
    // to "no internal deadline" preserves the prior posture rather than
    // tripping a confusing parse failure inside the runner's hot path.
    return { signal: undefined, cleanup: () => {} };
  }
  const controller = new AbortController();
  setMaxListeners(CRITIC_SIGNAL_MAX_LISTENERS, controller.signal);
  const timer = setTimeout(() => controller.abort(), ms);
  // `unref` lets Node exit if everything else has settled. The
  // `cleanup` thunk clears the timer on the success path so the
  // process doesn't sit waiting for the deadline that already passed.
  if (typeof timer.unref === "function") timer.unref();
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
    internalDeadlineMs: ms,
  };
}

// Issue #180 — derive the per-critic hard deadline from the runner's
// internal `DF_CRITIC_TIMEOUT_MS` abort deadline. This is the LAST-RESORT
// settlement guarantee that covers a genuinely-wedged adapter — one whose
// `review()` promise never settles because it ignores `options.signal` (e.g.
// a stalled vendor stream that never calls `run.cancel()`, or a spawned
// subprocess not wired to the abort controller). Without it, ONE such
// promise stalls `Promise.all` forever → `runReview()` never returns →
// `main()` never resolves → the `#167` `finalizeExit` backstop never arms →
// the process runs to the 20m GHA job clamp and is killed as an orphan,
// dequeuing the PR.
//
// Ordering invariant (load-bearing): the internal 15m abort deadline fires
// FIRST, giving a well-behaved adapter the chance to honor `options.signal`
// and emit its OWN structured error (`degrade-and-pass`); only a wedged
// adapter that ignored the abort reaches this generic per-critic deadline.
// The deadline must therefore sit STRICTLY BETWEEN the 15m abort and the 20m
// job clamp: 15m < per-critic deadline < 20m.
//
// The grace SHRINKS WITH the base deadline — `min(grace, base)` — for two
// reasons: (1) in production (base 900_000ms = 15m) it adds the full 30s
// grace → 930_000ms = 15.5m, which satisfies 15m < 15.5m < 20m; (2) under a
// LOW test deadline (e.g. base 100ms) it caps the grace at the base so the
// per-critic deadline still fires near-instantly (200ms) — a fixed +30s
// grace would make the deadline un-observable inside a unit test's default
// timeout.
const PER_CRITIC_DEADLINE_GRACE_MS = 30_000;

export function computePerCriticDeadlineMs(internalDeadlineMs: number): number {
  return internalDeadlineMs + Math.min(PER_CRITIC_DEADLINE_GRACE_MS, internalDeadlineMs);
}

// Issue #180 — structured error `code` stamped on a CriticResult when the
// per-critic deadline fires. Discriminable from transport/auth/transient
// failures (and from the 15m abort path) in `_runs.ndjson` and `df stats`.
export const CRITIC_DEADLINE_EXCEEDED_CODE = "critic_deadline_exceeded";

// Issue #180 — per-critic heartbeat cadence. The wedged run that motivated
// this fix emitted ZERO per-critic output for the full 20m before the clamp
// killed it, so an operator could not tell WHICH adapter blocked. A minute-N
// "still running" log per critic (plus the `::warning::` on deadline-fire)
// closes that blind spot. The heartbeat is stderr-log-only (a GHA `::notice::`
// annotation) so it adds no schema surface and changes no control flow.
const PER_CRITIC_HEARTBEAT_INTERVAL_MS = 60_000;

// Issue #180 — wrap a single `adapter.review(...)` in a `Promise.race`
// against a deadline that RESOLVES (never rejects) to a structured-error
// CriticResult. On a deadline win the aggregate still settles, so
// `Promise.all` resolves, `runReview()` returns, `main()` resolves, and the
// `#167` `finalizeExit` backstop arms and force-exits the wedged process.
//
// The heartbeat interval and the deadline timer are BOTH cleared on settle —
// AND `unref`'d at creation — so (a) a healthy adapter that settles fast
// leaves no pending timer holding the event loop open, and (b) a wedged
// sibling's timer can't keep the whole `Promise.all` alive after the others
// resolve. Defense in depth: even if a settle path were missed, the `unref`
// keeps the timers from blocking process exit.
//
// The deadline-fire is reported via the EXISTING `critic_run_error` telemetry
// event (a deadline IS a per-critic run error) carrying `status:
// "deadline_exceeded"` and the structured `errorCode` — so no new schema
// surface is introduced. Pure aside from the optional `emit` and the
// `process.stderr` annotations; the review promise itself is untouched.
export function dispatchWithDeadline(args: {
  reviewPromise: Promise<CriticResult>;
  critic: CriticConfig;
  deadlineMs: number;
  emit?: (event: TelemetryEvent) => void;
  commit: string;
  // Injectable clock so tests can compute the heartbeat's minute-N without
  // wall-clock drift. Defaults to `Date.now`.
  now?: () => number;
}): Promise<CriticResult> {
  const startMs = (args.now ?? Date.now)();
  let heartbeat: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;

  const clear = (): void => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (deadline !== undefined) clearTimeout(deadline);
  };

  // Heartbeat: a "still running at minute-N" GHA annotation per critic.
  // Diagnostic only — no control-flow effect, no telemetry-schema surface.
  heartbeat = setInterval(() => {
    const elapsedMs = (args.now ?? Date.now)() - startMs;
    const minute = Math.round(elapsedMs / 60_000);
    process.stderr.write(
      `::notice::df critic: "${args.critic.id}" still running at minute ${minute}\n`,
    );
  }, PER_CRITIC_HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const deadlinePromise = new Promise<CriticResult>((resolveDeadline) => {
    deadline = setTimeout(() => {
      const message = `${args.critic.id} exceeded per-critic deadline (${args.deadlineMs}ms); degraded`;
      // `::warning::` names the wedged critic in the GHA log — the run that
      // motivated #180 had no way to attribute the hang to a critic.
      process.stderr.write(`::warning::df critic: ${message}\n`);
      args.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: args.commit,
        criticId: args.critic.id,
        adapter: args.critic.adapter,
        model: args.critic.model.id,
        durationMs: args.deadlineMs,
        error: message,
        status: "deadline_exceeded",
        errorCode: CRITIC_DEADLINE_EXCEEDED_CODE,
      });
      resolveDeadline(
        buildErrorResult({
          critic: args.critic,
          message,
          retryable: false,
          code: CRITIC_DEADLINE_EXCEEDED_CODE,
        }),
      );
    }, args.deadlineMs);
    if (typeof deadline.unref === "function") deadline.unref();
  });

  return Promise.race([args.reviewPromise, deadlinePromise]).finally(clear);
}

export async function runReview(options: ReviewRunOptions): Promise<ReviewRunOutcome> {
  const { registry } = options;
  const cwd = options.cwd ?? options.loaded.repoRoot;
  const ref = options.ref ?? "HEAD";
  const sha = await resolveCommit(ref, cwd);
  const {
    signal: effectiveSignal,
    cleanup: cleanupSignal,
    internalDeadlineMs,
  } = resolveEffectiveSignal(options.signal);
  // Issue #180 — the per-critic deadline is armed ONLY when the runner
  // created its OWN internal deadline (env-driven `DF_CRITIC_TIMEOUT_MS`,
  // no caller signal). When a caller supplied their own signal, or no
  // timeout is set, `internalDeadlineMs` is undefined and dispatch behaves
  // exactly as it did before (the caller / embedder owns cancellation).
  const perCriticDeadlineMs =
    internalDeadlineMs !== undefined
      ? computePerCriticDeadlineMs(internalDeadlineMs)
      : undefined;

  // Self-modification guard across the whole trusted policy surface
  // (config + guidance files + prompt fragments). See `policy-baseline.ts`.
  // `injectedConfigAuthoritative` (Issue #56) lets a hosted embedder declare
  // its injected `loaded` config the baseline, skipping the parent-ref re-read.
  const baseline = await resolvePolicyBaseline({
    loaded: options.loaded,
    sha,
    cwd,
    ...(options.injectedConfigAuthoritative !== undefined
      ? { injectedConfigAuthoritative: options.injectedConfigAuthoritative }
      : {}),
    ...(options.onPolicyNotice !== undefined ? { notify: options.onPolicyNotice } : {}),
  });
  const loaded = baseline.loaded;

  const lock = await acquireCommitLock(loaded, sha);
  if (!lock.acquired) {
    throw new Error(
      `another agent-review is already in progress for commit ${sha} (lock at ${lock.lockPath}). Wait for it to finish or remove the lock if stale.`,
    );
  }

  // Issue #105 — signal-killed processes bypass `finally` and orphan the
  // lock. The guard wires SIGTERM/SIGINT to release-then-exit; uninstall
  // in `finally` so the listeners don't leak across programmatic re-runs.
  const signalGuard = installSignalLockGuard(lock.lockPath);

  // Wrap EVERYTHING after lock acquisition in try/finally so the lock is
  // always released — even on early failures from runQualityGates,
  // buildReviewPacket, writePending, or any critic promise rejection.
  // Without this, an exception during preparation leaves a stale `.lock`
  // file that permanently blocks future reviews of the same SHA. (Cycle 3 #6)
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let packet: ReviewPacket | undefined;
  let paths: WriteResult | undefined;
  let artifact: ReviewArtifact | undefined;
  try {
    // Honor `runBeforeReview`: when true, run the configured required quality
    // gates synchronously before invoking the critic. The result file is
    // picked up by `buildReviewPacket` → `readValidationEvidence`, so the
    // packet carries fresh deterministic evidence. Without this, the flag was
    // dead and operators always had to attach evidence by hand.
    if (loaded.config.validation.runBeforeReview) {
      await runQualityGates({
        loaded,
        commit: sha,
        cwd,
        ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
      });
    }

    packet = await buildReviewPacket(loaded, {
      ref: sha,
      cwd,
      ...(baseline.baselineRef !== undefined ? { trustedSurfaceRef: baseline.baselineRef } : {}),
    });

    await writePending(loaded, {
      loaded,
      commit: sha,
      parent: packet.commit.parent,
      range: packet.range,
      diffHash: packet.diffHash,
      createdAt: startedAt,
    });

    const sink = options.telemetry;

    // ADR 0001 § 2.5 — emit compacted_files when the bounded
    // lockfile strategy fired. The packet builder owns the
    // compaction logic; the runner owns the TelemetrySink, so the
    // event-emission lives here (round-3 cursor boundaries
    // finding). Detect the strategy fired by the presence of
    // packet.compactedDiff plus at least one ChangedFile with
    // compactedContent.
    if (packet.compactedDiff !== undefined) {
      const compactedFiles = packet.changedFiles.filter(
        (f) => f.compactedContent !== undefined,
      );
      if (compactedFiles.length > 0) {
        // Identify lockfile kind from the path for the per-file map.
        // Re-import is fine — this is a stable utility on the
        // compact module's public surface.
        const { identifyLockfileKind } = await import("./compact/index.js");
        const perFile: Record<string, string> = {};
        for (const f of compactedFiles) {
          const kind = identifyLockfileKind(f.path);
          perFile[f.path] = kind ?? "unknown";
        }
        emit(sink, {
          ts: new Date().toISOString(),
          event: "compacted_files",
          commit: sha,
          findingCount: compactedFiles.length,
          perFileCounts: JSON.stringify(perFile),
        });
      }
    }

    // Cycle 322.7 Phase C — Emergency revert audit trail. When the
    // config-load path applied `AGENT_REVIEW_AGGREGATION_POLICY`, it
    // populated `loaded.policyOverride` with the audit record. Emit
    // the matching `aggregation_policy_overridden` event so the
    // run's NDJSON timeline captures the override + any auto-promoted
    // critics. Fires BEFORE profile_selected so the audit ordering is
    // "policy override → profile selection → review_started → critic
    // runs → review_finished".
    if (loaded.policyOverride) {
      emit(sink, {
        ts: new Date().toISOString(),
        event: "aggregation_policy_overridden",
        commit: sha,
        configured: loaded.policyOverride.configured,
        overridden: loaded.policyOverride.overridden,
        autoPromotedCritics: loaded.policyOverride.autoPromotedCritics,
      });
    }

    // Cycle 322.7 — Profile resolution. The caller has already
    // applied --profile / AGENT_REVIEW_PROFILE precedence and passed
    // the resolved name. Look it up against the loaded config:
    //   - If config has no `profiles` map → back-compat: profile is
    //     undefined, full critic list, root aggregation.quorum.
    //   - If config HAS `profiles` and name matches → filter critics
    //     to profile.criticIds, override aggregation quorum, emit
    //     profile_selected telemetry.
    //   - If config HAS `profiles` and name doesn't match → throw a
    //     clear error (resolveProfileWithConfig handles this).
    //
    // profile_selected fires BEFORE review_started so the timeline
    // operators see in telemetry has "selection happens before run".
    const resolvedProfile = options.profileName
      ? resolveProfileWithConfig(loaded.config, options.profileName)
      : undefined;
    const activeCritics = resolvedProfile?.criticIds
      ? loaded.config.critics.filter((c) => resolvedProfile.criticIds!.includes(c.id))
      : loaded.config.critics;
    if (resolvedProfile?.profile) {
      emit(sink, {
        ts: new Date().toISOString(),
        event: "profile_selected",
        commit: sha,
        profile: resolvedProfile.profileName,
        criticIds: resolvedProfile.profile.criticIds,
        quorum: resolvedProfile.profile.quorum,
      });
    }

    emit(sink, {
      ts: startedAt,
      event: "review_started",
      commit: sha,
    });

    const adapterDiagnosticsDir = diagnosticsDir(await resolveArtifactDir(loaded));

    const reviewOptions: CriticReviewOptions = {
      blockingSeverities: loaded.config.aggregation.blockingSeverities,
      diagnosticsDir: adapterDiagnosticsDir,
      ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
      ...(sink !== undefined ? { emit: (e: TelemetryEvent) => sink.emit(e) } : {}),
    };

    // Cycle 322.8 — apply profile-scoped modelParamOverrides BEFORE
    // dispatching to adapters. Identity (same reference) when no
    // override applies to a critic; otherwise a clone with the
    // overridden params. Adapters see the resolved critic via their
    // existing `critic.model.params` surface — no adapter-side change.
    //
    // Issue #2103 — chain `applyProfileAuth` AFTER `applyProfileParamOverrides`.
    // Both are pure and commute (no field overlap), so order is only a
    // convention; documenting it makes the pipeline reviewable.
    const requiredCritics = activeCritics.map((c) =>
      applyProfileAuth(
        applyProfileParamOverrides(c, resolvedProfile?.profile),
        resolvedProfile?.profile,
      ),
    );
    const rawResults: CriticResult[] = await Promise.all(
      requiredCritics.map(async (critic) => {
        if (!registry.has(critic.adapter)) {
          return {
            criticId: critic.id,
            status: "error",
            requiresHumanJudgment: false,
            reviewer: {
              name: critic.name,
              adapter: critic.adapter,
              model: critic.model,
              runtime: critic.runtime,
            },
            summary: `no adapter registered for "${critic.adapter}"`,
            findings: [],
            validation: { qualityGateResults: [], qualityGatesMissing: [] },
            confidence: "unknown",
            error: { message: `no adapter registered for "${critic.adapter}"`, retryable: false },
          };
        }
        const adapter = registry.resolve(critic.adapter);
        const reviewPromise = adapter.review(packet!, critic, reviewOptions);
        // Issue #180 — last-resort per-critic settlement guarantee. When the
        // runner armed its own internal deadline, race each adapter's
        // `review()` against a hard per-critic deadline that RESOLVES to a
        // structured `critic_deadline_exceeded` error. A genuinely-wedged
        // adapter (one that ignores `options.signal`) can no longer stall
        // `Promise.all` forever; the aggregate settles, `runReview()` returns,
        // and the `#167` `finalizeExit` backstop arms. A well-behaved adapter
        // honors the 15m abort and emits its own structured error well before
        // this generic deadline (15m abort < per-critic deadline < 20m clamp).
        if (perCriticDeadlineMs === undefined) return reviewPromise;
        return dispatchWithDeadline({
          reviewPromise,
          critic,
          deadlineMs: perCriticDeadlineMs,
          commit: sha,
          ...(sink !== undefined ? { emit: (e: TelemetryEvent) => sink.emit(e) } : {}),
        });
      }),
    );

    // Issue dark-factory-platform#112 — self-consistency probe pass.
    // Runs ONLY when both (a) the caller supplied a probe callable AND
    // (b) the active aggregation policy declares a corroboration rule
    // listing flag(s) the probe knows how to populate. Skipping when
    // the policy is absent avoids spending tokens on a tag the
    // aggregator wouldn't act on. The probe is bounded per critic +
    // per finding by `runSelfConsistencyProbe`'s eligibility guards
    // (non-blocking severity → skip; no file → skip; loadFileContent
    // null → skip without an LLM call).
    const probeApplies =
      options.selfConsistencyProbe !== undefined &&
      loaded.config.aggregation.unilateralVetoRules?.requireCorroborationFor.includes(
        "self_inconsistent",
      ) === true;
    const results: CriticResult[] = probeApplies
      ? await Promise.all(
          rawResults.map(async (r) =>
            applyProbePassToCritic(r, sha, cwd, options.selfConsistencyProbe!, loaded, sink),
          ),
        )
      : rawResults;

    const finishedAt = new Date().toISOString();
    artifact = buildAggregate({
      loaded,
      commit: sha,
      parent: packet.commit.parent,
      range: packet.range,
      diffHash: packet.diffHash,
      criticResults: results,
      status: "complete",
      createdAt: startedAt,
      // Cycle 322.7 — thread profile quorum so the persisted artifact's
      // gateVerdict uses the same effective quorum as the runtime gate
      // evaluator (Codex P2 on PR #1468).
      ...(resolvedProfile?.quorum !== undefined
        ? { quorumOverride: resolvedProfile.quorum }
        : {}),
    });
    artifact.updatedAt = finishedAt;

    paths = await writeArtifacts(loaded, artifact);

    // Cycle 322.3 — populate quorum-aware telemetry on review_finished
    // even when the live config policy is still `block-if-any`. This
    // lets operators inspect the calibration-window data: how would
    // the gate behave under quorum, today? The artifact's actual
    // gateVerdict still reflects the live policy; `aggregateReason`
    // is always the quorum interpretation (one of "majority", "veto",
    // "quorum_unmet").
    //
    // The reason that the field is ALWAYS the quorum interpretation
    // (instead of "block-if-any" sometimes) addresses Cursor critic
    // 367476d3 finding #2 (observability, §5): under the live
    // block-if-any policy, operators need to count would-be
    // `majority` / `veto` outcomes across the calibration window —
    // not just `quorum_unmet`. The active policy is encoded in the
    // artifact's `aggregationPolicy` field; operators correlate
    // `aggregateReason` against that to interpret the value (live
    // gate-decision path vs. hypothetical 322.3.1 outcome).
    const criticVerdicts: Record<string, "APPROVED" | "CHANGES_REQUESTED"> = {};
    const criticCompletionStates: Record<string, "completed" | "errored" | "pending"> = {};
    for (const r of results) {
      if (r.verdict !== undefined) {
        criticVerdicts[r.criticId] = r.verdict;
      }
      criticCompletionStates[r.criticId] =
        r.status === "complete"
          ? "completed"
          : r.status === "error"
            ? "errored"
            : "pending";
    }
    // Cycle 322.7 — when a profile is active, profile.quorum
    // overrides root aggregation.quorum for the aggregateReason
    // computation. Under back-compat (no profile), fall back to the
    // 322.3 logic: root quorum on min-complete-quorum, hypothetical
    // quorum=2 on block-if-any (so calibration metrics still surface).
    const quorum =
      resolvedProfile?.quorum ??
      (loaded.config.aggregation.policy === "min-complete-quorum"
        ? (loaded.config.aggregation.quorum ?? 2)
        : 2);
    // Issue dark-factory-platform#112 — thread the optional
    // `unilateralVetoRules` so the `aggregateReason` telemetry value
    // matches the artifact verdict (both now honor corroboration).
    const quorumOutcome = quorumAggregateVerdict(
      results,
      loaded.config.aggregation.blockingSeverities,
      quorum,
      loaded.config.aggregation.unilateralVetoRules,
    );
    const aggregateReason = quorumOutcome.reason;

    // Cursor finding (runner.ts:465) — emit one `critic_disagreement`
    // event per demotion so operators auditing `_runs.ndjson` can
    // grep the demotion stream during the review run. Without this,
    // demotion visibility depends on later gate evaluation and the
    // per-decision audit pattern documented for #112 is broken.
    for (const note of quorumOutcome.disagreements) {
      const loc = note.line !== undefined ? `${note.file}:${note.line}` : note.file;
      emit(sink, {
        ts: finishedAt,
        event: "critic_disagreement",
        commit: sha,
        criticId: note.criticId,
        status: note.flag,
        detail: `${loc} — ${note.evidence}`,
      });
    }

    emit(sink, {
      ts: finishedAt,
      event: "review_finished",
      commit: sha,
      durationMs: Date.now() - startMs,
      ...(artifact.gateVerdict !== undefined ? { verdict: artifact.gateVerdict } : {}),
      findingCount: results.reduce((acc, r) => acc + r.findings.length, 0),
      aggregateReason,
      criticVerdicts,
      criticCompletionStates,
    });
  } catch (err) {
    // Convert the pending artifact to a terminal error artifact so the gate
    // sees a real failure instead of perpetually-pending. Without this, a
    // throw here leaves `<sha>.json` at status=pending and `gate-push`
    // blocks forever with `review_in_progress`. (Cycle 3 #9)
    //
    // Recovery runs whenever `packet` is built, NOT only when writePending
    // returned successfully — `writePending` -> `writeArtifacts` writes JSON
    // first; if any subsequent step throws, the JSON is already on disk and
    // would otherwise stay at status=pending forever. `writeArtifacts` is
    // now JSON-authoritative (markdown best-effort), so a hostile markdown
    // path cannot block recovery.
    if (packet) {
      try {
        const errArtifact = buildAggregate({
          loaded,
          commit: sha,
          parent: packet.commit.parent,
          range: packet.range,
          diffHash: packet.diffHash,
          criticResults: [],
          status: "error",
          createdAt: startedAt,
        });
        errArtifact.updatedAt = new Date().toISOString();
        await writeArtifacts(loaded, errArtifact);
      } catch {
        // Best-effort. If the error-artifact write itself fails, the lock
        // release in the finally block still happens; the operator can
        // re-run agent-review-commit to recover.
      }
    }
    emit(options.telemetry, {
      ts: new Date().toISOString(),
      event: "review_error",
      commit: sha,
      durationMs: Date.now() - startMs,
      error: (err as Error).message,
    });
    throw err;
  } finally {
    signalGuard.uninstall();
    releaseCommitLock(lock.lockPath);
    // Cancel the DF_CRITIC_TIMEOUT_MS internal-deadline timer (no-op when
    // the caller supplied their own signal or env was unset). Without
    // this, an early-return success path leaves a pending setTimeout
    // until the deadline elapses; `unref()` keeps Node from blocking on
    // it, but the timer still occupies memory across the rest of the
    // process lifetime.
    cleanupSignal();
  }
  // Re-narrow after try/finally — a successful path guarantees these are set.
  if (!artifact || !paths || !packet) {
    throw new Error("internal: artifact/paths/packet not set after successful runReview");
  }

  return {
    artifact,
    paths,
    packet,
    acquired: true,
  };
}

export interface GateRunOptions {
  loaded: LoadedConfig;
  commit: string;
  cwd?: string;
  telemetry?: TelemetrySink;
  // Cycle 322.7 — caller-supplied resolved profile name. When set
  // and the loaded config has a matching `profiles` entry, the gate
  // evaluator:
  //   (1) uses `profile.quorum` instead of root `aggregation.quorum`,
  //   (2) narrows the artifact's `criticResults` to `profile.criticIds`
  //       BEFORE the policy-specific evaluator runs, and
  //   (3) emits `out_of_profile_critic` warnings (in `result.warnings`)
  //       for each critic in the artifact that the profile excludes,
  //       so operators see the dropped critics without those critics'
  //       verdicts vetoing the gate.
  //
  // The intended posture: both runReview and runCommitGate run under
  // the same profile, so the artifact's critic set matches the gate
  // filter exactly. The (2) + (3) behavior covers the cross-profile
  // case — e.g., a commit reviewed under `cloud` (3 critics) pushed
  // under `--profile local` (2 critics) — surfaced by Codex P2 on
  // PR #1468.
  profileName?: string;
  // Issue #56 — see `ReviewRunOptions.injectedConfigAuthoritative`. Same
  // semantics on the pre-push gate path: an authoritatively-injected `loaded`
  // config is its own baseline; the self-mod guard does not re-read the parent
  // ref. Default false; only library embedders set it.
  injectedConfigAuthoritative?: boolean;
  // Issue #57 — see `ReviewRunOptions.onPolicyNotice`. Structured sink for the
  // self-modification notices on the pre-push gate path; defaults to stderr.
  onPolicyNotice?: (notice: PolicyNotice) => void;
}

export async function runCommitGate(options: GateRunOptions): Promise<GateResult> {
  const cwd = options.cwd ?? options.loaded.repoRoot;
  // Apply the same self-modification guard as `runReview`: a commit that
  // touches the trusted policy surface (config + guidance + fragments) is
  // not allowed to weaken its OWN gate evaluation. Without this, a commit
  // could set `blockOnMissingReview=false` or empty `requiredQualityGates`
  // and have pre-push respect the weakened HEAD policy.
  // `injectedConfigAuthoritative` (Issue #56) skips the parent-ref re-read for
  // hosted embedders that inject `loaded` out-of-band.
  const sha = await resolveCommit(options.commit, cwd);
  const baseline = await resolvePolicyBaseline({
    loaded: options.loaded,
    sha,
    cwd,
    ...(options.injectedConfigAuthoritative !== undefined
      ? { injectedConfigAuthoritative: options.injectedConfigAuthoritative }
      : {}),
    ...(options.onPolicyNotice !== undefined ? { notify: options.onPolicyNotice } : {}),
  });
  const loaded = baseline.loaded;

  // Cycle 322.7 Phase C — Emergency revert audit trail (gate path).
  // The documented operator flow is `AGENT_REVIEW_AGGREGATION_POLICY=
  // block-if-any git push`, which goes through gate-push → runCommitGate.
  // If we only emitted the event in runReview, that primary operator
  // surface would lose the audit record. Emit here too so every override
  // application — whether through the local critic subprocess or the
  // pre-push gate evaluator — appears in `_runs.ndjson`. The Cursor critic
  // finding on dce8fd9e flagged the gap (HIGH, observability §5).
  if (loaded.policyOverride) {
    emit(options.telemetry, {
      ts: new Date().toISOString(),
      event: "aggregation_policy_overridden",
      commit: sha,
      configured: loaded.policyOverride.configured,
      overridden: loaded.policyOverride.overridden,
      autoPromotedCritics: loaded.policyOverride.autoPromotedCritics,
    });
  }

  // Cycle 318.2 wiring: gate-push composes four gates in sequence; first
  // failure does NOT short-circuit — collect all blockers so a developer
  // sees the full picture in one pre-push output instead of stair-stepping
  // through the gate one fix at a time.
  //
  //   1. TDD classifier            (Component 1)
  //   2. Verification routes       (Component 2)
  //   3. Bypass / artifact / rubric-aware critic gate (Component 5)
  //
  // Bypass is handled inside `evaluateCommitGate` and still short-circuits
  // — the deterministic gates only run when no bypass is in effect.
  const allBlocks: GateBlock[] = [];
  const allWarnings: GateResult["warnings"] = [];

  const bypassReason = (process.env["AGENT_REVIEW_BYPASS"] ?? "").trim();
  const bypassActive = loaded.config.policy.allowEmergencyBypass && bypassReason.length > 0;

  if (!bypassActive && loaded.config.version === 2) {
    // TDD classifier — fail-closed per manifesto §8 (AI-Generated Code
    // with Safety Nets). A classifier exception (missing commit metadata,
    // shallow clone, IO failure) is a deterministic-gate failure: we
    // can't confirm whether tests accompany the production change, so
    // the gate must block. Operators with a genuinely broken local
    // environment can opt out via AGENT_REVIEW_BYPASS=<reason>.
    try {
      const tdd = await runTddClassifier({ loaded, sha, cwd });
      if (tdd && tdd.verdict === "block") {
        allBlocks.push({
          reason: "tdd_no_test",
          detail: `${tdd.reason}; production paths: ${tdd.productionPaths
            .slice(0, 5)
            .join(", ")}${tdd.productionPaths.length > 5 ? ", ..." : ""}`,
        });
      } else if (tdd && tdd.verdict === "justified") {
        allWarnings.push({
          reason: "tdd_justified",
          detail: tdd.reason,
        });
      }
    } catch (err) {
      allBlocks.push({
        reason: "tdd_classifier_error",
        detail: `TDD classifier failed: ${(err as Error).message}`,
      });
    }

    // Verification routes — also fail-closed. A route evaluation that
    // throws (corrupted JSON, fs error, etc.) means we can't read the
    // per-SHA evidence file safely; block by default so a stale or
    // unreadable artifact cannot let a push through. AGENT_REVIEW_BYPASS
    // remains the documented escape hatch for tool-broken emergencies.
    try {
      const parent = await safeParent(sha, cwd);
      const files = await changedFiles(parent, sha, cwd, { readContent: false });
      // Cycle 21/22 (#186 + #194) — compute the gated diff hash over the same
      // parent..sha range the routes are evaluated against, and thread it
      // into enforceVerificationRoutes. Supplying it activates content
      // binding: a triggered command route's evidence must carry a `diffHash`
      // matching the gated diff. #186 rejected a MISMATCH (same SHA, different
      // diff — re-staged stale evidence); #194 ALSO rejects ABSENT diffHash
      // (SHA-only evidence can no longer satisfy a content-bound route). The
      // `df verify` / `df gates` producers stamp it; older SHA-only producers
      // must upgrade. The catch below is the ONE escape: a transient git
      // error leaves `gatedDiffHash` undefined → binding goes dormant for this
      // commit (SHA-only fallback) rather than fail the whole route gate.
      // Documented limitation: the teeth are not absolute when git errors.
      let gatedDiffHash: string | undefined;
      try {
        gatedDiffHash = diffHash(await commitDiff(parent, sha, cwd));
      } catch {
        // If the diff can't be recomputed the SHA binding still applies;
        // skip the diff-hash half rather than fail the whole route gate
        // on a transient git error.
        gatedDiffHash = undefined;
      }
      // Include `oldPath` from rename/copy entries so a rename out of a
      // routed glob (e.g., `backend/app/foo.py` → `web/generated/foo.ts`)
      // still triggers the source's route. Without this, the only path
      // checked was the new path, and the moved-from glob would silently
      // fall off the gate. (Codex P2 follow-up on PR #1349.)
      const routeEval = await enforceVerificationRoutes({
        loaded,
        sha,
        changedPaths: collectChangedPaths(files),
        ...(gatedDiffHash !== undefined ? { diffHash: gatedDiffHash } : {}),
      });
      for (const r of routeEval.perRoute) {
        if (r.status === "missing") {
          allBlocks.push({
            reason: "verification_route_missing",
            detail: r.detail,
          });
        } else if (r.status === "failed") {
          allBlocks.push({
            reason: "verification_route_failed",
            detail: r.detail,
          });
        }
      }
      if (routeEval.suppressedBy) {
        allWarnings.push({
          reason: "routes_suppressed",
          detail: `exclusive route "${routeEval.suppressedBy.id}" suppressed all production routes`,
        });
      }
    } catch (err) {
      allBlocks.push({
        reason: "verification_routes_error",
        detail: `verification-routes evaluation failed: ${(err as Error).message}`,
      });
    }
  }

  // Build the rubric context once (commit trailers + per-SHA evidence)
  // so the critic-gate finding filter has it without reparsing. Only
  // build for v2 configs; v1 keeps the legacy behavior.
  const rubricContext =
    loaded.config.version === 2 && !bypassActive
      ? await buildRubricContext({ loaded, sha, cwd })
      : undefined;

  // Cycle 322.7 — when a profile is active, override the quorum used
  // by the gate evaluator AND scope the artifact's critic results to
  // the profile's allowlist. The profile resolver throws on unknown
  // profile names so a mistyped --profile fails loudly here too.
  const resolvedProfile = options.profileName
    ? resolveProfileWithConfig(loaded.config, options.profileName)
    : undefined;
  const quorumOverride = resolvedProfile?.quorum;
  const profileCriticIds = resolvedProfile?.criticIds;

  const result = await evaluateCommitGate({
    loaded,
    commit: options.commit,
    cwd,
    ...(rubricContext !== undefined ? { rubricContext } : {}),
    ...(quorumOverride !== undefined ? { quorumOverride } : {}),
    ...(profileCriticIds !== undefined ? { profileCriticIds } : {}),
  });

  // Merge deterministic gate results with the artifact-driven gate result.
  // Bypass on the artifact gate replaces our collected blocks entirely —
  // a bypass invocation is a full ceasefire on this push.
  const merged: GateResult = result.bypass
    ? result
    : {
        blocked: result.blocked || allBlocks.length > 0,
        blocks: [...allBlocks, ...result.blocks],
        warnings: [...allWarnings, ...result.warnings],
        ...(result.bypass !== undefined ? { bypass: result.bypass } : {}),
      };

  emit(options.telemetry, {
    ts: new Date().toISOString(),
    event: merged.bypass
      ? "gate_bypassed"
      : merged.blocked
        ? "gate_blocked"
        : "gate_passed",
    commit: options.commit,
    ...(merged.bypass ? { bypassReason: merged.bypass.reason } : {}),
  });
  return merged;
}

async function safeParent(sha: string, cwd: string): Promise<string> {
  try {
    return await commitParent(sha, cwd);
  } catch {
    return "";
  }
}

function emit(sink: TelemetrySink | undefined, event: TelemetryEvent): void {
  if (sink) sink.emit(event);
}

/**
 * Issue dark-factory-platform#112 — run the self-consistency probe
 * across one critic's findings and return a (possibly-new) CriticResult
 * with the `selfInconsistent` flag stamped on findings the probe
 * judged inconsistent. Pure aside from the probe call + git read; the
 * probe and gitShowFile are the only side-effect channels.
 *
 * Behavior per finding (see `runSelfConsistencyProbe` for the full
 * matrix):
 *   - non-blocking severity OR no file → skip (probe not invoked).
 *   - blocking severity AND file present → load file content via
 *     `gitShowFile(sha, path)`; pass to probe; stamp if inconsistent.
 *   - probe error / timeout / malformed output → default-to-consistent.
 *
 * Emits one `self_consistency_probe` event per processed finding for
 * audit-log visibility (matches the cycle 322.7 pattern of per-decision
 * telemetry).
 */
async function applyProbePassToCritic(
  critic: CriticResult,
  sha: string,
  cwd: string,
  probe: SelfConsistencyProbeFn,
  loaded: LoadedConfig,
  sink: TelemetrySink | undefined,
): Promise<CriticResult> {
  const blockingSeverities = loaded.config.aggregation.blockingSeverities;
  if (critic.status !== "complete" || critic.findings.length === 0) {
    return critic;
  }
  let mutated = false;
  const newFindings = await Promise.all(
    critic.findings.map(async (f) => {
      const result = await runSelfConsistencyProbe(
        f,
        critic.criticId,
        sha,
        blockingSeverities,
        async (path) => gitShowFile(sha, path, cwd),
        probe,
      );
      // Skip telemetry for trivial skips (non-blocking severity / no
      // file) to avoid `_runs.ndjson` noise — those are the common
      // case for any low-severity finding.
      if (result.reason !== "probe_skipped") {
        emit(sink, {
          ts: new Date().toISOString(),
          event: "self_consistency_probe",
          commit: sha,
          criticId: critic.criticId,
          status: result.reason,
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
        });
      }
      const tagged = applySelfConsistencyResult(f, result);
      if (tagged !== f) mutated = true;
      return tagged;
    }),
  );
  if (!mutated) return critic;
  return { ...critic, findings: newFindings };
}

// Issue #105 — wrap the per-SHA `releaseCommitLock` flow with signal
// handlers so a SIGTERM/SIGINT-killed `df review` process still removes
// the lock file. The existing `try/finally` only fires for graceful
// errors; a signal kill bypasses it and orphans
// `.git/agent-reviews/<sha>.lock`, permanently blocking re-runs.
//
// `uninstall()` must be called in `finally` so the lock-release listener
// is dropped on graceful exit — without it, every programmatic re-run
// (e.g. a test suite invoking `runReview` repeatedly) accumulates listeners
// and eventually trips MaxListenersExceededWarning. The uninstall path is
// careful to restore only OUR listener (not whatever else the host has
// wired up).
//
// Exit codes follow POSIX convention `128 + signal_number`:
// SIGINT (2) → 130, SIGTERM (15) → 143.
export interface SignalLockGuard {
  uninstall(): void;
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;
type GuardedSignal = keyof typeof SIGNAL_EXIT_CODES;

export function installSignalLockGuard(lockPath: string): SignalLockGuard {
  const handlers: { [S in GuardedSignal]?: NodeJS.SignalsListener } = {};
  const install = (sig: GuardedSignal): void => {
    const handler: NodeJS.SignalsListener = () => {
      releaseCommitLock(lockPath);
      process.exit(SIGNAL_EXIT_CODES[sig]);
    };
    handlers[sig] = handler;
    process.on(sig, handler);
  };
  install("SIGTERM");
  install("SIGINT");
  return {
    uninstall(): void {
      for (const sig of Object.keys(handlers) as GuardedSignal[]) {
        const h = handlers[sig];
        if (h) process.removeListener(sig, h);
      }
    },
  };
}

