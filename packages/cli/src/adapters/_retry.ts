// Cycle 322.1 + dark-factory#11 / sage3c#2198 — sqlite3-independent retry
// helpers shared across every critic adapter (Cursor, Codex, Gemini, Grok).
//
// Why this file exists separately from `_shared.ts`:
//   - `_shared.ts` covers the parse/error-envelope/redaction concern.
//   - `_retry.ts` covers the bounded-retry policy concern.
// Keeping the two files separate keeps each focused and below the size at
// which a reviewer starts skimming.
//
// Why the helpers live HERE and not in `cursor-sdk.ts` any more
// (issue dark-factory#11 + sage3c#2198):
//   - Until this move, the codex / gemini / grok adapters all imported the
//     retry helpers from `./cursor-sdk.js`, which statically imports
//     `@cursor/sdk` → `sqlite3` (native binding).
//   - Under `npm install --ignore-scripts` (the consumer-CI install path
//     in all 5 reusable workflows), sqlite3's prebuilt-binary fetch is
//     skipped, so the static import chain fails at module-load time and
//     ALL FOUR adapters fail to register — not just Cursor.
//   - Hoisting the retry helpers to a sqlite3-free file means codex /
//     gemini / grok load cleanly under `--ignore-scripts`, leaving only
//     Cursor to fail under that constraint (and the companion workflow
//     fix in this same PR explicitly rebuilds sqlite3 to recover the
//     Cursor adapter too).
//
// Every helper here is pure and unit-tested in
// `tests/cursor-retry.test.ts` (the file name is historical; the tests
// re-import from `cursor-sdk.js` via the back-compat re-export to avoid
// test churn).

import type { CriticResult, CriticStatusMessage } from "@momentiq/dark-factory-schemas";

// Cycle 322.1 — bounded retry policy for any critic adapter.
//
// The Cursor SDK delivers terminal upstream failures as a normal
// `RunResult.status === "error"` (no thrown exception). The richer
// signal — `LocalRunStreamResultEvent.errorCode` and the streamed
// `SDKStatusMessage` — is what tells operators whether the failure is
// transient (capacity_exceeded / upstream_timeout) or permanent
// (auth_failed / quota_exceeded). Capturing both and retrying ONLY
// transient failures replaces the prior "any terminal error → gate
// blocks → emergency bypass" anti-pattern with a sanctioned, bounded,
// observable recovery path.
//
// Empirical signal: 26/27 transient terminal-error runs observed
// over a 4-day window succeeded on retry with the same prompt
// within 1–5 minutes. The fixed `[5s, 15s]` schedule covers that
// recovery window without trading too much wall-clock for tail
// success.
//
// Total budget: 20s across 2 retries (3 attempts total). If a vendor
// outage outlives 20s, the gate blocks deterministically with an
// actionable `errorCode` instead of returning APPROVED on stale data.
export const RETRY_BACKOFF_MS: readonly number[] = Object.freeze([5_000, 15_000]) as readonly number[];

// Error codes that are NOT retryable. A terminal failure matching one
// of these proceeds directly to error-result construction without a
// retry. These are permanent failures where retrying wastes budget
// AND can mask the real fault (e.g., a wrong API key would silently
// burn 20s of retries before surfacing the auth issue).
//
// The set is intentionally narrow — anything not on this list is
// treated as retryable when accompanied by a runId (indicating the
// SDK accepted the request and the failure happened upstream).
export const PERMANENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "auth_failed",
  "invalid_api_key",
  "quota_exceeded",
  "model_not_found",
  "content_policy_violation",
  "invalid_request",
  "context_length_exceeded",
]);

// Cycle 322.1 — Outcome of a single `attemptReview()` call. Tagged
// union so the outer retry loop can dispatch on `kind` without
// inspecting result internals; each kind carries exactly the fields
// needed to either return immediately or schedule a retry.
//
// `success` and `permanent_failure` both produce a terminal
// CriticResult; only `retryable_failure` re-enters the loop. The
// permanent_failure variant carries its own result so the adapter
// can finalize error semantics in one place (e.g., adapter-init
// failures keep their existing error envelope) without forcing the
// loop to re-synthesize an error result.
//
// Exported for tests + every adapter that mirrors this shape from a
// single source of truth.
export type AttemptOutcome =
  | { kind: "success"; result: CriticResult }
  | {
      kind: "retryable_failure";
      errorCode: string | null;
      statusMessage: CriticStatusMessage | null;
      message: string;
      runId: string | null;
      agentId: string | null;
    }
  | {
      kind: "permanent_failure";
      errorCode: string | null;
      statusMessage: CriticStatusMessage | null;
      result: CriticResult;
    };

export type RetryableFailure = Extract<AttemptOutcome, { kind: "retryable_failure" }>;

