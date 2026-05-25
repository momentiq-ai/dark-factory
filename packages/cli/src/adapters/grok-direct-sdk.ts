// Cycle 322.3 — xAI Grok direct-API adapter via the `openai` npm package.
//
// Why a third adapter (manifesto §11 + §12): after 322.2 added the
// second critic family (Gemini), Sage's `block-if-any` aggregation
// still hard-blocks the gate whenever Cursor's upstream incident
// hits the `required: true` critic. The §11 SOTA is three critic
// families across four vendor lineages so a single-vendor outage
// can never paralyze the gate; 322.3 adds xAI Grok as the third
// family. xAI's training data, RLHF process, and reasoning
// architecture (always-on chain-of-thought) are uncorrelated with
// OpenAI/Google/Anthropic, so the disagreements between Grok and the
// other two critics carry the §11 information value.
//
// The adapter ships in shadow mode (`required: false` in
// `.agent-review/config.json` — Cycle 322.3 Phase D); a follow-up
// cycle 322.3.1 promotes the aggregation policy from `block-if-any`
// to `min-complete-quorum` once the calibration window data
// justifies it (Cycle 322.3 §"Two-step promotion").
//
// The adapter:
//   - implements `CriticAdapter` from `critic.ts` (the post-322.2-
//     migration shape with `requiredEnvVars`)
//   - uses xAI's documented Responses API
//     (`client.responses.create({ ..., reasoning: { effort }, stream: true })`)
//     rather than Chat Completions, because the Responses API exposes a
//     3-tier `reasoning.effort` (low/medium/high) where Chat Completions
//     only exposes a binary low/high — the 3-tier matches the
//     chief-engineer critic role's match for Cursor's `reasoning=extra-high`
//     posture. See `tools/agent-review/evals/spike-grok-responses-2026-05.md`
//     for the API decision artifact.
//   - mirrors the 322.1 retry shape (`runRetryLoop` + `attemptReview`)
//     from a single source of truth in `cursor-sdk.ts`, so the policy +
//     budget are byte-identical across adapters and any future fix lands
//     in one place
//   - routes diagnostic-redaction + JSON parsing + reviewer-metadata merge
//     + error-result construction through `_shared.ts` so the security
//     boundary (redactSecrets at the only writeFileSync site) cannot drift
//   - is read-only by structure: no `tools` configured on the request;
//     the only output channel is the JSON response itself (so a malicious
//     diff convincing the model to "run a command" has no command surface)
//
// The implementation uses the dependency-injection ESCAPE hatch on the
// constructor (`createClient` factory) so unit tests can supply a mock
// OpenAI client without forcing the SDK to be present at test time —
// this matches the testing posture of the cycle 322.1 / 322.2 adapter
// tests. The constructor is the ONLY place the real `openai` SDK is
// referenced for production use.

import OpenAI, { APIError } from "openai";

import { compileCriticPrompt } from "../prompt.js";
import {
  parseCriticResult,
  type CriticConfig,
  type CriticResult,
  type DoctorCheck,
  type ReviewPacket,
} from "@momentiq/dark-factory-schemas";

import type { CriticAdapter, CriticReviewOptions } from "./critic.js";
import {
  buildErrorResult,
  mergeAdapterMetadata,
  normalizeCriticEcho,
  parseAssistantJson,
  writeRedactedDiagnostic,
} from "./_shared.js";
import {
  runRetryLoop,
  type AttemptOutcome,
} from "./_retry.js";

export const GROK_DIRECT_SDK_ADAPTER_ID = "grok-direct-sdk";
export const XAI_API_KEY_ENV = "XAI_API_KEY";
export const XAI_BASE_URL = "https://api.x.ai/v1";

