// Cycle 20 — MiniMax M3 direct-API adapter via the `openai` npm package
// against Together AI's OpenAI-compatible inference endpoint.
//
// Why a fifth adapter (cycle20 § Scope): the four-vendor critic fleet
// (cursor + codex + gemini + grok) leaves three vendor lineages
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
//     `requiredEnvVars = [TOGETHER_AI_API_KEY_ENV]`
//   - calls Together AI's `/v1/chat/completions` endpoint (OpenAI-
//     compatible Chat Completions API; cycle20 D3 explicitly chose
//     this shape over the Responses API because Together exposes
//     Chat Completions, not Responses, for MiniMax M3)
//   - token-accounts off the OpenAI-format `usage` field on the
//     terminal `chunk.usage` of the streamed response (matching the
//     OpenAI SDK contract — `stream_options: { include_usage: true }`
//     surfaces `usage` on the final chunk)
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
export const TOGETHER_AI_API_KEY_ENV = "TOGETHER_AI_API_KEY";
// Together AI's OpenAI-compatible inference endpoint. The MiniMax M3
// model id is configured via `critic.model.id` and routed by Together's
// model dispatch on `/v1/chat/completions`.
export const TOGETHER_AI_BASE_URL = "https://api.together.xyz/v1";

// Chat Completions permanent-failure HTTP statuses — same buckets as
// the Grok adapter uses against the Responses API since both Together
// (OpenAI-compatible) and OpenAI itself share status semantics. Burning
// retry budget on these wastes wall-clock AND can mask the real fault
// (e.g., a wrong API key would silently exhaust retries before
// surfacing).
//   400 invalid_request    — bad request shape, model id typo
//   401 / 403              — auth failure
//   404 model_not_found    — model id not in the provider's catalog
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
  // chunk. Together AI passes this through to MiniMax M3 unchanged.
  stream_options?: { include_usage?: boolean };
}

/**
 * One streamed chunk from the OpenAI-format Chat Completions API. We
 * read:
 *   - `choices[0].delta.content` — the text accumulator
 *   - `choices[0].finish_reason` — terminal signal (`stop`, `length`,
 *     `content_filter`) — `length` + `content_filter` are treated as
 *     truncation (permanent failure with preserved partial text); `stop`
 *     is the normal completion path
 *   - `usage.prompt_tokens` / `usage.completion_tokens` — telemetry
 *     token usage on the final chunk (per the OpenAI streaming contract,
 *     surfaced when `stream_options.include_usage: true` was sent)
 *
 * Field shapes treated as `unknown` so the adapter is resilient to
 * Together/OpenAI extending the chunk envelope between when this was
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
}

export interface MinimaxDirectSdkAdapterOptions {
  apiKey?: string;
  // Allows the worker / operator to point the adapter at a different
  // OpenAI-compatible Together endpoint (e.g. a regional shard, or a
  // future M3 provider that ships before Together's GA flip). Defaults
  // to {@link TOGETHER_AI_BASE_URL}.
  baseUrl?: string;
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
export function extractTogetherApiErrorStatus(err: unknown): number | null {
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
 * Policy gate: decide whether a Together / Chat Completions failure is
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
  readonly requiredEnvVars: readonly string[] = [TOGETHER_AI_API_KEY_ENV];

  private readonly createClient: (apiKey: string, baseUrl: string) => MinimaxClient;
  private readonly baseUrl: string;

  constructor(private readonly options: MinimaxDirectSdkAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? TOGETHER_AI_BASE_URL;
    this.createClient =
      options.createClient ??
      ((apiKey, baseUrl) =>
        new OpenAI({
          apiKey,
          baseURL: baseUrl,
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
    const apiKey = this.options.apiKey ?? process.env[TOGETHER_AI_API_KEY_ENV];
    if (!apiKey) {
      // Missing key is permanent — no retry can fix a missing secret.
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: `${TOGETHER_AI_API_KEY_ENV} is not set; cannot run MiniMax critic`,
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
        err instanceof APIError ? err.status : extractTogetherApiErrorStatus(err);
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
    const enriched: CriticResult = {
      ...result,
      durationMs,
      // Cycle 6.3 — surface per-critic telemetry on the artifact-shaped
      // result. The OpenAI Chat Completions usage block exposes
      // `prompt_tokens` / `completion_tokens`; Together's MiniMax M3
      // path does not surface a cached-prefix token count today, so
      // `tokensCached` stays undefined.
      retries: attemptIdx,
      ...(typeof lastUsage?.prompt_tokens === "number"
        ? { tokensInput: lastUsage.prompt_tokens }
        : {}),
      ...(typeof lastUsage?.completion_tokens === "number"
        ? { tokensOutput: lastUsage.completion_tokens }
        : {}),
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
    const apiKey = this.options.apiKey ?? process.env[TOGETHER_AI_API_KEY_ENV];
    const missingOptionalKey = !apiKey && !critic.required;
    checks.push({
      name: "together_ai_api_key",
      passed: Boolean(apiKey) || missingOptionalKey,
      detail: apiKey
        ? `${TOGETHER_AI_API_KEY_ENV} present`
        : missingOptionalKey
          ? `${TOGETHER_AI_API_KEY_ENV} missing; optional shadow critic will be skipped at review time`
          : `${TOGETHER_AI_API_KEY_ENV} missing`,
      ...(apiKey || missingOptionalKey
        ? {}
        : {
            remediation: `export ${TOGETHER_AI_API_KEY_ENV}=... or add it to the Doppler scope (dark-factory/prd). MiniMax M3 is served via Together AI's OpenAI-compatible inference endpoint.`,
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
        ? "openai SDK imported (used as Together AI client via baseURL)"
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
    // (Together's catalog uses `MiniMaxAI/MiniMax-M*` casing).
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
              "the configured MiniMax critic's model.id should contain 'minimax' (e.g., 'minimax-m3' or Together's full id). Update .agent-review/config.json:critics[].model.id.",
          }),
    });

    if (!sdkLoaded || !apiKey) return checks;

    // Verify the configured model id resolves via models.list(). Mirrors
    // the Grok doctor's live-catalog check so a future Together model
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
      // The openai SDK's `client.models.list()` returns a `PagePromise`
      // that is BOTH thenable AND `AsyncIterable<Item>` (verified
      // against openai@^6 `node_modules/openai/core/pagination.d.ts`).
      // Per the SDK's own doc comment on `PagePromise`: "Allow
      // auto-paginating iteration on an unawaited list call." Directly
      // iterating the returned value (without awaiting) is the
      // documented-correct path AND naturally accommodates test mocks
      // that return a plain `AsyncIterable` directly. Awaiting first
      // gives back a single `Page` (which IS async-iterable, but only
      // iterates one page's worth of items — a silent pagination cut
      // codex flagged on the original commit).
      const listed = list.call(client.models) as AsyncIterable<{ id?: string }>;
      const ids: string[] = [];
      for await (const m of listed) {
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
                "update .agent-review/config.json:critics[].model.id to a model id surfaced by Together AI's /v1/models endpoint",
            }),
      });
    } catch (err) {
      checks.push({
        name: "minimax_model_id",
        passed: false,
        detail: `models.list() failed: ${(err as Error).message}`,
        remediation: `verify ${TOGETHER_AI_API_KEY_ENV} and network connectivity (Together AI endpoint: ${this.baseUrl})`,
      });
    }
    return checks;
  }
}
