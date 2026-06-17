// Cycle 322.2 — adapter helpers shared across all critic adapters
// (Cursor, Gemini, and future Grok). The helpers here centralize the
// security-critical paths — evidence-redaction at the diagnostic boundary
// and JSON-parse-fallback for assistant responses — so a new adapter
// cannot accidentally drift from the contract by reimplementing the
// pattern locally.
// Touched (comment-only, no semantic change) for issue #1434 dogfood —
// validates that a trusted-surface no-op PR produces a real agent-critic
// verdict in CI under the new parent-baseline rebind. Remove this line in
// the next cleanup pass if it bothers you.
//
// Each helper is pure (or pure-with-narrow-IO for the redaction writer)
// and unit-tested in `tests/shared-helpers.test.ts` (parseAssistantJson,
// buildErrorResult, mergeAdapterMetadata, writeRedactedDiagnostic) and
// `tests/normalize-echo-shared.test.ts` (normalizeCriticEcho — added in
// issue #1484 when this helper was hoisted from cursor-sdk.ts). A
// separate boundary test (`tests/shared-boundary.test.ts`) statically
// scans every adapter file under this directory for direct
// `writeFileSync` calls — if a future adapter sidesteps
// `writeRedactedDiagnostic`, the test fails the suite (the lightweight
// equivalent of the custom ESLint rule the cycle 322.2 plan called for;
// the project does not currently use ESLint).
//
// Usage discipline: adapters MUST import these helpers from `_shared.ts`,
// not duplicate the patterns. The `criticId` tag (Phase F) is woven through
// the `mergeAdapterMetadata` and `buildErrorResult` shapes so per-critic
// telemetry segmentation works for every adapter without per-adapter glue.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { redactSecrets } from "../security.js";
import {
  parseQualityGateResult,
  type CriticConfig,
  type CriticResult,
  type ModelConfig,
} from "@momentiq/dark-factory-schemas";

// ---------------------------------------------------------------------------
// parseAssistantJson — tolerant JSON parser for LLM "JSON-only" responses.
//
// LLMs return JSON wrapped in ```json fences, with stray prose, or with the
// JSON object embedded in commentary even when the prompt + response config
// asks for application/json. Parsing must therefore be a defense-in-depth:
//   1. Trim whitespace.
//   2. Strip a single ```json/``` fence if present.
//   3. Try JSON.parse() — fast path.
//   4. Fall back to slicing between the first `{` and last `}` and re-parse.
//
// Returns a tagged result so the caller can persist the failure as a
// permanent (non-retryable) error: a model that produced malformed output
// will reproduce that output on retry, and burning retry budget on bad
// JSON starves the budget for real transient upstream incidents.

export interface ParseAssistantJsonOk {
  ok: true;
  value: unknown;
}

export interface ParseAssistantJsonFail {
  ok: false;
  message: string;
}

export type ParseAssistantJsonResult = ParseAssistantJsonOk | ParseAssistantJsonFail;

