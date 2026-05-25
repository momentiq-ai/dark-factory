// Cycle 322.2 — Gemini direct-API adapter via `@google/genai`.
//
// Why a second adapter (manifesto §11): a single critic shares all of its
// blind spots with itself. Adding a second critic on a different vendor
// lineage (Google Gemini ≠ OpenAI/Cursor) is the literal §11 implementation:
// the disagreements between the two critics are the value, even when they
// agree most of the time. This adapter ships in shadow mode (`required:
// false` in `.agent-review/config.json`) so its findings are informational
// during the calibration window before 322.3's `min-complete-quorum` policy
// promotes the multi-critic config to default.
//
// The adapter:
//   - implements `CriticAdapter` from `critic.ts` (post-Component-3
//     migration, which adds `requiredEnvVars`)
//   - mirrors the 322.1 retry shape (`runRetryLoop` + `attemptReview`)
//     from a single source of truth in `cursor-sdk.ts`, so the policy +
//     budget are byte-identical across adapters and any future fix lands
//     in one place
//   - routes diagnostic-redaction + JSON parsing + reviewer-metadata merge
//     + error-result construction through `_shared.ts` so the security
//     boundary (redactSecrets at the only writeFileSync site) cannot drift
//   - is read-only by structure: no `tools` / function-calling configured;
//     the only output channel is the JSON response itself (so a malicious
//     diff convincing the model to "run a command" has no command surface)
//   - guards the chunk `text` getter with try/catch — Gemini stream
//     chunks can be safety-filtered or empty payloads where the
//     getter throws
//
// The implementation deliberately uses the dependency-injection ESCAPE
// hatch on the constructor (`createClient` factory) so unit tests can
// supply a mock GoogleGenAI without forcing the SDK to be present at test
// time — this matches the testing posture of the cycle 322.1 retry tests.

import {
  ApiError,
  GoogleGenAI,
  type GenerateContentResponse,
} from "@google/genai";

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

export const GEMINI_SDK_ADAPTER_ID = "gemini-sdk";
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

// Default thinking-token budget when the critic config does not specify one.
// 32k is enough headroom for a deep review of a typical PR diff while
// staying well under the model's max thinking budget. Operators can override
// per-critic via `critic.model.params: [{ id: "thinkingBudget", value: 65536 }]`.
//
// Setting `thinkingBudget = 0` would disable Gemini thinking entirely; that
// is intentionally allowed (cost optimization for cheap-pass critics) but
// not the default.
export const DEFAULT_THINKING_BUDGET = 32_768;

// Gemini API permanent failures by HTTP status. The classification is
// derived from Google's API contract:
//   400 INVALID_ARGUMENT       — bad request shape, model name typo
//   401 / 403                  — auth failure
//   404 NOT_FOUND              — model id not in caller's project
//   429 RESOURCE_EXHAUSTED     — quota / rate-limit (retrying within 20s
//                                burns budget; surface immediately so the
//                                operator can investigate)
// Anything else (5xx, 504, transient network) is retryable. The retry
// budget is bounded by `runRetryLoop` to 2 retries / 20s wall-clock.
export const GEMINI_PERMANENT_STATUS: ReadonlySet<number> = new Set([
  400,
  401,
  403,
  404,
  429,
]);

/**
 * Test-shape compatible with the `@google/genai` GoogleGenAI client. The
 * unit tests pass a mock conforming to this shape; production passes the
 * real `new GoogleGenAI({ apiKey })` instance through the
 * `createClient` factory on the adapter constructor.
 *
 * Documenting this shape here (rather than relying on the SDK's exported
 * type) lets the test mocks stay narrow and resilient to SDK internal
 * shape changes.
 */
export interface GeminiClient {
  models: {
    generateContentStream: (params: {
      model: string;
      contents: string | Array<{ role: string; parts: Array<{ text: string }> }>;
      config?: {
        abortSignal?: AbortSignal;
        temperature?: number;
        responseMimeType?: string;
        thinkingConfig?: { thinkingBudget?: number };
      };
    }) => Promise<AsyncIterable<GeminiStreamChunk>>;
    list?: (params?: Record<string, unknown>) => Promise<AsyncIterable<{ name?: string }>>;
  };
}

