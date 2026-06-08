// Cycle 20 — MiniMax M3 critic adapter via the `openai` npm package
// against OpenRouter's OpenAI-compatible inference endpoint.
//
// Provider decision (cycle20 D1, pivoted 2026-06-08): MiniMax M3 is
// served through OpenRouter, whose `minimax/minimax-m3` endpoint routes
// to MiniMax's own provider — headquartered in SG, with inference
// datacenters in the US (per OpenRouter's per-provider residency
// metadata). The pivot from the original Together AI plan (#302: Together
// never shipped M3) keeps the inference compute US-based, which is the
// data-residency property the hosted critic requires. The SG corporate
// jurisdiction is a compliance-posture note surfaced to compliance, not a
// runtime concern of this adapter.
//
// Why a fifth adapter (cycle20 § Scope): the four-vendor critic fleet
// (cursor + codex + gemini + grok) leaves four vendor lineages
// (Anthropic-adjacent / OpenAI / Google / xAI). MiniMax M3 is an OSS-
// weights model whose training distribution + RLHF process are
// uncorrelated with those four, so adding it as a 5th critic carries
// the same § "uncorrelated lineage" information value that motivated
// the original Grok add (cycle 322.3) — a single-vendor outage can
// never paralyze the gate, AND inter-critic disagreement on a hard PR
// carries more signal than four-of-four agreement.
//
// The adapter:
//   - implements `CriticAdapter` from `critic.ts` with
//     `requiredEnvVars = [OPEN_ROUTER_API_KEY_ENV]`
//   - calls OpenRouter's `/v1/chat/completions` endpoint (OpenAI-
//     compatible Chat Completions API; cycle20 D3 explicitly chose
//     this shape over the Responses API because OpenRouter exposes
//     Chat Completions for MiniMax M3)
//   - sends `provider.data_collection: "deny"` so OpenRouter only routes
//     to a provider that does not retain/train on the prompt — the
//     prompt is third-party customer diff content. This is a fail-LOUD
//     compliance default: if the request 404s with "no allowed
//     providers", that means MiniMax-on-OpenRouter can NOT guarantee
//     no-retention, which is a compliance finding to escalate — NOT a
//     reason to silently flip to "allow". Overridable via the
//     `dataCollection` constructor option, and sent for any OpenRouter
//     host (matched by hostname, not exact string — so trailing-slash /
//     path variants still get it); a custom `baseUrl` pointing at a
//     genuinely different OpenAI-compatible endpoint omits this
//     OpenRouter-specific `provider` field.
//   - token-accounts off the OpenAI-format `usage` field on the
//     terminal `chunk.usage` of the streamed response (matching the
//     OpenAI SDK contract — `stream_options: { include_usage: true }`
//     surfaces `usage` on the final chunk), including the cached-prefix
//     token count (`usage.prompt_tokens_details.cached_tokens`) that
//     OpenRouter bills at the cache-read rate ($0.06/Mtok vs $0.30 input)
//   - mirrors the 322.1 retry shape (`runRetryLoop` + `attemptReview`)
//     from a single source of truth in `cursor-sdk.ts`, so the policy +
//     budget are byte-identical across adapters
//   - routes diagnostic-redaction + JSON parsing + reviewer-metadata
//     merge + error-result construction through `_shared.ts` so the
//     security boundary (redactSecrets at the only writeFileSync site)
//     cannot drift
//   - is read-only by structure: no `tools` configured on the request;
//     the only output channel is the JSON response itself
//
// The implementation uses the dependency-injection ESCAPE hatch on the
// constructor (`createClient` factory) so unit tests can supply a mock
// OpenAI client without forcing the SDK to be present at test time —
// matching the testing posture of the cycle 322.3 grok adapter tests.

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

export const MINIMAX_DIRECT_SDK_ADAPTER_ID = "minimax-direct-sdk";
export const OPEN_ROUTER_API_KEY_ENV = "OPEN_ROUTER_API_KEY";
// OpenRouter's OpenAI-compatible inference endpoint. The MiniMax M3
// model id (`minimax/minimax-m3`) is configured via `critic.model.id`
// and routed by OpenRouter's model dispatch on `/v1/chat/completions`.
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * True iff `baseUrl`'s host is OpenRouter (any path / trailing-slash variant,
 * and regional `*.openrouter.ai` subdomains). Gates the OpenRouter-specific
 * `provider` routing field by HOST rather than exact string equality, so the
 * no-retention compliance constraint is applied to ALL OpenRouter targets and
 * omitted only for a genuinely different OpenAI-compatible host. A malformed
 * URL returns `false` (treated as non-OpenRouter). Exported for unit testing.
 */