// xAI Responses API permanent-failure HTTP statuses (mirrors OpenAI
// status codes since xAI is OpenAI-compatible at the surface). Same
// classification as the Gemini permanent set — burning retry budget
// on these wastes wall-clock AND can mask the real fault (e.g., a
// wrong API key would silently exhaust retries before surfacing).
//   400 invalid_request    — bad request shape, model id typo
//   401 / 403              — auth failure
//   404 model_not_found    — model id not in the API key's allowed list
//   429 rate_limit         — quota / rate-limit (retrying within 20s
//                            burns budget; surface immediately so the
//                            operator can investigate)
// Anything else (5xx, 504, transient network) is retryable. The retry
// budget is bounded by `runRetryLoop` to 2 retries / 20s wall-clock.
export const GROK_PERMANENT_STATUS: ReadonlySet<number> = new Set([
  400,
  401,
  403,
  404,
  429,
]);

// xAI Responses API reasoning-effort options. The 3-tier control is
// the documented xAI surface (https://docs.x.ai/docs/api-reference);
// Chat Completions exposes only a binary low/high which would defeat
// the cycle's match-Cursor-extra-high reasoning posture.
//
// xAI Grok 4.3 documentation
// (https://docs.x.ai/developers/models/grok-4.3#capabilities) lists
// `none` alongside `low | medium | high` as a valid effort value —
// `none` is the escape hatch for non-reasoning use cases. xAI's
// docs say an unspecified effort can default to low reasoning, so
// the adapter must send the explicit `none` value when configured
// instead of dropping the `reasoning` object.
const ALLOWED_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "none",
]);
export const DEFAULT_REASONING_EFFORT = "high" as const;
export type GrokReasoningEffort = "low" | "medium" | "high" | "none";

/**
 * Test-shape compatible with the `openai` SDK's OpenAI client. The
 * unit tests pass a mock conforming to this shape; production passes
 * the real `new OpenAI({ apiKey, baseURL })` instance through the
 * `createClient` factory on the adapter constructor.
 *
 * Documenting this shape here (rather than relying on the SDK's
 * exported type) lets the test mocks stay narrow and resilient to
 * SDK internal shape changes. The adapter uses ONLY the surface
 * declared here — every SDK method the adapter calls is on this
 * interface, so an SDK upgrade that re-shapes other surfaces won't
 * silently break the adapter.
 */
export interface GrokClient {
  responses: {
    create: (
      params: GrokResponsesCreateParams,
      requestOptions?: { signal?: AbortSignal },
    ) => Promise<AsyncIterable<GrokStreamEvent>>;
  };
  models: {
    list: () => AsyncIterable<{ id?: string }> | Promise<AsyncIterable<{ id?: string }>>;
  };
}

export interface GrokResponsesCreateParams {
  model: string;
  reasoning?: { effort?: GrokReasoningEffort };
  input: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  text?: { format?: { type: "json_object" } };
  store?: false;
  stream: true;
}

/**
 * The shape of a single xAI Responses API stream event. xAI mirrors
 * the OpenAI Responses API stream contract, where each event carries
 * a `type` discriminator (`response.output_text.delta`,
 * `response.completed`, `response.failed`, `response.refusal.delta`,
 * etc.). The adapter only reads:
 *   - `type` (for dispatch)
 *   - `delta` (on output_text.delta — the text accumulator)
 *   - `response.usage.input_tokens` + `response.usage.output_tokens`
 *     (on response.completed — the telemetry token-usage signal)
 *   - `response.refusal_text` or similar (on response.refusal.*; the
 *     safety-block permanent-failure path)
 *
 * Field shapes treated as `unknown` so the adapter is resilient to
 * xAI extending the event envelope between when this was written and
 * when it runs. The actual stream event shape is captured in
 * `tools/agent-review/evals/spike-grok-responses-2026-05.md`.
 */
export interface GrokStreamEvent {
  type?: string;
  // On response.output_text.delta:
  delta?: string;
  // On response.completed AND response.incomplete:
  response?: {
    id?: string;
    usage?: GrokUsage;
    // Some completion shapes carry the full output here as well; we
    // prefer the streamed deltas because they're chunked, but if
    // deltas were dropped we can fall back to walking `output[].content[].text`.
    output?: Array<{
      content?: Array<{ text?: string; type?: string }>;
    }>;
    // On response.incomplete: details about why the response was
    // truncated (max_output_tokens, content_filter, etc.). Surfaced
    // as a distinct error code so operators can distinguish
    // truncation from transport failures in `_runs.ndjson`.
    incomplete_details?: {
      reason?: string;
    };
  };
  // On response.refusal.delta:
  refusal?: string;
}

