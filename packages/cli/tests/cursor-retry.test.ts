import { describe, it, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  expect_eq,
  expect_ne,
  expect_deep,
  expect_match,
  expect_no_match,
  expect_truthy,
  expect_throws,
  expect_rejects,
} from "./_assert-shim.js";

import {
  PERMANENT_ERROR_CODES,
  RETRY_BACKOFF_MS,
  extractRunErrorCode,
  extractStatusMessage,
  shouldRetryRunFailure,
  sleepForRetry,
} from "../src/adapters/cursor-sdk.js";

// Cycle 322.1 — pure-function tests for the Cursor SDK retry policy.
// Every helper is independently testable without an SDK mock so the
// policy is provably deterministic. The retry-loop integration tests
// live in `cursor-retry-loop.test.ts`.

// ---------------------------------------------------------------------------
// extractStatusMessage
// ---------------------------------------------------------------------------

test("extractStatusMessage pulls {status,message} from a top-level SDKStatusMessage event", () => {
  const event = {
    type: "status",
    status: "error",
    message: "Upstream model gpt-5.5 returned capacity_exceeded after retry policy exhausted",
  };
  expect_deep(extractStatusMessage(event), {
    status: "error",
    message: "Upstream model gpt-5.5 returned capacity_exceeded after retry policy exhausted",
  });
});

test("extractStatusMessage finds {status,message} nested under data/message/payload", () => {
  const nestedData = { type: "status", data: { status: "running", message: "queued upstream" } };
  expect_deep(extractStatusMessage(nestedData), {
    status: "running",
    message: "queued upstream",
  });
  const nestedMessage = {
    kind: "status_message",
    message: { status: "error", message: "upstream timeout" },
  };
  expect_deep(extractStatusMessage(nestedMessage), {
    status: "error",
    message: "upstream timeout",
  });
});

test("extractStatusMessage returns null for non-status events (assistant text etc.)", () => {
  expect_eq(extractStatusMessage({ type: "assistant", message: { content: "hi" } }), null);
  expect_eq(extractStatusMessage({ type: "thinking" }), null);
});

test("extractStatusMessage returns null for malformed status events", () => {
  // Missing message field
  expect_eq(extractStatusMessage({ type: "status", status: "error" }), null);
  // Empty strings
  expect_eq(extractStatusMessage({ type: "status", status: "", message: "x" }), null);
  expect_eq(extractStatusMessage({ type: "status", status: "x", message: "" }), null);
  // Non-string types
  expect_eq(extractStatusMessage({ type: "status", status: 42, message: "x" }), null);
  // Wholly malformed
  expect_eq(extractStatusMessage(null), null);
  expect_eq(extractStatusMessage("not-an-object"), null);
  expect_eq(extractStatusMessage(undefined), null);
});

// ---------------------------------------------------------------------------
// extractRunErrorCode
// ---------------------------------------------------------------------------

test("extractRunErrorCode pulls top-level errorCode (current SDK field name)", () => {
  expect_eq(extractRunErrorCode({ status: "error", errorCode: "capacity_exceeded" }), "capacity_exceeded");
});

test("extractRunErrorCode falls back to error_code (snake_case legacy)", () => {
  expect_eq(extractRunErrorCode({ status: "error", error_code: "upstream_timeout" }), "upstream_timeout");
});

test("extractRunErrorCode falls back to top-level code", () => {
  expect_eq(extractRunErrorCode({ status: "error", code: "invalid_request" }), "invalid_request");
});

test("extractRunErrorCode falls back to nested error.code", () => {
  expect_eq(
    extractRunErrorCode({ status: "error", error: { code: "model_not_found", message: "x" } }),
    "model_not_found",
  );
});

test("extractRunErrorCode returns null when no recognized field is present", () => {
  expect_eq(extractRunErrorCode({ status: "error" }), null);
  expect_eq(extractRunErrorCode({ status: "error", error: { message: "no code" } }), null);
  // Defensive cases
  expect_eq(extractRunErrorCode(null), null);
  expect_eq(extractRunErrorCode("not-an-object"), null);
  // Empty strings are not valid codes
  expect_eq(extractRunErrorCode({ errorCode: "" }), null);
});