export function isOpenRouterEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

// Compliance default for OpenRouter provider routing. "deny" => only
// route to a provider that does not store/train on the prompt. See the
// file header for the fail-loud rationale.
export type OpenRouterDataCollection = "deny" | "allow";
export const OPENROUTER_DATA_COLLECTION_DEFAULT: OpenRouterDataCollection = "deny";

// Chat Completions permanent-failure HTTP statuses — same buckets as
// the Grok adapter uses against the Responses API since both OpenRouter
// (OpenAI-compatible) and OpenAI itself share status semantics. Burning
// retry budget on these wastes wall-clock AND can mask the real fault
// (e.g., a wrong API key would silently exhaust retries before
// surfacing).
//   400 invalid_request    — bad request shape, model id typo
//   401 / 403              — auth failure
//   404 model_not_found    — model id not in the provider's catalog, OR
//                            no allowed provider (data_collection=deny +
//                            no eligible provider — a compliance signal)
//   429 rate_limit         — quota / rate-limit (retrying within 20s
//                            burns budget; surface immediately so the
//                            operator can investigate)
// Anything else (5xx, 504, transient network) is retryable. The retry
// budget is bounded by `runRetryLoop` to 2 retries / 20s wall-clock.
export const MINIMAX_PERMANENT_STATUS: ReadonlySet<number> = new Set([
  400,
  401,
  403,
  404,
  429,
]);

/**
 * Test-shape compatible with the `openai` SDK's OpenAI client. The unit
 * tests pass a mock conforming to this shape; production passes the real
 * `new OpenAI({ apiKey, baseURL })` instance through the `createClient`
 * factory on the adapter constructor.
 *
 * Documenting this shape here (rather than relying on the SDK's exported
 * type) lets the test mocks stay narrow and resilient to SDK internal
 * shape changes. The adapter uses ONLY the surface declared here.
 */
export interface MinimaxClient {
  chat: {
    completions: {
      create: (
        params: MinimaxChatCompletionsCreateParams,
        requestOptions?: { signal?: AbortSignal },
      ) => Promise<AsyncIterable<MinimaxStreamChunk>>;
    };
  };
  models: {
    list: () => AsyncIterable<{ id?: string }> | Promise<AsyncIterable<{ id?: string }>>;
  };
}

export interface MinimaxChatCompletionsCreateParams {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  response_format?: { type: "json_object" };
  stream: true;
  // The OpenAI Chat Completions streaming contract requires
  // `stream_options.include_usage` to surface `usage` on the terminal
  // chunk. OpenRouter passes this through to MiniMax M3 unchanged.
  stream_options?: { include_usage?: boolean };
  // OpenRouter-specific provider routing preference. Forwarded as an
  // extra body field by the OpenAI SDK (it does not strip unknown keys).
  // `data_collection: "deny"` constrains routing to a provider that does
  // not retain/train on the prompt — see file header.
  provider?: { data_collection?: OpenRouterDataCollection };
}

/**
 * One streamed chunk from the OpenAI-format Chat Completions API. We
 * read:
 *   - `choices[0].delta.content` — the text accumulator
 *   - `choices[0].finish_reason` — terminal signal (`stop`, `length`,
 *     `content_filter`) — `length` + `content_filter` are treated as
 *     truncation (permanent failure with preserved partial text); `stop`
 *     is the normal completion path
 *   - `usage.prompt_tokens` / `usage.completion_tokens` /
 *     `usage.prompt_tokens_details.cached_tokens` — telemetry token
 *     usage on the final chunk (per the OpenAI streaming contract,
 *     surfaced when `stream_options.include_usage: true` was sent)
 *
 * Field shapes treated as `unknown` so the adapter is resilient to
 * OpenRouter/OpenAI extending the chunk envelope between when this was
 * written and when it runs.
 */