export interface GrokUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface GrokDirectSdkAdapterOptions {
  apiKey?: string;
  // Test escape hatch: inject a mock client. In production the
  // adapter constructs `new OpenAI({ apiKey, baseURL: XAI_BASE_URL })`
  // from the env-loaded API key on each `review()` call (one client
  // per call is a no-op in `openai`; the client is a thin wrapper
  // around fetch).
  createClient?: (apiKey: string) => GrokClient;
  // Test escape hatch for the retry-loop sleep. When unset the
  // adapter uses the real `sleepForRetry` (wall-clock + AbortSignal-
  // aware). Mirrors the same hook on `runRetryLoop` so tests don't
  // have to wait 5s + 15s of real backoff to exercise retry
  // behavior.
  sleep?: (idx: number, signal: AbortSignal | undefined) => Promise<void>;
}

/**
 * Resolve the Grok reasoning-effort from the critic config's
 * `model.params`. Falls back to {@link DEFAULT_REASONING_EFFORT}
 * ("high") when unset. Validates against the documented
 * Responses-API surface — invalid values fall back to the default
 * rather than corrupting the request body.
 *
 * Coerces string inputs (the config schema's `value` is
 * `string|number|boolean`; reasoning effort is always a string
 * enum). Booleans and numbers are operator typos and use the
 * default.
 *
 * Exported for direct unit testing (no SDK mock required).
 */
export function resolveReasoningEffort(critic: CriticConfig): GrokReasoningEffort {
  const param = critic.model.params.find((p) => p.id === "reasoning_effort");
  if (!param) return DEFAULT_REASONING_EFFORT;
  const v = param.value;
  if (typeof v !== "string") return DEFAULT_REASONING_EFFORT;
  const norm = v.toLowerCase();
  if (ALLOWED_REASONING_EFFORTS.has(norm)) {
    return norm as GrokReasoningEffort;
  }
  return DEFAULT_REASONING_EFFORT;
}

/**
 * Probe a thrown error for an xAI Responses API HTTP status code.
 * Returns `null` when the error didn't carry one (network error,
 * non-API exception). Exported for direct unit testing.
 *
 * The `openai` SDK throws `APIError extends Error` with a `status:
 * number` field on HTTP-level failures; a non-API failure (DNS,
 * timeout in fetch, etc.) won't have this field set. Treating "no
 * status" as retryable lets the loop catch real transient blips
 * while not silently retrying logic errors.
 */
export function extractXaiApiErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  if (typeof e["status"] === "number") return e["status"];
  // Some SDK error shapes nest the status under `response.status`:
  const response = e["response"];
  if (response && typeof response === "object") {
    const status = (response as Record<string, unknown>)["status"];
    if (typeof status === "number") return status;
  }
  return null;
}

/**
 * Policy gate: decide whether an xAI Responses API failure is
 * retryable. Returns `false` for HTTP statuses in
 * {@link GROK_PERMANENT_STATUS}, `true` otherwise (including
 * no-status network errors).
 *
 * Exported for direct unit testing.
 */
export function isGrokPermanentFailure(status: number | null): boolean {
  if (status === null) return false; // no status → treat as transient
  return GROK_PERMANENT_STATUS.has(status);
}

export class GrokDirectSdkAdapter implements CriticAdapter {
  readonly id = GROK_DIRECT_SDK_ADAPTER_ID;
  readonly requiredEnvVars: readonly string[] = [XAI_API_KEY_ENV];

  private readonly createClient: (apiKey: string) => GrokClient;

  constructor(private readonly options: GrokDirectSdkAdapterOptions = {}) {
    this.createClient =
      options.createClient ??
      ((apiKey) =>
        new OpenAI({
          apiKey,
          baseURL: XAI_BASE_URL,
        }) as unknown as GrokClient);
  }