test("extractRunErrorCode prefers errorCode over error_code/code/error.code (priority order)", () => {
  const result = {
    errorCode: "capacity_exceeded",
    error_code: "should_not_win",
    code: "should_not_win",
    error: { code: "should_not_win" },
  };
  expect_eq(extractRunErrorCode(result), "capacity_exceeded");
});

// ---------------------------------------------------------------------------
// shouldRetryRunFailure
// ---------------------------------------------------------------------------

test("shouldRetryRunFailure returns false when runId is null (infrastructure failure)", () => {
  // Without a runId the SDK never accepted the request — retry has
  // nothing to retry. This is the canonical "network died before
  // upload" case.
  expect_eq(
    shouldRetryRunFailure({ result: { status: "error" }, errorCode: "capacity_exceeded", runId: null }),
    false,
  );
});

test("shouldRetryRunFailure returns false when errorCode is in the permanent deny list", () => {
  for (const code of PERMANENT_ERROR_CODES) {
    expect_eq(
      shouldRetryRunFailure({ result: { status: "error" }, errorCode: code, runId: "run-123" }),
      false,
      `code ${code} should be permanent`,
    );
  }
});

test("shouldRetryRunFailure returns true for transient errors with a runId", () => {
  expect_eq(
    shouldRetryRunFailure({ result: { status: "error" }, errorCode: "capacity_exceeded", runId: "run-1" }),
    true,
  );
  expect_eq(
    shouldRetryRunFailure({ result: { status: "error" }, errorCode: "upstream_timeout", runId: "run-2" }),
    true,
  );
});

test("shouldRetryRunFailure returns true when errorCode is null but runId is present", () => {
  // The SDK accepted the request (we have a runId) but didn't supply
  // a structured code. Treat as transient — ~26/27 of these succeed
  // on retry (see RETRY_BACKOFF_MS empirical signal).
  expect_eq(
    shouldRetryRunFailure({ result: { status: "error" }, errorCode: null, runId: "run-7" }),
    true,
  );
});

test("shouldRetryRunFailure returns false for empty-string runId (defensive)", () => {
  // Some SDK versions surface an empty string when the request was
  // accepted-but-not-persisted; treat as no runId.
  expect_eq(
    shouldRetryRunFailure({ result: { status: "error" }, errorCode: "capacity_exceeded", runId: "" }),
    false,
  );
});

test("shouldRetryRunFailure ignores the result shape entirely (policy = errorCode + runId)", () => {
  // The result argument is reserved for future expansion (e.g.,
  // status-message-based heuristics) but the current policy is
  // deterministic on errorCode + runId. Pass nonsense results — the
  // verdict still tracks the policy inputs.
  expect_eq(
    shouldRetryRunFailure({ result: null, errorCode: "auth_failed", runId: "run-1" }),
    false,
    "permanent code wins regardless of result shape",
  );
  expect_eq(
    shouldRetryRunFailure({ result: undefined, errorCode: "capacity_exceeded", runId: "run-1" }),
    true,
    "retryable code wins regardless of result shape",
  );
});

// ---------------------------------------------------------------------------
// RETRY_BACKOFF_MS invariants
// ---------------------------------------------------------------------------

test("RETRY_BACKOFF_MS has length 2 and total budget ≤ 20s (Cycle 322.1 policy)", () => {
  // The plan explicitly caps total retry budget at 20s. Any change to
  // this constant must be a cycle-doc-level decision, not a silent
  // edit — this invariant test forces the conversation.
  expect_eq(RETRY_BACKOFF_MS.length, 2, "exactly 2 retries (3 attempts total)");
  const total = RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0);
  expect_truthy(total <= 20_000, `total backoff ${total}ms must be ≤ 20_000ms`);
  // Backoff should be monotonically non-decreasing — a steeper second
  // retry gives a longer-running incident a chance to clear.
  for (let i = 1; i < RETRY_BACKOFF_MS.length; i++) {
    const prev = RETRY_BACKOFF_MS[i - 1] as number;
    const cur = RETRY_BACKOFF_MS[i] as number;
    expect_truthy(cur >= prev, `backoff[${i}]=${cur} must be ≥ backoff[${i - 1}]=${prev}`);
  }
});