export interface MinimaxStreamChunk {
  choices?: Array<{
    delta?: { content?: string; role?: string };
    finish_reason?: string | null;
    index?: number;
  }>;
  usage?: MinimaxUsage;
  id?: string;
  model?: string;
}

export interface MinimaxUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  // OpenAI-compatible cached-prefix accounting. OpenRouter surfaces the
  // cached portion of `prompt_tokens` here; it is billed at the
  // cache-read rate, so cost attribution needs it broken out.
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface MinimaxDirectSdkAdapterOptions {
  apiKey?: string;
  // Allows the worker / operator to point the adapter at a different
  // OpenAI-compatible endpoint (e.g. a regional shard, or a future
  // direct-MiniMax US endpoint). Defaults to {@link OPENROUTER_BASE_URL}.
  baseUrl?: string;
  // OpenRouter provider-routing data policy. Defaults to
  // {@link OPENROUTER_DATA_COLLECTION_DEFAULT} ("deny") — the
  // compliance-first posture for third-party customer diff content. See
  // the file header for why "deny" is fail-loud, not best-effort.
  dataCollection?: OpenRouterDataCollection;
  // Test escape hatch: inject a mock client. In production the adapter
  // constructs `new OpenAI({ apiKey, baseURL })` from the env-loaded API
  // key on each `review()` call.
  createClient?: (apiKey: string, baseUrl: string) => MinimaxClient;
  // Test escape hatch for the retry-loop sleep. When unset the adapter
  // uses the real `sleepForRetry` (wall-clock + AbortSignal-aware).
  sleep?: (idx: number, signal: AbortSignal | undefined) => Promise<void>;
}

/**
 * Probe a thrown error for an OpenAI-format API HTTP status code.
 * Returns `null` when the error didn't carry one (network error,
 * non-API exception). Exported for direct unit testing.
 *
 * The `openai` SDK throws `APIError extends Error` with a `status:
 * number` field on HTTP-level failures; a non-API failure (DNS, timeout
 * in fetch, etc.) won't have this field set. Treating "no status" as
 * retryable lets the loop catch real transient blips while not silently
 * retrying logic errors.
 */