  async review(
    packet: ReviewPacket,
    critic: CriticConfig,
    options: CriticReviewOptions,
  ): Promise<CriticResult> {
    return runRetryLoop({
      attempt: (idx) => this.attemptReview(packet, critic, options, idx),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(this.options.sleep !== undefined ? { sleep: this.options.sleep } : {}),
      buildExhausted: ({ last, totalAttempts, aborted }) => {
        const retriesUsed = Math.max(0, totalAttempts - 1);
        const summary = aborted
          ? last
            ? `grok SDK run aborted after ${retriesUsed} retries: ${last.message}`
            : "grok SDK run aborted before any attempt completed"
          : last
            ? `grok SDK run failed after ${retriesUsed} retries: ${last.message}`
            : "grok SDK run failed with no captured failure metadata";
        return buildErrorResult({
          critic,
          message: summary,
          retryable: true,
          ...(last?.errorCode != null ? { code: last.errorCode } : {}),
          retryCount: retriesUsed,
        });
      },
    });
  }

  // One attempt. Mirrors `GeminiSdkAdapter.attemptReview` shape so
  // the outer retry loop dispatches identically; differences are
  // Grok-specific (Responses API event shape, reasoning.effort param,
  // refusal-event safety-block path) and surface here.
  private async attemptReview(
    packet: ReviewPacket,
    critic: CriticConfig,
    options: CriticReviewOptions,
    attemptIdx: number,
  ): Promise<AttemptOutcome> {
    const apiKey = this.options.apiKey ?? process.env[XAI_API_KEY_ENV];
    if (!apiKey) {
      // Missing key is permanent — no retry can fix a missing secret.
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: `${XAI_API_KEY_ENV} is not set; cannot run Grok critic`,
          retryable: false,
          retryCount: attemptIdx,
        }),
      };
    }

    const prompt = compileCriticPrompt({
      packet,
      critic,
      blockingSeverities: options.blockingSeverities,
      treatDiffAsUntrusted: true,
    });

    const startMs = Date.now();
    if (attemptIdx === 0) {
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_started",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
      });
    }

    const client = this.createClient(apiKey);
    const reasoningEffort = resolveReasoningEffort(critic);

    let assistantText = "";
    let lastUsage: GrokUsage | undefined;
    let refusalText: string | undefined;
    // Cycle 322.3 Cursor critic feedback (367476d3 finding #4 §0): the
    // xAI Responses API emits `response.incomplete` when output was
    // truncated (max_output_tokens or content_filter). Treat as a
    // permanent failure with preserved accumulated text — retrying
    // the same prompt re-trips the same truncation, AND the partial
    // text is the most informative thing the operator can read.
    let incompleteReason: string | undefined;

    try {
      // `responses.create` returns either a single Response (for
      // non-streaming) or an AsyncIterable<ResponseStreamEvent>
      // (for streaming). We always stream so the result is the
      // async-iterable. Request options second-arg carries the
      // AbortSignal — the SDK threads it to the underlying fetch.
      const stream = await client.responses.create(
        {
          model: critic.model.id,
          // Always send the configured effort, including the
          // documented `none` escape hatch. Omitting this object can
          // let the API default to low reasoning.
          reasoning: {
            effort: reasoningEffort,
          },
          input: [
            {
              role: "user",
              content: prompt.text,
            },
          ],
          // Force JSON-only response. `parseAssistantJson` still
          // runs as a safety net for occasional format drift —
          // adapters never trust the structured-output guarantee
          // because a malformed terminal text would otherwise
          // produce an unparseable artifact that the gate can't
          // evaluate.
          text: { format: { type: "json_object" } },
          // Keep proprietary PR review prompts/results local. xAI's
          // Responses API stores request/response data by default;
          // `store: false` is the documented opt-out for stateless calls.
          store: false,
          stream: true,
        },
        options.signal !== undefined ? { signal: options.signal } : {},
      );

      for await (const event of stream) {
        if (options.signal?.aborted) break;
        const type = event.type ?? "";

        // Primary path: accumulate text deltas. `response.output_text.delta`
        // is the documented xAI Responses API stream event for token
        // deltas (https://docs.x.ai/docs/api-reference + OpenAI
        // Responses API contract). The spike artifact records the
        // exact event shape.
        if (type === "response.output_text.delta" && typeof event.delta === "string") {
          assistantText += event.delta;
          continue;
        }

        // Refusal events — the model declined to comply with the
        // prompt (e.g., policy-blocked content). The adapter
        // treats this as a permanent failure: retrying the same
        // prompt re-trips the same refusal.
        if (
          (type === "response.refusal.delta" || type === "response.refusal.done") &&
          typeof event.refusal === "string"
        ) {
          refusalText = refusalText
            ? refusalText + event.refusal
            : event.refusal;
          continue;
        }

        // Terminal event — extract token usage for telemetry.
        if (type === "response.completed" && event.response) {
          const usage = event.response.usage;
          if (usage) lastUsage = usage;
          // Fallback: if the stream didn't emit deltas (e.g., a
          // truncated stream that only delivered the terminal
          // event), walk `response.output[].content[].text` to
          // recover the assistant text. The deltas path is
          // preferred for backpressure-friendly accumulation.
          if (!assistantText && Array.isArray(event.response.output)) {
            for (const item of event.response.output) {
              const parts = item.content;
              if (!Array.isArray(parts)) continue;
              for (const part of parts) {
                if (typeof part.text === "string") {
                  assistantText += part.text;
                }
              }
            }
          }
        }

        // `response.failed` is xAI's terminal-error event. We
        // synthesize a thrown error so the outer catch handles it
        // uniformly with HTTP-level failures.
        if (type === "response.failed") {
          throw new Error("xAI Responses API returned response.failed event");
        }

        // `response.incomplete` is the xAI/OpenAI Responses API
        // terminal event for truncated output (max_output_tokens
        // hit, content filter triggered, etc.). Capture the reason
        // and any final usage; the post-loop branch treats this as
        // a permanent failure (retrying with the same prompt
        // re-trips the same truncation).
        if (type === "response.incomplete" && event.response) {
          const usage = event.response.usage;
          if (usage) lastUsage = usage;
          incompleteReason =
            event.response.incomplete_details?.reason ?? "unknown";
        }
      }
    } catch (err) {
      const e = err as Error;
      const status =
        err instanceof APIError ? err.status : extractXaiApiErrorStatus(err);
      const permanent = isGrokPermanentFailure(status);
      const codeStr = status !== null ? `http_${status}` : "transport_error";
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: e.message,
        status: permanent ? "run_failure_permanent" : "run_failure",
        retryCount: attemptIdx,
        errorCode: codeStr,
      });
      if (permanent) {
        return {
          kind: "permanent_failure",
          errorCode: codeStr,
          statusMessage: null,
          result: buildErrorResult({
            critic,
            message: `grok SDK run failed (permanent, status=${status ?? "?"}): ${e.message}`,
            retryable: false,
            code: codeStr,
            retryCount: attemptIdx,
          }),
        };
      }
      return {
        kind: "retryable_failure",
        errorCode: codeStr,
        statusMessage: null,
        message: `grok SDK run failed: ${e.message}`,
        runId: null,
        agentId: null,
      };
    }

    if (incompleteReason) {
      // Truncation — permanent. Preserve the accumulated partial
      // text in the diagnostic artifact for operator inspection
      // (the truncated content is what would let the operator
      // raise `max_output_tokens` or revise the prompt). The
      // distinct `incomplete` errorCode lets operators
      // discriminate truncation patterns from transport failures
      // in `_runs.ndjson` — important because the remediation
      // differs (raise max_output_tokens vs. fix vendor incident).
      const diagPath = writeRedactedDiagnostic({
        diagnosticsDir: options.diagnosticsDir,
        criticId: critic.id,
        commit: packet.commit.sha,
        rawText: assistantText,
      });
      const msg = `grok critic response truncated: ${incompleteReason} (partial text preserved)`;
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: msg,
        status: "incomplete",
        retryCount: attemptIdx,
        errorCode: "incomplete",
      });
      return {
        kind: "permanent_failure",
        errorCode: "incomplete",
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: msg,
          retryable: false,
          code: "incomplete",
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    if (refusalText) {
      // Model refusal — permanent. Retrying the same prompt
      // re-trips the same refusal. The refusal text goes into the
      // critic-result envelope so operators can inspect it; the
      // diagnostic file is best-effort.
      const msg = `grok critic response refused: ${refusalText.slice(0, 200)}`;
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: msg,
        status: "refused",
        retryCount: attemptIdx,
        errorCode: "refused",
      });
      return {
        kind: "permanent_failure",
        errorCode: "refused",
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: msg,
          retryable: false,
          code: "refused",
          retryCount: attemptIdx,
        }),
      };
    }

    const parseOutcome = parseAssistantJson(assistantText);
    if (!parseOutcome.ok) {
      const diagPath = writeRedactedDiagnostic({
        diagnosticsDir: options.diagnosticsDir,
        criticId: critic.id,
        commit: packet.commit.sha,
        rawText: assistantText,
      });
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: `invalid critic JSON: ${parseOutcome.message}`,
        status: "invalid_json",
        retryCount: attemptIdx,
      });
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: `grok critic returned invalid JSON: ${parseOutcome.message}`,
          retryable: false,
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    let result: CriticResult;
    try {
      // Drop schema-invalid `validation.qualityGateResults[]` entries
      // (e.g. model emits `gate` instead of `command`) BEFORE strict
      // parsing — the validation block is informational and gets
      // overwritten below with deterministic packet evidence. Issue #1484.
      const normalized = normalizeCriticEcho(parseOutcome.value);
      const enriched = mergeAdapterMetadata(normalized, { critic });
      result = parseCriticResult(enriched, options.blockingSeverities);
    } catch (err) {
      const e = err as Error;
      const diagPath = writeRedactedDiagnostic({
        diagnosticsDir: options.diagnosticsDir,
        criticId: critic.id,
        commit: packet.commit.sha,
        rawText: assistantText,
      });
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: `schema validation failed: ${e.message}`,
        status: "schema_violation",
        retryCount: attemptIdx,
      });
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: `grok critic JSON failed schema validation: ${e.message}`,
          retryable: false,
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    const durationMs = Date.now() - startMs;
    const enriched: CriticResult = {
      ...result,
      durationMs,
      validation: {
        qualityGateResults: packet.validation.evidence,
        qualityGatesMissing: packet.validation.missing,
      },
    };
    const blockerCount = enriched.findings.filter((f) => f.severity === "blocker").length;
    const highCount = enriched.findings.filter((f) => f.severity === "high").length;

    options.emit?.({
      ts: new Date().toISOString(),
      event: "critic_run_finished",
      commit: packet.commit.sha,
      criticId: critic.id,
      adapter: this.id,
      model: critic.model.id,
      durationMs,
      ...(enriched.verdict !== undefined ? { verdict: enriched.verdict } : {}),
      findingCount: enriched.findings.length,
      blockerCount,
      highCount,
      ...(typeof lastUsage?.input_tokens === "number"
        ? { tokensIn: lastUsage.input_tokens }
        : {}),
      ...(typeof lastUsage?.output_tokens === "number"
        ? { tokensOut: lastUsage.output_tokens }
        : {}),
      status: "complete",
      retryCount: attemptIdx,
    });

    return { kind: "success", result: enriched };
  }

  async doctor(critic: CriticConfig): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const apiKey = this.options.apiKey ?? process.env[XAI_API_KEY_ENV];
    const missingOptionalKey = !apiKey && !critic.required;
    checks.push({
      name: "xai_api_key",
      passed: Boolean(apiKey) || missingOptionalKey,
      detail: apiKey
        ? `${XAI_API_KEY_ENV} present`
        : missingOptionalKey
          ? `${XAI_API_KEY_ENV} missing; optional shadow critic will be skipped at review time`
          : `${XAI_API_KEY_ENV} missing`,
      ...(apiKey || missingOptionalKey
        ? {}
        : {
            remediation: `export ${XAI_API_KEY_ENV}=... or add it to the Doppler scope (sage/dev). See spike artifact tools/agent-review/evals/spike-grok-models-2026-05.md §"Operator runbook" for the provisioning one-liner.`,
          }),
    });

    let sdkLoaded = false;
    try {
      // The dynamic import path catches both "package missing on
      // disk" and "package present but no exports we recognize"
      // (older shape) cases.
      const mod = (await import("openai")) as Record<string, unknown>;
      sdkLoaded = typeof mod["default"] === "function" || typeof mod["OpenAI"] === "function";
    } catch {
      sdkLoaded = false;
    }
    checks.push({
      name: "grok_sdk_loaded",
      passed: sdkLoaded,
      detail: sdkLoaded
        ? "openai SDK imported (used as xAI client via baseURL)"
        : "openai SDK missing or shape unexpected",
      ...(sdkLoaded
        ? {}
        : { remediation: "make agent-review-deps && make agent-review-build" }),
    });

    // Diagnostic family-prefix check: a stale config that pins to the
    // retired `grok-4` (or `grok-4-fast`, `grok-4-1-fast`,
    // `grok-code-fast-1`) cohort can be flagged BEFORE the live
    // models.list() call below — useful when the operator's API key
    // isn't yet provisioned but the doctor is still expected to
    // catch obvious config errors.
    const familyOk = critic.model.id.toLowerCase().startsWith("grok");
    checks.push({
      name: "grok_model_id_family",
      passed: familyOk,
      detail: familyOk
        ? `${critic.model.id} matches grok-* family pattern`
        : `${critic.model.id} does NOT match grok-* family pattern`,
      ...(familyOk
        ? {}
        : {
            remediation:
              "the configured Grok critic's model.id should start with 'grok-' (e.g., 'grok-4.3'). Update .agent-review/config.json:critics[].model.id.",
          }),
    });

    if (!sdkLoaded || !apiKey) return checks;

    // Verify the configured model id resolves via models.list(). The
    // xAI 2026-05-15 retirement cohort makes this check load-bearing
    // — without it, a first-run after the retirement date would fail
    // at review time with a less-actionable HTTP 404. Per
    // spike-grok-models-2026-05.md, the live list call records the
    // canonical id; the doctor confirms the configured id is in the
    // live catalog.
    try {
      const client = this.createClient(apiKey);
      const list = client.models.list;
      if (typeof list !== "function") {
        checks.push({
          name: "grok_model_listing",
          passed: false,
          detail: "openai SDK models.list not exposed; cannot verify model id",
          remediation:
            "Run `make agent-review-spike-grok` (source at tools/agent-review/src/spikes/grok-models-list-2026-05.ts) and confirm the configured id is current.",
        });
        return checks;
      }
      // The SDK exposes `models.list` as either a function returning
      // an AsyncIterable directly OR a function returning a Promise
      // of an AsyncIterable (Pager). Handle both shapes — the
      // production OpenAI SDK returns a Page that is itself async-
      // iterable; older mocks may return a Promise. Same defensive
      // handling as the Gemini adapter's doctor.
      const listed = list.call(client.models);
      const iterable: AsyncIterable<{ id?: string }> =
        listed && typeof (listed as Promise<unknown>).then === "function"
          ? await (listed as Promise<AsyncIterable<{ id?: string }>>)
          : (listed as AsyncIterable<{ id?: string }>);
      const ids: string[] = [];
      for await (const m of iterable) {
        if (typeof m.id === "string") ids.push(m.id);
      }
      const matched = ids.some((n) => n === critic.model.id);
      checks.push({
        name: "grok_model_id",
        passed: matched,
        detail: matched
          ? `model ${critic.model.id} available`
          : `model ${critic.model.id} not in available list (${ids.slice(0, 8).join(", ")}${ids.length > 8 ? "..." : ""})`,
        ...(matched
          ? {}
          : {
              remediation:
                "update .agent-review/config.json:critics[].model.id (see tools/agent-review/evals/spike-grok-models-2026-05.md or run `make agent-review-spike-grok` to refresh)",
            }),
      });
    } catch (err) {
      checks.push({
        name: "grok_model_id",
        passed: false,
        detail: `models.list() failed: ${(err as Error).message}`,
        remediation: `verify ${XAI_API_KEY_ENV} and network connectivity (xAI endpoint: ${XAI_BASE_URL})`,
      });
    }
    return checks;
  }
}