export function parseAssistantJson(text: string): ParseAssistantJsonResult {
  if (!text.trim()) return { ok: false, message: "assistant response was empty" };
  let candidate = text.trim();
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fence) candidate = (fence[1] ?? "").trim();
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return { ok: false, message: "no JSON object found" };
    }
    try {
      return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

// ---------------------------------------------------------------------------
// buildErrorResult — single source of truth for the CriticResult error
// envelope used by every adapter when an SDK call fails or returns a
// terminal error status.
//
// Centralizes the schema-conformant shape (reviewer info, validation stub,
// confidence: "unknown") so an adapter can never accidentally ship an
// error result that fails parseCriticResult validation downstream. All
// optional fields use the conditional-spread pattern to honor the
// schema's `exactOptionalPropertyTypes` strictness — undefined values
// must be omitted, not set to undefined, or runtime parsing rejects them.

export interface BuildErrorResultArgs {
  critic: CriticConfig;
  message: string;
  retryable: boolean;
  rawSamplePath?: string;
  agentId?: string;
  runId?: string;
  // Cycle 322.1 — SDK-supplied structured error code.
  code?: string;
  // Cycle 322.1 — total retries used before this failure was finalized.
  retryCount?: number;
}

export function buildErrorResult(args: BuildErrorResultArgs): CriticResult {
  return {
    criticId: args.critic.id,
    status: "error",
    requiresHumanJudgment: false,
    reviewer: {
      name: args.critic.name,
      adapter: args.critic.adapter,
      model: args.critic.model,
      runtime: args.critic.runtime,
      ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
      ...(args.runId !== undefined ? { runId: args.runId } : {}),
    },
    summary: args.message,
    findings: [],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "unknown",
    error: {
      message: args.message,
      retryable: args.retryable,
      ...(args.rawSamplePath !== undefined ? { rawSamplePath: args.rawSamplePath } : {}),
      ...(args.code !== undefined ? { code: args.code } : {}),
      ...(args.retryCount !== undefined ? { retryCount: args.retryCount } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Context-window degradation (issue #169) — turn the "assembled diff prompt
// exceeds the vendor's context window" case into a CLEAN, LEGIBLE structured
// error instead of letting the raw provider 400 JSON
// (`The input token count exceeds the maximum number of tokens allowed
// 1048576`, `This model's maximum prompt length is 1000000 but the request
// contains 1491263 tokens`) propagate into the artifact + per-critic summary.
//
// Lives here (next to `buildErrorResult`) so EVERY direct-API adapter
// (gemini, grok, and any future vendor) shares ONE budget heuristic, ONE
// reason-string shape, and ONE 400-signature classifier — the same
// single-source-of-truth discipline the rest of this file enforces. An
// adapter that re-implemented the check locally could drift the operator-
// facing reason string between vendors; routing through these helpers means
// the degrade reads identically across the fleet.
//
// SCOPE (issue #169): this is graceful degradation ONLY — a clean errored
// critic that does not veto the gate under the min-complete-quorum policy.
// It deliberately does NOT chunk or compact the diff to make the over-limit
// review succeed; that is a separate, larger effort.

// Structured error code stamped on the CriticResult.error.code for this
// class, so operators can discriminate context-window degrades from
// transport/auth/transient failures in `_runs.ndjson` and `make df-stats`.
export const CONTEXT_WINDOW_ERROR_CODE = "context_window_exceeded";

// Bytes-per-token divisor for the cheap pre-flight estimate. Mirrors the
// in-repo convention already baked into the lockfile compactor's byte cap
// (`MAX_COMPACTED_DIFF_BYTES = 250_000`, documented there as "250KB ≈ 60K
// tokens" ⇒ ~4.17 bytes/token). We round DOWN to 4 so the estimate skews
// slightly HIGH (fewer bytes per token ⇒ more estimated tokens): a high-side
// estimate errs toward short-circuiting a doomed call rather than dispatching
// it. A pre-flight under-estimate is not a correctness hole anyway — the
// adapter's 400-classifier (`isContextLengthError`) still converts the raw
// provider over-limit 400 into the same clean structured error.
export const BYTES_PER_TOKEN_ESTIMATE = 4;

// Per-vendor input context windows (tokens). These are the documented model
// limits the providers enforce server-side and surface in their over-limit
// 400s; an adapter passes the relevant one into `checkContextWindow`. Named
// constants (not magic numbers at the call site) so a model-window change is
// a one-line edit with a self-documenting name.
//
//   gemini  — `The input token count exceeds the maximum number of tokens
//             allowed 1048576` (INVALID_ARGUMENT)
//   grok    — `This model's maximum prompt length is 1000000 but the request
//             contains <n> tokens`
export const GEMINI_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const GROK_CONTEXT_WINDOW_TOKENS = 1_000_000;

/**
 * Cheap, deterministic token estimate from a UTF-8 byte length. Used for the
 * PRE-FLIGHT budget check (the adapter already has the assembled prompt's
 * `byteLength` from `compileCriticPrompt`, so no tokenizer dependency or
 * extra pass over the text is needed). Returns a non-negative integer.
 *
 * Exported for direct unit testing.
 */
export function estimateTokensFromBytes(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0;
  return Math.ceil(byteLength / BYTES_PER_TOKEN_ESTIMATE);
}

/**
 * Canonical operator-facing reason string for the over-context-window
 * degrade. Single source of truth so gemini + grok (+ future adapters) emit
 * a byte-identical shape. Example:
 *
 *   "diff exceeds gemini context window (1500000 tokens > 1048576 limit)"
 *
 * `estimatedTokens` is the pre-flight estimate; `limit` is the vendor's
 * documented context window. Exported for direct unit testing.
 */
export function formatContextWindowExceededMessage(args: {
  vendor: string;
  estimatedTokens: number;
  limit: number;
}): string {
  return (
    `diff exceeds ${args.vendor} context window ` +
    `(${args.estimatedTokens} tokens > ${args.limit} limit)`
  );
}

/**
 * Classify a thrown provider error message as a context-length / over-limit
 * 400. Both target vendors surface this as an HTTP 400 (already on the
 * adapters' permanent-status set) but with a raw, vendor-specific message;
 * matching the signature lets the adapter REWRITE that raw message into the
 * clean structured reason instead of leaking provider JSON.
 *
 * Matches (case-insensitive) the documented over-limit phrasings:
 *   - gemini: "input token count exceeds the maximum number of tokens allowed"
 *   - grok/OpenAI-compatible: "maximum prompt length is <n> but the request
 *     contains <m> tokens" / "maximum context length" / generic
 *     "context length" + "exceed".
 *
 * Intentionally conservative: it keys on stable substrings of the providers'
 * over-limit copy, NOT on the numeric values (which vary per request), so it
 * stays a precise classifier and does not swallow unrelated 400s (bad model
 * id, malformed request) that must keep their original diagnostic.
 *
 * Exported for direct unit testing.
 */
export function isContextLengthError(message: string | undefined | null): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  // gemini INVALID_ARGUMENT over-limit
  if (m.includes("input token count exceeds") && m.includes("maximum number of tokens")) {
    return true;
  }
  // grok / OpenAI-compatible "maximum prompt length is N but the request contains M tokens"
  if (m.includes("maximum prompt length") && m.includes("tokens")) return true;
  // OpenAI-family canonical "maximum context length is N tokens ... your messages resulted in M tokens"
  if (m.includes("maximum context length") && m.includes("tokens")) return true;
  // Issues #181 / #182 — codex SDK over-limit shapes. Codex measures input in
  // CHARACTERS, not tokens, so its over-limit copy phrases differently than
  // the token-based vendors above: a `-32602` invalid-params error whose
  // message is `input exceeds the maximum length` / `input_too_large`. Both
  // are precise, stable substrings of the SDK's over-limit message; matching
  // them lets the codex adapter classify the server-side over-limit as
  // PERMANENT (non-retryable) instead of burning 3 retries on a doomed input.
  if (m.includes("input exceeds the maximum length")) return true;
  if (m.includes("input_too_large")) return true;
  // Defensive generic: any "context length" / "context window" phrasing paired
  // with an over-limit verb. Keeps the classifier resilient to minor copy
  // drift without matching unrelated 400s.
  if (
    (m.includes("context length") || m.includes("context window")) &&
    (m.includes("exceed") || m.includes("too long") || m.includes("too large"))
  ) {
    return true;
  }
  return false;
}

/**
 * Build the clean, schema-conformant {@link CriticResult} for an
 * over-context-window degrade. Routes through {@link buildErrorResult} so the
 * envelope (reviewer echo, empty findings, `confidence: "unknown"`,
 * `status: "error"`) is identical to every other adapter error, with:
 *   - `retryable: false` — a larger-than-the-window diff re-trips on retry;
 *     burning retry budget is pure waste.
 *   - `code: CONTEXT_WINDOW_ERROR_CODE` — discriminable in telemetry.
 *
 * Exported for direct unit testing.
 */
export function buildContextWindowExceededResult(args: {
  critic: CriticConfig;
  vendor: string;
  estimatedTokens: number;
  limit: number;
  retryCount?: number;
}): CriticResult {
  const message = formatContextWindowExceededMessage({
    vendor: args.vendor,
    estimatedTokens: args.estimatedTokens,
    limit: args.limit,
  });
  return buildErrorResult({
    critic: args.critic,
    message,
    retryable: false,
    code: CONTEXT_WINDOW_ERROR_CODE,
    ...(args.retryCount !== undefined ? { retryCount: args.retryCount } : {}),
  });
}

/**
 * PRE-FLIGHT budget gate (issue #169 preference #1). Given the assembled
 * prompt's UTF-8 byte length and the vendor's token context window, returns
 * the clean structured error {@link CriticResult} when the cheap token
 * estimate exceeds the budget, or `null` when the prompt fits (dispatch the
 * real call). Computing this BEFORE the API call short-circuits a doomed paid
 * request.
 *
 * Exported for direct unit testing.
 */
export function checkContextWindow(args: {
  critic: CriticConfig;
  vendor: string;
  promptByteLength: number;
  limit: number;
  retryCount?: number;
}): CriticResult | null {
  const estimatedTokens = estimateTokensFromBytes(args.promptByteLength);
  if (estimatedTokens <= args.limit) return null;
  return buildContextWindowExceededResult({
    critic: args.critic,
    vendor: args.vendor,
    estimatedTokens,
    limit: args.limit,
    ...(args.retryCount !== undefined ? { retryCount: args.retryCount } : {}),
  });
}

// ---------------------------------------------------------------------------
// mergeAdapterMetadata — stamp the adapter-side metadata onto the parsed
// critic JSON before strict schema validation.
//
// The critic's response is allowed to omit `criticId` and `reviewer` fields
// (older models forget; some adapters never asked the model to echo them).
// The adapter is the authoritative source of identity here — the loaded
// CriticConfig knows the id, name, adapter, runtime, and configured model;
// the SDK supplies the runtime-resolved model + agentId/runId.
//
// `runtimeModel` is the SDK's actual resolved model selection (different
// from `critic.model` if the SDK silently substituted a tier). When
// supplied, it OVERWRITES the configured model in the reviewer echo so the
// artifact reflects what actually ran, not what we asked for.
//
// Cycle 322.2 Phase F note: setting `criticId` here unconditionally means
// every CriticResult carries the per-critic id used by the multi-critic
// stats block in `agent-review-stats`.

export interface MergeAdapterMetadataArgs {
  critic: CriticConfig;
  runtimeModel?: ModelConfig | { id: string; params?: Array<{ id: string; value: string }> };
  agentId?: string;
  runId?: string;
}

export function mergeAdapterMetadata(raw: unknown, args: MergeAdapterMetadataArgs): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  obj["criticId"] = args.critic.id;
  const reviewerRaw = obj["reviewer"];
  const reviewer: Record<string, unknown> =
    reviewerRaw && typeof reviewerRaw === "object"
      ? { ...(reviewerRaw as Record<string, unknown>) }
      : {};
  reviewer["name"] = reviewer["name"] ?? args.critic.name;
  reviewer["adapter"] = args.critic.adapter;
  reviewer["runtime"] = reviewer["runtime"] ?? args.critic.runtime;
  // Echo what the SDK actually resolved to, falling back to config only
  // when the SDK doesn't expose its resolved model selection. Operators
  // reading the artifact rely on this echo as the proof signal that the
  // configured tier engaged.
  reviewer["model"] = args.runtimeModel ?? args.critic.model;
  if (args.agentId !== undefined) reviewer["agentId"] = args.agentId;
  if (args.runId !== undefined) reviewer["runId"] = args.runId;
  obj["reviewer"] = reviewer;
  return obj;
}

// ---------------------------------------------------------------------------
// normalizeCriticEcho — strip schema-invalid entries from the critic's
// echoed `validation.qualityGateResults[]` BEFORE strict schema validation.
//
// Why this lives here (issue #1484): the critic's validation block is
// informational only — the adapter overwrites it with deterministic packet
// evidence after parsing. But strict `parseCriticResult` rejects the entire
// run when any echoed entry is misshapen (e.g. model emits `gate` instead of
// the schema-required `command` field). Cursor's first-party model happens
// to converge on the right field names; Gemini, Grok, and Codex sometimes
// guess `gate`/`name`/`step` and trip the schema. The fix is to drop the
// malformed entries at the adapter boundary so the high-value payload
// (findings, verdict, summary) is preserved.
//
// Uses `parseQualityGateResult` itself as the predicate — that is the
// single source of truth for "well-formed", so this normalizer cannot drift
// from it. The downstream `parseCriticResult` will overwrite the validation
// block anyway with the deterministic packet evidence, so any well-formed
// entry that survives normalization is also discarded — the survivors only
// exist to keep the strict parse happy.
//
// Originally introduced in `cursor-sdk.ts` (cycle 322.1) but moved here
// in #1484 so every adapter routes through one source of truth instead of
// each adapter duplicating the pattern.

export function normalizeCriticEcho(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const validation = obj["validation"];
  if (typeof validation !== "object" || validation === null) return raw;
  const v = validation as Record<string, unknown>;
  const list = v["qualityGateResults"];
  if (!Array.isArray(list)) return raw;
  const cleaned = list.filter((entry, i) => {
    try {
      parseQualityGateResult(entry, `$.validation.qualityGateResults[${i}]`);
      return true;
    } catch {
      return false;
    }
  });
  return {
    ...obj,
    validation: { ...v, qualityGateResults: cleaned },
  };
}

// ---------------------------------------------------------------------------
// writeRedactedDiagnostic — single boundary for adapter diagnostic writes.
//
// SECURITY-CRITICAL: every adapter MUST route diagnostic-file writes through
// this helper. The redaction regex set lives in `security.ts:redactSecrets`
// and is applied here exactly once. If a future adapter writes its own raw
// SDK output to disk via writeFileSync, the boundary test in
// `tests/shared-boundary.test.ts` fails the suite — drift is detectable
// and reviewable, not silent.
//
// Returns the absolute path of the written file on success, or `undefined`
// when (a) no diagnostics dir was configured (caller didn't opt-in) or
// (b) the write failed (best-effort — diagnostics are debug aids, not
// gate-critical artifacts).

export interface WriteRedactedDiagnosticArgs {
  diagnosticsDir: string | undefined;
  criticId: string;
  commit: string;
  rawText: string;
}

export function writeRedactedDiagnostic(args: WriteRedactedDiagnosticArgs): string | undefined {
  if (!args.diagnosticsDir) return undefined;
  try {
    mkdirSync(args.diagnosticsDir, { recursive: true });
    const path = resolve(
      args.diagnosticsDir,
      `${args.commit}-${args.criticId}-${Date.now()}.txt`,
    );
    writeFileSync(path, redactSecrets(args.rawText), "utf8");
    return path;
  } catch {
    return undefined;
  }
}
// dogfood: trusted-surface no-op to validate #1549 fix end-to-end in CI agent-critic

// ---------------------------------------------------------------------------
// shouldEnableCursorSandbox — environment-aware sandbox toggle for the
// Cursor SDK's `local.sandboxOptions.enabled` flag.
//
// On local dev workstations we ENABLE the SDK's defense-in-depth sandbox so
// the critic process can't write outside its sandbox even if a malicious diff
// convinces the model to try. On GitHub Actions runners the SDK's sandbox
// primitive is unavailable and the SDK fails the run permanently with:
//
//   "Local SDK sandboxing was requested, but sandboxing is not supported
//    in this environment. Disable local.sandboxOptions.enabled or remove
//    ~/.cursor/sandbox.json to run without sandboxing."
//
// (Tracked at #1577.) Detecting CI and flipping the flag off keeps the
// local defense in place while letting the CI replay actually run.
//
// Both `cursor-sdk.ts` (production critic adapter) and `spike.ts` (empirical
// SDK fixture generator) call this helper so the two paths can NEVER drift
// — the spike's comment explicitly says "Match the production adapter's
// local options exactly; defenses must be identical." A single source of
// truth enforces that invariant.
//
// `CI` is set by GitHub Actions, GitLab, CircleCI, Travis, and most other
// CI systems. `GITHUB_ACTIONS` is GHA-specific and covers the case where
// `CI` was somehow unset. The check is conservative: if either signals CI,
// disable the sandbox. Locally neither is normally set, so the default
// (sandbox enabled) holds.
export function shouldEnableCursorSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  const isCI = env["CI"] === "true" || env["GITHUB_ACTIONS"] === "true";
  return !isCI;
}