/**
 * Stream chunk shape used by the adapter. The `text` getter on the real
 * SDK chunk can THROW for safety-filtered or empty payloads — guarding
 * via try/catch is mandatory. The structured `candidates` path is the
 * fallback for older SDK responses.
 */
export interface GeminiStreamChunk {
  // Property accessor on the real SDK; getter that may throw.
  readonly text?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: {
    blockReason?: string;
  };
}

export interface GeminiSdkAdapterOptions {
  apiKey?: string;
  // Test escape hatch: inject a mock client. In production the adapter
  // constructs `new GoogleGenAI({ apiKey })` from the env-loaded API key
  // on each `review()` call (one client per call is a no-op in @google/genai;
  // the client is a thin wrapper around fetch).
  createClient?: (apiKey: string) => GeminiClient;
  // Test escape hatch for the retry-loop sleep. When unset the adapter
  // uses the real `sleepForRetry` (wall-clock + AbortSignal-aware).
  // Mirrors the same hook on `runRetryLoop` so tests don't have to wait
  // 5s + 15s of real backoff to exercise retry behavior.
  sleep?: (idx: number, signal: AbortSignal | undefined) => Promise<void>;
}

/**
 * Resolve the Gemini thinking budget from the critic config's
 * `model.params`. Falls back to {@link DEFAULT_THINKING_BUDGET} when
 * unset. Coerces string/number inputs (config schema allows both).
 *
 * Negative or non-finite values are treated as "use default" — Gemini
 * accepts 0 (disabled) and -1 (automatic) as sentinels, so the helper
 * preserves those exact values; anything else outside [0, +Infinity)
 * falls back to the default rather than corrupting the request.
 *
 * Exported for direct unit testing (no SDK mock required).
 */
export function resolveThinkingBudget(critic: CriticConfig): number {
  const param = critic.model.params.find((p) => p.id === "thinkingBudget");
  if (!param) return DEFAULT_THINKING_BUDGET;
  const v = param.value;
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") n = Number(v);
  else if (typeof v === "boolean") return DEFAULT_THINKING_BUDGET; // boolean is meaningless here
  else return DEFAULT_THINKING_BUDGET;
  if (!Number.isFinite(n)) return DEFAULT_THINKING_BUDGET;
  // Gemini sentinel values: 0 = disabled, -1 = automatic. Preserve them.
  if (n === 0 || n === -1) return n;
  // Anything below -1 is an operator typo (e.g., -32768). Fall back to default.
  if (n < 0) return DEFAULT_THINKING_BUDGET;
  return Math.floor(n);
}

/**
 * Probe a thrown error for a Gemini API HTTP status code. Returns `null`
 * when the error didn't carry one (network error, non-API exception).
 * Exported for direct unit testing.
 *
 * The SDK throws `ApiError extends Error` with a `status: number`
 * field; a non-API failure (DNS, timeout in fetch, etc.) won't have this
 * field set. Treating "no status" as retryable lets the loop catch real
 * transient blips while not silently retrying logic errors.
 */
export function extractApiErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  // Direct property on the SDK's ApiError class
  if (typeof e["status"] === "number") return e["status"];
  // Some SDK error shapes nest it under `error.code`
  const inner = e["error"];
  if (inner && typeof inner === "object") {
    const code = (inner as Record<string, unknown>)["code"];
    if (typeof code === "number") return code;
  }
  return null;
}

/**
 * Policy gate: decide whether a Gemini SDK failure is retryable.
 * Returns `false` for HTTP statuses in {@link GEMINI_PERMANENT_STATUS},
 * `true` otherwise (including no-status network errors).
 *
 * Exported for direct unit testing.
 */
export function isGeminiPermanentFailure(status: number | null): boolean {
  if (status === null) return false; // no status → treat as transient
  return GEMINI_PERMANENT_STATUS.has(status);
}

