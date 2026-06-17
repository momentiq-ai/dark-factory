// Issue #169 — graceful, legible degradation when the assembled diff prompt
// exceeds a vendor's context window.
//
// Pure-helper coverage for the shared context-window machinery in
// `_shared.ts` (token estimate, reason-string shape, provider 400-signature
// classifier, structured-error builder, pre-flight gate). The adapter-level
// integration (pre-flight short-circuit + raw-400 rewrite) lives in
// gemini-adapter.test.ts / grok-adapter.test.ts where the SDK mocks already
// exist; this file keeps the pure helpers honest in isolation.

import { test } from "vitest";
import {
  expect_eq,
  expect_match,
  expect_no_match,
  expect_truthy,
} from "./_assert-shim.js";
import {
  BYTES_PER_TOKEN_ESTIMATE,
  CONTEXT_WINDOW_ERROR_CODE,
  GEMINI_CONTEXT_WINDOW_TOKENS,
  GROK_CONTEXT_WINDOW_TOKENS,
  buildContextWindowExceededResult,
  checkContextWindow,
  estimateTokensFromBytes,
  formatContextWindowExceededMessage,
  isContextLengthError,
} from "../src/adapters/_shared.js";
import type { CriticConfig } from "@momentiq/dark-factory-schemas";

const CRITIC: CriticConfig = {
  id: "gemini-local-chief",
  name: "Gemini Local Critic",
  adapter: "gemini-sdk",
  required: false,
  runtime: "local",
  model: { id: "gemini-3.1-pro", params: [] },
};

// ---------------------------------------------------------------------------
// estimateTokensFromBytes

test("estimateTokensFromBytes: divides bytes by the repo bytes/token convention", () => {
  expect_eq(BYTES_PER_TOKEN_ESTIMATE, 4);
  expect_eq(estimateTokensFromBytes(4_000_000), 1_000_000);
  // ceil, not floor — a high-side estimate errs toward short-circuiting.
  expect_eq(estimateTokensFromBytes(5), 2);
});

test("estimateTokensFromBytes: non-positive / non-finite inputs estimate 0", () => {
  expect_eq(estimateTokensFromBytes(0), 0);
  expect_eq(estimateTokensFromBytes(-100), 0);
  expect_eq(estimateTokensFromBytes(Number.NaN), 0);
  expect_eq(estimateTokensFromBytes(Number.POSITIVE_INFINITY), 0);
});

// ---------------------------------------------------------------------------
// formatContextWindowExceededMessage

test("formatContextWindowExceededMessage: names vendor + tokens + limit", () => {
  const msg = formatContextWindowExceededMessage({
    vendor: "gemini",
    estimatedTokens: 1_500_000,
    limit: GEMINI_CONTEXT_WINDOW_TOKENS,
  });
  expect_eq(msg, "diff exceeds gemini context window (1500000 tokens > 1048576 limit)");
});

// ---------------------------------------------------------------------------
// isContextLengthError — provider 400 signature classifier

test("isContextLengthError: matches the gemini over-limit 400 phrasing", () => {
  expect_eq(
    isContextLengthError(
      "The input token count exceeds the maximum number of tokens allowed 1048576",
    ),
    true,
  );
});

test("isContextLengthError: matches the grok/xai over-limit 400 phrasing", () => {
  expect_eq(
    isContextLengthError(
      "This model's maximum prompt length is 1000000 but the request contains 1491263 tokens",
    ),
    true,
  );
});

test("isContextLengthError: matches the OpenAI-family 'maximum context length' phrasing", () => {
  expect_eq(
    isContextLengthError(
      "This model's maximum context length is 1000000 tokens, however your messages resulted in 1491263 tokens",
    ),
    true,
  );
});

test("isContextLengthError: matches the codex over-limit shapes (#181/#182)", () => {
  // Codex measures input in CHARACTERS, so its over-limit copy phrases
  // differently than the token-based vendors. Both substrings are stable
  // pieces of the SDK's -32602 over-limit message.
  expect_eq(
    isContextLengthError("input exceeds the maximum length of 1048576 characters"),
    true,
  );
  expect_eq(isContextLengthError("Error: input_too_large"), true);
  // Case-insensitive (the classifier lowercases first).
  expect_eq(isContextLengthError("Input Exceeds The Maximum Length"), true);
});

test("isContextLengthError: does NOT match unrelated 400s (bad model id, malformed request)", () => {
  expect_eq(isContextLengthError("model 'grok-99' not found"), false);
  expect_eq(isContextLengthError("Invalid value for 'temperature': must be <= 2"), false);
  expect_eq(isContextLengthError("400 Bad Request"), false);
  expect_eq(isContextLengthError(undefined), false);
  expect_eq(isContextLengthError(null), false);
  expect_eq(isContextLengthError(""), false);
});

// ---------------------------------------------------------------------------
// buildContextWindowExceededResult — structured CriticResult envelope

test("buildContextWindowExceededResult: clean errored CriticResult, no raw provider JSON", () => {
  const result = buildContextWindowExceededResult({
    critic: CRITIC,
    vendor: "gemini",
    estimatedTokens: 1_500_000,
    limit: GEMINI_CONTEXT_WINDOW_TOKENS,
    retryCount: 0,
  });
  expect_eq(result.status, "error");
  expect_eq(result.criticId, "gemini-local-chief");
  expect_eq(result.confidence, "unknown");
  expect_eq(result.findings.length, 0);
  expect_eq(result.error?.retryable, false);
  expect_eq(result.error?.code, CONTEXT_WINDOW_ERROR_CODE);
  expect_eq(result.error?.retryCount, 0);
  expect_match(
    result.error?.message ?? "",
    /diff exceeds gemini context window \(1500000 tokens > 1048576 limit\)/,
  );
  // The clean reason must NOT carry the raw provider INVALID_ARGUMENT copy.
  expect_no_match(result.error?.message ?? "", /INVALID_ARGUMENT|input token count/i);
});

// ---------------------------------------------------------------------------
// checkContextWindow — pre-flight gate

test("checkContextWindow: returns the structured error when the estimate exceeds the budget", () => {
  // 4 * (limit + 1) bytes ⇒ estimate = limit + 1 ⇒ over budget by one token.
  const overBytes = BYTES_PER_TOKEN_ESTIMATE * (GROK_CONTEXT_WINDOW_TOKENS + 1);
  const result = checkContextWindow({
    critic: CRITIC,
    vendor: "grok",
    promptByteLength: overBytes,
    limit: GROK_CONTEXT_WINDOW_TOKENS,
    retryCount: 0,
  });
  expect_truthy(result, "expected a structured error when over the budget");
  expect_eq(result?.status, "error");
  expect_eq(result?.error?.code, CONTEXT_WINDOW_ERROR_CODE);
  expect_match(result?.error?.message ?? "", /diff exceeds grok context window/);
});

test("checkContextWindow: returns null when the prompt fits the budget", () => {
  // Exactly at the limit (estimate == limit) is within budget.
  const atBytes = BYTES_PER_TOKEN_ESTIMATE * GROK_CONTEXT_WINDOW_TOKENS;
  expect_eq(
    checkContextWindow({
      critic: CRITIC,
      vendor: "grok",
      promptByteLength: atBytes,
      limit: GROK_CONTEXT_WINDOW_TOKENS,
    }),
    null,
  );
  // A tiny prompt obviously fits.
  expect_eq(
    checkContextWindow({
      critic: CRITIC,
      vendor: "gemini",
      promptByteLength: 1024,
      limit: GEMINI_CONTEXT_WINDOW_TOKENS,
    }),
    null,
  );
});