// ---------------------------------------------------------------------------
// sleepForRetry
// ---------------------------------------------------------------------------

test("sleepForRetry throws synchronously for out-of-range idx (loud failure on indexing bug)", async () => {
  await expect_rejects(
    () => sleepForRetry(-1, undefined),
    /sleepForRetry: idx -1 out of range/,
  );
  await expect_rejects(
    () => sleepForRetry(RETRY_BACKOFF_MS.length, undefined),
    /out of range/,
  );
});

test("sleepForRetry resolves after the configured backoff (verified via mock timers)", async () => {
  // Use vitest fake timers so the test doesn't sit through a 5s wall-clock
  // wait per retry-loop unit; correctness is still verified because the fake
  // setTimeout still fires on the requested ms elapsed. The mock is scoped
  // to this test only.
  vi.useFakeTimers();
  try {
    let resolved = false;
    const promise = sleepForRetry(0, undefined).then(() => {
      resolved = true;
    });
    // Just-before the configured ms — must NOT have resolved yet.
    const ms = RETRY_BACKOFF_MS[0] as number;
    vi.advanceTimersByTime(ms - 1);
    await Promise.resolve(); // let microtask queue drain
    expect_eq(resolved, false, `should not resolve before ${ms}ms`);
    // At the configured ms — must resolve.
    vi.advanceTimersByTime(1);
    await promise;
    expect_eq(resolved, true, `should resolve at exactly ${ms}ms`);
  } finally {
    vi.useRealTimers();
  }
});

test("sleepForRetry rejects immediately when signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const start = Date.now();
  await expect_rejects(() => sleepForRetry(0, controller.signal), (err: Error) => err.name === "AbortError");
  const elapsed = Date.now() - start;
  // Must reject synchronously (within a microtask), not wait for the
  // backoff to elapse. Allow some scheduling slop but cap well under
  // the smallest backoff value.
  expect_truthy(elapsed < 200, `pre-aborted sleep should reject immediately; elapsed=${elapsed}ms`);
});

test("sleepForRetry rejects when signal aborts mid-sleep and clears the pending timer", async () => {
  const controller = new AbortController();
  // Abort after 50ms; backoff is 5s so we should reject ~50ms in.
  setTimeout(() => controller.abort(), 50);
  const start = Date.now();
  await expect_rejects(() => sleepForRetry(0, controller.signal), (err: Error) => err.name === "AbortError");
  const elapsed = Date.now() - start;
  expect_truthy(elapsed >= 40, `should wait until abort fires; elapsed=${elapsed}ms`);
  expect_truthy(elapsed < 1_000, `should reject well before the 5s backoff; elapsed=${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// PERMANENT_ERROR_CODES invariants
// ---------------------------------------------------------------------------

test("PERMANENT_ERROR_CODES enumerates the documented permanent failures", () => {
  // The deny list must include every Cursor error code that retrying
  // cannot fix. Adding to this list expands "fail-fast" coverage;
  // removing from it requires a cycle-doc decision because it
  // changes retry semantics for production traffic.
  const expected = [
    "auth_failed",
    "invalid_api_key",
    "quota_exceeded",
    "model_not_found",
    "content_policy_violation",
    "invalid_request",
    "context_length_exceeded",
  ];
  expect_eq(PERMANENT_ERROR_CODES.size, expected.length);
  for (const code of expected) {
    expect_truthy(PERMANENT_ERROR_CODES.has(code), `expected ${code} in PERMANENT_ERROR_CODES`);
  }
});