export class GeminiSdkAdapter implements CriticAdapter {
  readonly id = GEMINI_SDK_ADAPTER_ID;
  readonly requiredEnvVars: readonly string[] = [GEMINI_API_KEY_ENV];

  private readonly createClient: (apiKey: string) => GeminiClient;

  constructor(private readonly options: GeminiSdkAdapterOptions = {}) {
    this.createClient =
      options.createClient ??
      ((apiKey) => new GoogleGenAI({ apiKey }) as unknown as GeminiClient);
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
            ? `gemini SDK run aborted after ${retriesUsed} retries: ${last.message}`
            : "gemini SDK run aborted before any attempt completed"
          : last
            ? `gemini SDK run failed after ${retriesUsed} retries: ${last.message}`
            : "gemini SDK run failed with no captured failure metadata";
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

  // One attempt. Mirrors `CursorSdkAdapter.attemptReview` shape so the
  // outer retry loop dispatches identically; differences are
  // Gemini-specific (no agentId/runId, JSON-only responseMimeType,
  // thinkingConfig) and surface here.
  private async attemptReview(
    packet: ReviewPacket,
    critic: CriticConfig,
    options: CriticReviewOptions,
    attemptIdx: number,
  ): Promise<AttemptOutcome> {
    const apiKey = this.options.apiKey ?? process.env[GEMINI_API_KEY_ENV];
    if (!apiKey) {
      // Missing key is permanent — no retry can fix a missing secret.
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: `${GEMINI_API_KEY_ENV} is not set; cannot run Gemini critic`,
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
    const thinkingBudget = resolveThinkingBudget(critic);

    let assistantText = "";
    let lastUsage: GeminiStreamChunk["usageMetadata"];
    let blockReason: string | undefined;

    try {
      const stream = await client.models.generateContentStream({
        model: critic.model.id,
        contents: [{ role: "user", parts: [{ text: prompt.text }] }],
        config: {
          ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
          temperature: 0,
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget },
        },
      });

      for await (const chunk of stream as AsyncIterable<
        GenerateContentResponse | GeminiStreamChunk
      >) {
        if (options.signal?.aborted) break;
        // Guard the .text getter — for safety-blocked or empty chunks it
        // can throw on the real SDK. The structured `candidates` path is
        // the fallback.
        try {
          const t = (chunk as GeminiStreamChunk).text;
          if (typeof t === "string" && t.length > 0) {
            assistantText += t;
          }
        } catch {
          // fall through to structured-extraction path
        }
        const candidates = (chunk as GeminiStreamChunk).candidates;
        if (Array.isArray(candidates)) {
          for (const cand of candidates) {
            const parts = cand.content?.parts;
            if (!Array.isArray(parts)) continue;
            for (const part of parts) {
              if (typeof part.text === "string") {
                // Avoid double-counting if `.text` already worked above.
                if (!assistantText.endsWith(part.text)) {
                  assistantText += part.text;
                }
              }
            }
          }
        }
        const usage = (chunk as GeminiStreamChunk).usageMetadata;
        if (usage) lastUsage = usage;
        const feedback = (chunk as GeminiStreamChunk).promptFeedback;
        if (feedback?.blockReason && !blockReason) blockReason = feedback.blockReason;
      }
    } catch (err) {
      const e = err as Error;
      const status = err instanceof ApiError ? err.status : extractApiErrorStatus(err);
      const permanent = isGeminiPermanentFailure(status);
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
            message: `gemini SDK run failed (permanent, status=${status ?? "?"}): ${e.message}`,
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
        message: `gemini SDK run failed: ${e.message}`,
        runId: null,
        agentId: null,
      };
    }

    if (blockReason) {
      // Safety filter blocked the response BEFORE any text was produced.
      // Treat as permanent — retrying with the same prompt re-trips the
      // same filter.
      const msg = `gemini critic response blocked by safety filter: ${blockReason}`;
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: msg,
        status: "safety_blocked",
        retryCount: attemptIdx,
        errorCode: "safety_blocked",
      });
      return {
        kind: "permanent_failure",
        errorCode: "safety_blocked",
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: msg,
          retryable: false,
          code: "safety_blocked",
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
          message: `gemini critic returned invalid JSON: ${parseOutcome.message}`,
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
          message: `gemini critic JSON failed schema validation: ${e.message}`,
          retryable: false,
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    const durationMs = Date.now() - startMs;
    // Replace the critic's echoed validation block with the deterministic
    // packet evidence (same posture as the Cursor adapter).
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
      ...(typeof lastUsage?.promptTokenCount === "number"
        ? { tokensIn: lastUsage.promptTokenCount }
        : {}),
      ...(typeof lastUsage?.candidatesTokenCount === "number"
        ? { tokensOut: lastUsage.candidatesTokenCount }
        : {}),
      status: "complete",
      retryCount: attemptIdx,
    });

    return { kind: "success", result: enriched };
  }

  async doctor(critic: CriticConfig): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const apiKey = this.options.apiKey ?? process.env[GEMINI_API_KEY_ENV];
    checks.push({
      name: "gemini_api_key",
      passed: Boolean(apiKey),
      detail: apiKey ? `${GEMINI_API_KEY_ENV} present` : `${GEMINI_API_KEY_ENV} missing`,
      ...(apiKey
        ? {}
        : {
            remediation: `export ${GEMINI_API_KEY_ENV}=... or add it to the Doppler scope (sage/dev)`,
          }),
    });

    let sdkLoaded = false;
    try {
      // The dynamic import path catches both "package missing on disk" and
      // "package present but no exports we recognize" (older shape) cases.
      const mod = (await import("@google/genai")) as Record<string, unknown>;
      sdkLoaded = typeof mod["GoogleGenAI"] === "function";
    } catch {
      sdkLoaded = false;
    }
    checks.push({
      name: "gemini_sdk_loaded",
      passed: sdkLoaded,
      detail: sdkLoaded
        ? "@google/genai imported"
        : "@google/genai missing or shape unexpected",
      ...(sdkLoaded
        ? {}
        : { remediation: "make agent-review-deps && make agent-review-build" }),
    });

    if (!sdkLoaded || !apiKey) return checks;

    // Verify the configured model id resolves via models.list(). The Gemini
    // model-version churn (gemini-3-pro-preview → gemini-3.1-pro-preview →
    // gemini-3.1-pro GA) makes this check load-bearing — without it, a
    // first-run after a model rotation would fail at review time with a
    // less-actionable HTTP 404.
    try {
      const client = this.createClient(apiKey);
      const list = client.models.list;
      if (typeof list !== "function") {
        checks.push({
          name: "gemini_model_listing",
          passed: false,
          detail: "@google/genai models.list not exposed; cannot verify model id",
          remediation:
            "Run `make agent-review-spike-gemini` (source at tools/agent-review/src/spikes/gemini-models-list-2026-05.ts) and confirm the configured id is current.",
        });
        return checks;
      }
      const models = await list({});
      const ids: string[] = [];
      for await (const m of models as AsyncIterable<{ name?: string }>) {
        if (typeof m.name === "string") ids.push(m.name);
      }
      const matched = ids.some(
        (n) => n === critic.model.id || n.endsWith(`/${critic.model.id}`),
      );
      checks.push({
        name: "gemini_model_id",
        passed: matched,
        detail: matched
          ? `model ${critic.model.id} available`
          : `model ${critic.model.id} not in available list (${ids.slice(0, 8).join(", ")}${ids.length > 8 ? "..." : ""})`,
        ...(matched
          ? {}
          : { remediation: "update .agent-review/config.json critic.model.id (see tools/agent-review/evals/spike-gemini-models-2026-05.md or run `make agent-review-spike-gemini` to refresh)" }),
      });
    } catch (err) {
      checks.push({
        name: "gemini_model_id",
        passed: false,
        detail: `models.list() failed: ${(err as Error).message}`,
        remediation: `verify ${GEMINI_API_KEY_ENV} and network connectivity`,
      });
    }
    return checks;
  }
}