/**
 * Cycle 322.1 — Pure retry-loop runner.
 *
 * Drives a sequence of `attempt(idx)` calls under the
 * {@link RETRY_BACKOFF_MS} schedule, dispatching on the returned
 * {@link AttemptOutcome}:
 *  - `success` / `permanent_failure` → return immediately, no more
 *    attempts.
 *  - `retryable_failure` → record the failure and (if budget
 *    remains) sleep + try again.
 *
 * Honors `signal` between attempts and during backoff sleeps; on
 * abort, builds a terminal result via `buildExhausted` with the
 * last failure context (so callers can surface "what was the last
 * upstream error" even when cancellation cut the loop short).
 *
 * Lives in `_retry.ts` (not the Cursor adapter) so codex/gemini/grok
 * adapters inherit the retry pattern without dragging in the Cursor
 * SDK's transitive `sqlite3` native binding. The loop is unit-testable
 * with scripted outcomes + a mock `sleep` (see
 * `tests/cursor-retry-loop.test.ts`) — no SDK mock required.
 */
export async function runRetryLoop(args: {
  attempt: (idx: number) => Promise<AttemptOutcome>;
  signal?: AbortSignal;
  // Optional override for the per-retry sleep. Defaults to
  // {@link sleepForRetry} which uses the real RETRY_BACKOFF_MS
  // schedule. Tests pass a no-op or fake-timer variant to avoid
  // wall-clock waits.
  sleep?: (idx: number, signal: AbortSignal | undefined) => Promise<void>;
  buildExhausted: (info: {
    last: RetryableFailure | null;
    totalAttempts: number;
    aborted: boolean;
  }) => CriticResult;
}): Promise<CriticResult> {
  const maxAttempts = RETRY_BACKOFF_MS.length + 1;
  const sleep = args.sleep ?? sleepForRetry;
  let attempt = 0;
  let lastFailure: RetryableFailure | null = null;
  let aborted = false;

  while (attempt < maxAttempts) {
    if (args.signal?.aborted) {
      aborted = true;
      break;
    }
    const outcome = await args.attempt(attempt);
    if (outcome.kind === "success") return outcome.result;
    if (outcome.kind === "permanent_failure") return outcome.result;
    lastFailure = outcome;
    // Sleep only if we still have retries left. After the last
    // attempt (idx === RETRY_BACKOFF_MS.length), no sleep — fall out
    // to exhausted path immediately.
    if (attempt < RETRY_BACKOFF_MS.length) {
      try {
        await sleep(attempt, args.signal);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          aborted = true;
          break;
        }
        throw err;
      }
    }
    attempt++;
  }

  return args.buildExhausted({ last: lastFailure, totalAttempts: attempt, aborted });
}

/**
 * Policy gate: decide whether a terminal SDK failure is retryable.
 *
 * Returns `false` (DO NOT retry) when:
 *  - `runId` is null/undefined — the SDK never accepted the request;
 *    this is an infrastructure failure (network, sandbox, adapter
 *    init), not an API-layer failure that retry can paper over.
 *  - `errorCode` is in {@link PERMANENT_ERROR_CODES} — retrying an
 *    auth failure or quota-exceeded just wastes budget AND can mask
 *    the real fault.
 *
 * Returns `true` (retry allowed) when the failure carries a `runId`
 * AND `errorCode` is either missing OR not on the permanent-deny
 * list. The 26/27 retryable-failure success rate documented at
 * `RETRY_BACKOFF_MS` drives this policy without per-vendor heuristics.
 */
export function shouldRetryRunFailure(input: {
  result: unknown;
  errorCode: string | null;
  runId: string | null;
}): boolean {
  // Without a runId, the SDK didn't accept the request — there is
  // nothing on the upstream side to retry. Retrying here would just
  // re-run the same infrastructure-level failure.
  if (!input.runId) return false;
  // Permanent-error deny list short-circuits retries.
  if (input.errorCode && PERMANENT_ERROR_CODES.has(input.errorCode)) return false;
  return true;
}

/**
 * AbortSignal-aware sleep used between retry attempts.
 *
 * Resolves after `RETRY_BACKOFF_MS[idx]` ms, OR rejects immediately
 * with an Error whose `name === "AbortError"` if the signal is (or
 * becomes) aborted. The abort handler also clears the pending timer
 * so a long backoff doesn't leak a Node timer after the caller
 * cancelled.
 *
 * Throws synchronously (via the returned rejected promise) on
 * out-of-range `idx` so an indexing bug in the caller fails loud
 * instead of silently sleeping zero ms.
 */
export async function sleepForRetry(idx: number, signal: AbortSignal | undefined): Promise<void> {
  if (idx < 0 || idx >= RETRY_BACKOFF_MS.length) {
    throw new Error(
      `sleepForRetry: idx ${idx} out of range (RETRY_BACKOFF_MS.length=${RETRY_BACKOFF_MS.length})`,
    );
  }
  const ms = RETRY_BACKOFF_MS[idx] as number;
  if (signal?.aborted) {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  }
  await new Promise<void>((resolveSleep, rejectSleep) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const e = new Error("aborted");
      e.name = "AbortError";
      rejectSleep(e);
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