export function extractOpenRouterApiErrorStatus(err: unknown): number | null {
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
 * Policy gate: decide whether an OpenRouter / Chat Completions failure is
 * retryable. Returns `false` for HTTP statuses in
 * {@link MINIMAX_PERMANENT_STATUS}, `true` otherwise (including
 * no-status network errors).
 *
 * Exported for direct unit testing.
 */
export function isMinimaxPermanentFailure(status: number | null): boolean {
  if (status === null) return false; // no status → treat as transient
  return MINIMAX_PERMANENT_STATUS.has(status);
}

export class MinimaxDirectSdkAdapter implements CriticAdapter {
  readonly id = MINIMAX_DIRECT_SDK_ADAPTER_ID;
  readonly requiredEnvVars: readonly string[] = [OPEN_ROUTER_API_KEY_ENV];

  private readonly createClient: (apiKey: string, baseUrl: string) => MinimaxClient;
  private readonly baseUrl: string;
  private readonly dataCollection: OpenRouterDataCollection;

  constructor(private readonly options: MinimaxDirectSdkAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? OPENROUTER_BASE_URL;
    this.dataCollection = options.dataCollection ?? OPENROUTER_DATA_COLLECTION_DEFAULT;
    this.createClient =
      options.createClient ??
      ((apiKey, baseUrl) =>
        new OpenAI({
          apiKey,
          baseURL: baseUrl,
          // OpenRouter app-attribution headers (optional; recommended so
          // usage is identifiable in the OpenRouter dashboard).
          defaultHeaders: {
            "HTTP-Referer": "https://github.com/momentiq-ai/dark-factory",
            "X-Title": "Dark Factory critic",
          },
        }) as unknown as MinimaxClient);
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
            ? `minimax SDK run aborted after ${retriesUsed} retries: ${last.message}`
            : "minimax SDK run aborted before any attempt completed"
          : last
            ? `minimax SDK run failed after ${retriesUsed} retries: ${last.message}`
            : "minimax SDK run failed with no captured failure metadata";
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

  // One attempt. Mirrors `GrokDirectSdkAdapter.attemptReview` shape so
  // the outer retry loop dispatches identically; differences are
  // Chat-Completions-specific (delta event shape on `choices[0].delta`,
  // `finish_reason='length'`/`'content_filter'` as truncation,
  // `usage` on the terminal chunk) and surface here.
  private async attemptReview(
    packet: ReviewPacket,
    critic: CriticConfig,
    options: CriticReviewOptions,
    attemptIdx: number,
  ): Promise<AttemptOutcome> {
    const apiKey = this.options.apiKey ?? process.env[OPEN_ROUTER_API_KEY_ENV];
    if (!apiKey) {
      // Missing key is permanent — no retry can fix a missing secret.
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: `${OPEN_ROUTER_API_KEY_ENV} is not set; cannot run MiniMax critic`,
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

    const client = this.createClient(apiKey, this.baseUrl);

    let assistantText = "";
    let lastUsage: MinimaxUsage | undefined;
    // OpenAI Chat Completions emits `finish_reason: 'length'` when the
    // response was truncated at `max_tokens`, or `'content_filter'` when
    // the model's safety filter triggered. Treat as permanent failure
    // with preserved accumulated text — retrying the same prompt
    // re-trips the same truncation, AND the partial text is the most
    // informative thing the operator can read.
    let truncationReason: string | undefined;

    try {
      // `chat.completions.create` returns either a single ChatCompletion
      // (for non-streaming) or an AsyncIterable<ChatCompletionChunk>
      // (for streaming). We always stream so the result is the
      // async-iterable. Request options second-arg carries the
      // AbortSignal — the SDK threads it to the underlying fetch.
      const stream = await client.chat.completions.create(
        {
          model: critic.model.id,
          messages: [
            {
              role: "user",
              content: prompt.text,
            },
          ],
          // Force JSON-only response. `parseAssistantJson` still runs as
          // a safety net for occasional format drift — adapters never
          // trust the structured-output guarantee because a malformed
          // terminal text would otherwise produce an unparseable
          // artifact that the gate can't evaluate.
          response_format: { type: "json_object" },
          stream: true,
          // OpenAI streaming contract: `usage` surfaces on the terminal
          // chunk only when `stream_options.include_usage: true` is
          // sent. Without it `lastUsage` stays undefined and the
          // telemetry payload omits token counts → null cost rows.
          stream_options: { include_usage: true },
          // Compliance: constrain OpenRouter routing to a no-retention
          // provider for the third-party customer diff. Fail-loud — see
          // file header. `provider` routing is OpenRouter-specific, so it is
          // sent for ALL OpenRouter hosts (default + path/trailing-slash
          // variants + regional shards, matched by HOST not raw string) and
          // omitted only for a genuinely different OpenAI-compatible endpoint,
          // whose caller owns its own data policy (the field is unknown there).
          ...(isOpenRouterEndpoint(this.baseUrl)
            ? { provider: { data_collection: this.dataCollection } }
            : {}),
        },
        options.signal !== undefined ? { signal: options.signal } : {},
      );

      for await (const chunk of stream) {
        if (options.signal?.aborted) break;

        // Primary path: accumulate text deltas from `choices[0].delta.content`.
        // OpenAI Chat Completions streams emit one chunk per token (or
        // per server-flush boundary); the role is set on the first chunk
        // only.
        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = choice.delta?.content;
          if (typeof delta === "string") {
            assistantText += delta;
          }
          // `finish_reason` is set on the terminal chunk for that
          // choice. `stop` = normal completion; `length` = max_tokens
          // hit; `content_filter` = safety block.
          const finishReason = choice.finish_reason;
          if (finishReason === "length" || finishReason === "content_filter") {
            truncationReason = finishReason;
          }
        }

        // Per the OpenAI streaming contract with
        // `stream_options.include_usage: true`, the terminal chunk
        // carries `usage` populated and `choices: []`. Capture it here
        // (latest-non-null wins so a future provider that re-emits
        // usage mid-stream does not silently drop the count).
        if (chunk.usage) {
          lastUsage = chunk.usage;
        }
      }
    } catch (err) {
      const e = err as Error;
      const status =
        err instanceof APIError ? err.status : extractOpenRouterApiErrorStatus(err);
      const permanent = isMinimaxPermanentFailure(status);
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
            message: `minimax SDK run failed (permanent, status=${status ?? "?"}): ${e.message}`,
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
        message: `minimax SDK run failed: ${e.message}`,
        runId: null,
        agentId: null,
      };
    }

    if (truncationReason) {
      // Truncation / content-filter — permanent. Preserve the
      // accumulated partial text in the diagnostic artifact for
      // operator inspection. The distinct `incomplete` errorCode lets
      // operators discriminate truncation patterns from transport
      // failures in `_runs.ndjson` — important because the remediation
      // differs (raise max_tokens / revise prompt vs. fix vendor
      // incident).
      const diagPath = writeRedactedDiagnostic({
        diagnosticsDir: options.diagnosticsDir,
        criticId: critic.id,
        commit: packet.commit.sha,
        rawText: assistantText,
      });
      const msg = `minimax critic response truncated: ${truncationReason} (partial text preserved)`;
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
          message: `minimax critic returned invalid JSON: ${parseOutcome.message}`,
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
      // overwritten below with deterministic packet evidence. Issue
      // #1484 (Grok same behavior).
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
          message: `minimax critic JSON failed schema validation: ${e.message}`,
          retryable: false,
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    const durationMs = Date.now() - startMs;
    const cachedTokens = lastUsage?.prompt_tokens_details?.cached_tokens;
    const enriched: CriticResult = {
      ...result,
      durationMs,
      // Cycle 6.3 — surface per-critic telemetry on the artifact-shaped
      // result. The OpenAI Chat Completions usage block exposes
      // `prompt_tokens` / `completion_tokens`; OpenRouter's MiniMax M3
      // path additionally breaks out the cached-prefix portion under
      // `prompt_tokens_details.cached_tokens` (billed at the cache-read
      // rate), captured as `tokensCached` for accurate cost attribution.
      retries: attemptIdx,
      ...(typeof lastUsage?.prompt_tokens === "number"
        ? { tokensInput: lastUsage.prompt_tokens }
        : {}),
      ...(typeof lastUsage?.completion_tokens === "number"
        ? { tokensOutput: lastUsage.completion_tokens }
        : {}),
      ...(typeof cachedTokens === "number" ? { tokensCached: cachedTokens } : {}),
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
      ...(typeof lastUsage?.prompt_tokens === "number"
        ? { tokensIn: lastUsage.prompt_tokens }
        : {}),
      ...(typeof lastUsage?.completion_tokens === "number"
        ? { tokensOut: lastUsage.completion_tokens }
        : {}),
      status: "complete",
      retryCount: attemptIdx,
    });

    return { kind: "success", result: enriched };
  }

  async doctor(critic: CriticConfig): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const apiKey = this.options.apiKey ?? process.env[OPEN_ROUTER_API_KEY_ENV];
    const missingOptionalKey = !apiKey && !critic.required;
    checks.push({
      name: "open_router_api_key",
      passed: Boolean(apiKey) || missingOptionalKey,
      detail: apiKey
        ? `${OPEN_ROUTER_API_KEY_ENV} present`
        : missingOptionalKey
          ? `${OPEN_ROUTER_API_KEY_ENV} missing; optional shadow critic will be skipped at review time`
          : `${OPEN_ROUTER_API_KEY_ENV} missing`,
      ...(apiKey || missingOptionalKey
        ? {}
        : {
            remediation: `export ${OPEN_ROUTER_API_KEY_ENV}=... or add it to the Doppler scope (dark-factory/prd). MiniMax M3 is served via OpenRouter's OpenAI-compatible inference endpoint.`,
          }),
    });

    let sdkLoaded = false;
    try {
      // The dynamic import path catches both "package missing on disk"
      // and "package present but no exports we recognize" (older shape)
      // cases.
      const mod = (await import("openai")) as Record<string, unknown>;
      sdkLoaded = typeof mod["default"] === "function" || typeof mod["OpenAI"] === "function";
    } catch {
      sdkLoaded = false;
    }
    checks.push({
      name: "minimax_sdk_loaded",
      passed: sdkLoaded,
      detail: sdkLoaded
        ? "openai SDK imported (used as OpenRouter client via baseURL)"
        : "openai SDK missing or shape unexpected",
      ...(sdkLoaded
        ? {}
        : { remediation: "npm ci --include=dev" }),
    });

    // Diagnostic family-prefix check: a stale config that pins to a
    // non-MiniMax model id can be flagged BEFORE the live models.list()
    // call below — useful when the operator's API key isn't yet
    // provisioned but the doctor is still expected to catch obvious
    // config errors. We match `minimax`-prefixed ids case-insensitively
    // (OpenRouter's slug is `minimax/minimax-m3`).
    const familyOk = critic.model.id.toLowerCase().includes("minimax");
    checks.push({
      name: "minimax_model_id_family",
      passed: familyOk,
      detail: familyOk
        ? `${critic.model.id} matches minimax-* family pattern`
        : `${critic.model.id} does NOT match minimax-* family pattern`,
      ...(familyOk
        ? {}
        : {
            remediation:
              "the configured MiniMax critic's model.id should contain 'minimax' (e.g., 'minimax/minimax-m3'). Update .agent-review/config.json:critics[].model.id.",
          }),
    });

    if (!sdkLoaded || !apiKey) return checks;

    // Verify the configured model id resolves via models.list(). Mirrors
    // the Grok doctor's live-catalog check so a future OpenRouter model
    // retirement / id rename is caught before review time.
    try {
      const client = this.createClient(apiKey, this.baseUrl);
      const list = client.models.list;
      if (typeof list !== "function") {
        checks.push({
          name: "minimax_model_listing",
          passed: false,
          detail: "openai SDK models.list not exposed; cannot verify model id",
          remediation:
            "verify the openai SDK version exposes Models.list (>= 4.x); upgrade if needed.",
        });
        return checks;
      }
      // Three shapes the doctor must handle:
      //   1. openai SDK production: `PagePromise` — thenable AND
      //      `AsyncIterable<Item>` (verified against openai@^6
      //      `node_modules/openai/core/pagination.d.ts`). Per the SDK's
      //      own doc comment on `PagePromise`: "Allow auto-paginating
      //      iteration on an unawaited list call." Direct-iterate.
      //   2. Plain AsyncIterable test mock — `list: () => ({
      //      async *[Symbol.asyncIterator]() {...} })`. Direct-iterate.
      //   3. Promise<AsyncIterable> test mock — `list: async () =>
      //      ({...})` — the result is a Promise wrapping an
      //      AsyncIterable, NOT itself async-iterable. Must await first.
      //
      // Discriminator: if the returned value implements
      // `Symbol.asyncIterator`, it's case (1) or (2) — direct-iterate.
      // Else if it's thenable, it's case (3) — await to unwrap.
      // Awaiting a `PagePromise` works too but it discards
      // auto-pagination (drops to a single Page's worth of items —
      // codex's original finding on commit c24256f), so the order of
      // the checks matters: AsyncIterable FIRST, thenable SECOND.
      const listed = list.call(client.models) as unknown;
      const hasAsyncIterator = (v: unknown): v is AsyncIterable<{ id?: string }> =>
        v !== null && typeof v === "object" && Symbol.asyncIterator in (v as object);
      const isThenable = (v: unknown): v is Promise<unknown> =>
        v !== null && typeof v === "object" && typeof (v as { then?: unknown }).then === "function";
      const iterable: AsyncIterable<{ id?: string }> = hasAsyncIterator(listed)
        ? listed
        : isThenable(listed)
          ? ((await listed) as AsyncIterable<{ id?: string }>)
          : (listed as AsyncIterable<{ id?: string }>);
      const ids: string[] = [];
      for await (const m of iterable) {
        if (typeof m.id === "string") ids.push(m.id);
      }
      const matched = ids.some((n) => n === critic.model.id);
      checks.push({
        name: "minimax_model_id",
        passed: matched,
        detail: matched
          ? `model ${critic.model.id} available`
          : `model ${critic.model.id} not in available list (${ids.slice(0, 8).join(", ")}${ids.length > 8 ? "..." : ""})`,
        ...(matched
          ? {}
          : {
              remediation:
                "update .agent-review/config.json:critics[].model.id to a model id surfaced by OpenRouter's /v1/models endpoint (e.g. 'minimax/minimax-m3')",
            }),
      });
    } catch (err) {
      checks.push({
        name: "minimax_model_id",
        passed: false,
        detail: `models.list() failed: ${(err as Error).message}`,
        remediation: `verify ${OPEN_ROUTER_API_KEY_ENV} and network connectivity (OpenRouter endpoint: ${this.baseUrl})`,
      });
    }
    return checks;
  }
}
