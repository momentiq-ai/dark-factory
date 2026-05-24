import { Agent, type LocalAgentOptions } from "@cursor/sdk";

import { compileCriticPrompt } from "../prompt.js";
import {
  parseCriticResult,
  type CriticConfig,
  type CriticResult,
  type CriticStatusMessage,
  type DoctorCheck,
  type ReviewPacket,
} from "@momentiq/dark-factory-schemas";

import type { CriticAdapter, CriticReviewOptions } from "./critic.js";
import {
  buildErrorResult,
  mergeAdapterMetadata,
  normalizeCriticEcho,
  parseAssistantJson,
  shouldEnableCursorSandbox,
  writeRedactedDiagnostic,
} from "./_shared.js";

// Re-export for backwards compatibility — `normalizeCriticEcho` originally
// lived here. Existing imports from `cursor-sdk.js` (e.g. cursor-adapter
// tests) continue to work after the move to `_shared.ts` (issue #1484).
export { normalizeCriticEcho } from "./_shared.js";

export const CURSOR_SDK_ADAPTER_ID = "cursor-sdk";
export const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";

// Cycle 322.1 — bounded retry policy for the Cursor SDK adapter.
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
// Exported for tests + (future) adapter siblings (322.2 Gemini, 322.3
// Grok) that will mirror this shape from a single source of truth.
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
 * Extracted as a free function so:
 *  - 322.2 Gemini and 322.3 Grok adapters inherit the retry pattern
 *    without copy-paste drift.
 *  - The loop is unit-testable with scripted outcomes + a mock
 *    `sleep` (see `tests/cursor-retry-loop.test.ts`) — no SDK mock
 *    required.
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

export class CursorSdkAdapter implements CriticAdapter {
  readonly id = CURSOR_SDK_ADAPTER_ID;
  // Cycle 322.2 Component 3 — declared so the CLI's
  // `maybeReexecUnderDoppler` can walk required critics' adapters and
  // re-exec under `doppler run` when a required critic key is missing.
  readonly requiredEnvVars: readonly string[] = [CURSOR_API_KEY_ENV];

  constructor(private readonly options: { apiKey?: string } = {}) {}

  async review(
    packet: ReviewPacket,
    critic: CriticConfig,
    options: CriticReviewOptions,
  ): Promise<CriticResult> {
    // Cycle 322.1 — bounded retry across the Cursor SDK's transient
    // failure surface. Total budget = sum(RETRY_BACKOFF_MS) = 20s
    // across 2 retries (3 attempts). Per-attempt telemetry is emitted
    // inside `attemptReview` so the loop itself stays pure.
    return runRetryLoop({
      attempt: (idx) => this.attemptReview(packet, critic, options, idx),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      buildExhausted: ({ last, totalAttempts, aborted }) => {
        // `totalAttempts` is the post-increment attempt index when the
        // loop ended naturally (= RETRY_BACKOFF_MS.length + 1 = 3 on
        // full exhaustion). On abort it's the index reached before
        // the abort. Either way the highest *retry index* used is
        // `totalAttempts - 1` (clamped to ≥ 0).
        const retriesUsed = Math.max(0, totalAttempts - 1);
        const summary = aborted
          ? last
            ? `cursor SDK run aborted after ${retriesUsed} retries: ${last.message}`
            : "cursor SDK run aborted before any attempt completed"
          : last
            ? `cursor SDK run failed after ${retriesUsed} retries: ${last.message}`
            : // Shouldn't happen — loop exhaustion without a failure
              // means attempt() returned non-retryable for all attempts,
              // which would have returned early. Defensive fallback.
              "cursor SDK run failed with no captured failure metadata";
        return buildErrorResult({
          critic,
          message: summary,
          retryable: true,
          ...(last?.errorCode != null ? { code: last.errorCode } : {}),
          retryCount: retriesUsed,
          ...(last?.agentId !== null && last?.agentId !== undefined ? { agentId: last.agentId } : {}),
          ...(last?.runId !== null && last?.runId !== undefined ? { runId: last.runId } : {}),
        });
      },
    });
  }

  // Cycle 322.1 — one attempt. Pure-ish: emits its own telemetry
  // event for terminal outcomes (success, permanent_failure,
  // retryable_failure), returns a tagged AttemptOutcome the outer
  // loop dispatches on. The `attemptIdx` is woven into telemetry
  // (`retryCount`) and into the success result (`retryCount` on
  // `critic_run_finished`).
  private async attemptReview(
    packet: ReviewPacket,
    critic: CriticConfig,
    options: CriticReviewOptions,
    attemptIdx: number,
  ): Promise<AttemptOutcome> {
    const apiKey = this.options.apiKey ?? process.env["CURSOR_API_KEY"];
    if (!apiKey) {
      // Missing key is a permanent failure regardless of attempt — no
      // retry can fix a missing secret. Skip the retry policy and
      // return immediately with a permanent envelope.
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: null,
        result: buildErrorResult({
          critic,
          message: "CURSOR_API_KEY is not set; cannot run Cursor critic",
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
    // Emit `critic_run_started` only on the first attempt; retries
    // are NOT independent reviews, they're continuations of the
    // single review the runner kicked off, so double-counting starts
    // would mis-attribute attempt counts in `agent-review-stats`.
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

    let agent: unknown;
    let agentId: string | undefined;
    let runId: string | undefined;
    let assistantText = "";
    // Capture SDKStatusMessage events as they stream; the last one
    // before terminal status carries the SDK's own diagnostic when an
    // upstream incident is in progress.
    let lastStatusMessage: CriticStatusMessage | null = null;

    try {
      const localOptions = buildLocalOptions(packet.repoRoot);
      agent = await Agent.create({
        apiKey,
        model: buildModelSelection(critic),
        local: localOptions,
      });
      agentId = (agent as { id?: string }).id;
    } catch (err) {
      const e = err as Error;
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        durationMs: Date.now() - startMs,
        error: e.message,
        status: "startup_failure",
        retryCount: attemptIdx,
      });
      // Adapter init failure has no runId, so `shouldRetryRunFailure`
      // would deny retry. Treat as retryable_failure here (the
      // network blip case is genuine) — the outer loop respects
      // attempt count and stops naturally; without a runId there's
      // no upstream state to be ambiguous about.
      return {
        kind: "retryable_failure",
        errorCode: null,
        statusMessage: null,
        message: `cursor SDK startup failed: ${e.message}`,
        runId: null,
        agentId: agentId ?? null,
      };
    }

    let runStatus: string | undefined;
    let terminalResult: unknown = null;

    try {
      const sendable = agent as { send: (text: string) => Promise<unknown> };
      const run = (await sendable.send(prompt.text)) as {
        id?: string;
        stream(): AsyncIterable<unknown>;
        wait(): Promise<unknown>;
      };
      runId = run.id;
      for await (const event of run.stream()) {
        if (options.signal?.aborted) break;
        const ids = extractIds(event);
        if (!agentId && ids.agentId) agentId = ids.agentId;
        if (!runId && ids.runId) runId = ids.runId;
        const text = extractAssistantText(event);
        if (text) assistantText += text;
        // Cycle 322.1 — capture status-message stream events. Each
        // overwrites the previous so we end with the LAST status the
        // SDK emitted, which is the most relevant signal for the
        // terminal outcome.
        const status = extractStatusMessage(event);
        if (status) lastStatusMessage = status;
      }
      terminalResult = await run.wait();
      runStatus = (terminalResult as { status?: string }).status;
      const statusError = checkRunFinished(runStatus);
      if (statusError) throw new Error(statusError);
    } catch (err) {
      const e = err as Error;
      const errorCode = extractRunErrorCode(terminalResult);
      // Apply the retry policy — does this failure pattern allow
      // another attempt? If not, return a permanent envelope; the
      // outer loop will surface this immediately without sleeping.
      const retryAllowed = shouldRetryRunFailure({
        result: terminalResult,
        errorCode,
        runId: runId ?? null,
      });
      options.emit?.({
        ts: new Date().toISOString(),
        event: "critic_run_error",
        commit: packet.commit.sha,
        criticId: critic.id,
        adapter: this.id,
        model: critic.model.id,
        ...(agentId !== undefined ? { agentId } : {}),
        ...(runId !== undefined ? { runId } : {}),
        durationMs: Date.now() - startMs,
        error: e.message,
        status: "run_failure",
        retryCount: attemptIdx,
        ...(errorCode !== null ? { errorCode } : {}),
        ...(lastStatusMessage !== null ? { statusMessage: lastStatusMessage } : {}),
      });
      await disposeAgent(agent);
      if (!retryAllowed) {
        return {
          kind: "permanent_failure",
          errorCode,
          statusMessage: lastStatusMessage,
          result: buildErrorResult({
            critic,
            message: `cursor SDK run failed (permanent): ${e.message}`,
            retryable: false,
            ...(agentId !== undefined ? { agentId } : {}),
            ...(runId !== undefined ? { runId } : {}),
            ...(errorCode !== null ? { code: errorCode } : {}),
            retryCount: attemptIdx,
          }),
        };
      }
      return {
        kind: "retryable_failure",
        errorCode,
        statusMessage: lastStatusMessage,
        message: `cursor SDK run failed: ${e.message}`,
        runId: runId ?? null,
        agentId: agentId ?? null,
      };
    }

    await disposeAgent(agent);

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
        ...(agentId !== undefined ? { agentId } : {}),
        ...(runId !== undefined ? { runId } : {}),
        durationMs: Date.now() - startMs,
        error: `invalid critic JSON: ${parseOutcome.message}`,
        status: "invalid_json",
        retryCount: attemptIdx,
      });
      // JSON parse failure is a permanent failure for this attempt —
      // the SDK succeeded but the model returned malformed output.
      // Retrying typically produces the same malformed output (the
      // model isn't aware of its own parse failure), and a retry
      // budget burnt on bad JSON is budget not available for a real
      // transient upstream incident.
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: lastStatusMessage,
        result: buildErrorResult({
          critic,
          message: `cursor critic returned invalid JSON: ${parseOutcome.message}`,
          retryable: false,
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          ...(agentId !== undefined ? { agentId } : {}),
          ...(runId !== undefined ? { runId } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    let result: CriticResult;
    try {
      const baseRaw = parseOutcome.value;
      const normalized = normalizeCriticEcho(baseRaw);
      const runtimeModel = extractRuntimeModel(agent);
      const enriched = mergeAdapterMetadata(normalized, {
        critic,
        ...(runtimeModel !== undefined ? { runtimeModel } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(runId !== undefined ? { runId } : {}),
      });
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
        ...(agentId !== undefined ? { agentId } : {}),
        ...(runId !== undefined ? { runId } : {}),
        durationMs: Date.now() - startMs,
        error: `schema validation failed: ${e.message}`,
        status: "schema_violation",
        retryCount: attemptIdx,
      });
      return {
        kind: "permanent_failure",
        errorCode: null,
        statusMessage: lastStatusMessage,
        result: buildErrorResult({
          critic,
          message: `cursor critic JSON failed schema validation: ${e.message}`,
          retryable: false,
          ...(diagPath !== undefined ? { rawSamplePath: diagPath } : {}),
          ...(agentId !== undefined ? { agentId } : {}),
          ...(runId !== undefined ? { runId } : {}),
          retryCount: attemptIdx,
        }),
      };
    }

    const durationMs = Date.now() - startMs;
    // Replace the critic's echoed validation block with the truth: the
    // deterministic evidence the packet carried. The critic's echo is
    // accepted leniently above for legacy/varying responses but the
    // authoritative copy comes from us.
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
      ...(agentId !== undefined ? { agentId } : {}),
      ...(runId !== undefined ? { runId } : {}),
      durationMs,
      ...(enriched.verdict !== undefined ? { verdict: enriched.verdict } : {}),
      findingCount: enriched.findings.length,
      blockerCount,
      highCount,
      status: runStatus ?? "complete",
      retryCount: attemptIdx,
    });

    return { kind: "success", result: enriched };
  }

  async doctor(critic: CriticConfig): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const apiKey = this.options.apiKey ?? process.env["CURSOR_API_KEY"];
    checks.push({
      name: "cursor_api_key",
      passed: Boolean(apiKey),
      detail: apiKey ? "CURSOR_API_KEY present" : "CURSOR_API_KEY missing",
      ...(apiKey ? {} : { remediation: "export CURSOR_API_KEY=..." }),
    });

    let cursorModule: Record<string, unknown> = {};
    try {
      cursorModule = (await import("@cursor/sdk")) as Record<string, unknown>;
    } catch (err) {
      checks.push({
        name: "cursor_sdk_loaded",
        passed: false,
        detail: `failed to import @cursor/sdk: ${(err as Error).message}`,
        remediation: "make agent-review-deps && make agent-review-build",
      });
      return checks;
    }
    checks.push({
      name: "cursor_sdk_loaded",
      passed: true,
      detail: "@cursor/sdk imported",
    });

    const cursor = cursorModule["Cursor"] as
      | { models?: { list?: () => Promise<Array<{ id?: string }>> } }
      | undefined;
    const list = cursor?.models?.list;
    if (typeof list !== "function") {
      checks.push({
        name: "cursor_model_listing",
        passed: false,
        detail: "Cursor.models.list is not exposed by this SDK version; cannot verify model id",
        remediation:
          "Run the Cursor SDK spike (make agent-review-spike) and update the doctor check to match the SDK shape.",
      });
      return checks;
    }
    if (!apiKey) return checks;
    try {
      const models = await list();
      const ids = models.map((m) => m.id ?? "");
      const matched = ids.includes(critic.model.id);
      checks.push({
        name: "cursor_model_id",
        passed: matched,
        detail: matched
          ? `model ${critic.model.id} available`
          : `model ${critic.model.id} not in available list (${ids.slice(0, 8).join(", ")}${ids.length > 8 ? "..." : ""})`,
        ...(matched ? {} : { remediation: "update .agent-review/config.json critic.model.id" }),
      });
    } catch (err) {
      checks.push({
        name: "cursor_model_id",
        passed: false,
        detail: `Cursor.models.list() failed: ${(err as Error).message}`,
        remediation: "verify CURSOR_API_KEY and network connectivity",
      });
    }
    return checks;
  }
}

function buildLocalOptions(cwd: string): LocalAgentOptions {
  // Empty settingSources isolates the critic from project/user/team Cursor settings
  // so reviews are reproducible across workstations.
  // sandboxOptions.enabled is the SDK's defense-in-depth toggle — the critic
  // must never write files locally even if a malicious diff convinces the
  // model to try. On CI runners (#1577) the SDK's sandbox primitive is
  // unavailable; `shouldEnableCursorSandbox` (in `_shared.ts`) detects that
  // environment via `CI` / `GITHUB_ACTIONS` env vars and disables the toggle
  // so the SDK doesn't fail the run with "sandboxing not supported".
  return {
    cwd,
    settingSources: [],
    sandboxOptions: { enabled: shouldEnableCursorSandbox() },
  };
}

// Pass model id AND configured params to the Cursor SDK. Without this, the
// SDK falls back to the model's default variant (e.g., gpt-5.5 default is
// reasoning=medium even when config asks for extra-high), and the critic runs
// at a weaker tier than configured. The reviewer-metadata echo would still
// claim the configured params, so the artifact would silently lie.
//
// SDK shape (`ModelParameterValue`) requires `value: string`; our schema allows
// `string | number | boolean` so we coerce here. Booleans serialize to
// "true"/"false" matching Cursor's model-list values.
export function buildModelSelection(critic: CriticConfig): { id: string; params?: Array<{ id: string; value: string }> } {
  const sel: { id: string; params?: Array<{ id: string; value: string }> } = { id: critic.model.id };
  if (critic.model.params && critic.model.params.length > 0) {
    sel.params = critic.model.params.map((p) => ({ id: p.id, value: String(p.value) }));
  }
  return sel;
}

// Extract only ASSISTANT message text from the stream. The SDK also emits
// `thinking`, `status`, `tool_call`, `task`, etc.; capturing those pollutes the
// output and breaks JSON parsing. Empirical SDK shapes are pinned in
// fixtures/spike-2026-05-03.json.
function extractAssistantText(event: unknown): string {
  if (typeof event !== "object" || event === null) return "";
  const e = event as Record<string, unknown>;
  if (e["type"] !== "assistant") return "";
  const message = e["message"];
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const block = c as Record<string, unknown>;
      if (block["type"] !== "text") return "";
      const t = block["text"];
      return typeof t === "string" ? t : "";
    })
    .join("");
}

function extractIds(event: unknown): { agentId?: string; runId?: string } {
  if (typeof event !== "object" || event === null) return {};
  const e = event as Record<string, unknown>;
  const out: { agentId?: string; runId?: string } = {};
  const aid = e["agent_id"] ?? e["agentId"];
  if (typeof aid === "string") out.agentId = aid;
  const rid = e["run_id"] ?? e["runId"];
  if (typeof rid === "string") out.runId = rid;
  return out;
}

// Returns null when the run terminated normally, an error string otherwise.
// Healthy terminal status is `"finished"` per spike fixture and SDK type
// definition (`"running" | "finished" | "error"`). Anything else means the
// SDK run did not complete — partial assistantText could still happen to
// parse as valid JSON and be treated as APPROVED, so the adapter must fail
// closed before parsing. Extracted for direct unit-testing.
export function checkRunFinished(runStatus: string | undefined): string | null {
  if (runStatus === "finished") return null;
  return `cursor SDK run terminated with status=${runStatus ?? "unknown"} (expected "finished")`;
}

// Read the SDK's resolved model selection off the agent. The SDK type
// definition (`SDKAgent.model: ModelSelection | undefined`) says this is
// "updated after each successful send({ model })", which means it reflects
// what the SDK actually accepted — not what we tried to send. Returns
// undefined when the SDK shape doesn't expose it (defensive fallback).
export function extractRuntimeModel(
  agent: unknown,
): { id: string; params?: Array<{ id: string; value: string }> } | undefined {
  if (!agent || typeof agent !== "object") return undefined;
  const model = (agent as { model?: unknown }).model;
  if (!model || typeof model !== "object") return undefined;
  const id = (model as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  const paramsRaw = (model as { params?: unknown }).params;
  if (!Array.isArray(paramsRaw)) return { id };
  const params: Array<{ id: string; value: string }> = [];
  for (const p of paramsRaw) {
    if (!p || typeof p !== "object") continue;
    const pid = (p as { id?: unknown }).id;
    const pval = (p as { value?: unknown }).value;
    if (typeof pid !== "string" || typeof pval !== "string") continue;
    params.push({ id: pid, value: pval });
  }
  return params.length > 0 ? { id, params } : { id };
}

async function disposeAgent(agent: unknown): Promise<void> {
  if (!agent || typeof agent !== "object") return;
  const dispose = (agent as { [Symbol.asyncDispose]?: () => Promise<void> })[
    Symbol.asyncDispose
  ];
  if (typeof dispose === "function") {
    try {
      await dispose.call(agent);
    } catch {
      // best-effort
    }
    return;
  }
  const close = (agent as { close?: () => Promise<void> }).close;
  if (typeof close === "function") {
    try {
      await close.call(agent);
    } catch {
      // best-effort
    }
  }
}

// Cycle 322.1 — pure-function helpers for the retry loop. Extracted
// so the policy is testable without an SDK mock and so future
// adapters (322.2 Gemini, 322.3 Grok) can mirror the shape from a
// single source of truth instead of copy-pasting the patterns.

/**
 * Pull structured status fields from an SDKStatusMessage stream event.
 *
 * The Cursor SDK streams `SDKStatusMessage` events before the terminal
 * RunResult; when an upstream incident is in progress these carry the
 * SDK's own human-readable explanation (e.g.,
 * `{ status: "error", message: "Upstream model gpt-5.5 returned
 * capacity_exceeded after retry policy exhausted" }`). The runtime
 * shape is intentionally not pinned to a TypeScript type from the SDK
 * because the SDK may evolve the field names; this extractor probes
 * the documented Cursor surface AND falls back to a top-level
 * `{ status, message }` shape so a slightly older or newer SDK still
 * surfaces the signal.
 *
 * Returns `null` when the event is not a status message or lacks the
 * structured payload (the common case — most stream events are
 * `assistant` / `thinking` / `tool_call`).
 */
export function extractStatusMessage(event: unknown): CriticStatusMessage | null {
  if (typeof event !== "object" || event === null) return null;
  const e = event as Record<string, unknown>;
  // Cursor SDK shape (per spike fixture): assistant/thinking events use
  // `type: "assistant"` etc.; status messages use either `type: "status"`
  // or an explicit `kind: "status_message"`. Both surfaces are observed
  // in the wild — accept either as long as the structured payload is
  // present.
  const isStatusEvent =
    e["type"] === "status" ||
    e["type"] === "status_message" ||
    e["kind"] === "status_message" ||
    e["kind"] === "status";
  if (!isStatusEvent) return null;
  // Sometimes the payload is at the top level; sometimes it is nested
  // under `data` or `message`. Probe in order; first hit wins.
  const candidates: unknown[] = [
    e,
    e["data"],
    e["message"],
    e["payload"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const c = candidate as Record<string, unknown>;
    const status = c["status"];
    const message = c["message"];
    if (typeof status === "string" && status.length > 0 && typeof message === "string" && message.length > 0) {
      return { status, message };
    }
  }
  return null;
}

/**
 * Probe a terminal RunResult for the SDK's structured error code.
 *
 * The Cursor SDK has used at least four field names for this code
 * across versions: `errorCode` (current), `error_code`, `code`, and
 * `error.code` (nested under an `error` object). Probe in that order
 * — first non-empty string wins. Returns `null` when none are
 * present, which means the SDK did not surface a structured code at
 * all (treat as "transient unless proven otherwise" so retry policy
 * applies).
 */
export function extractRunErrorCode(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  // Top-level surfaces, in priority order. `errorCode` is the
  // documented current name; the others are legacy / underscored /
  // nested.
  const direct = [r["errorCode"], r["error_code"], r["code"]];
  for (const v of direct) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  // Nested under `error: { code }`.
  const errorObj = r["error"];
  if (typeof errorObj === "object" && errorObj !== null) {
    const nested = (errorObj as Record<string, unknown>)["code"];
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return null;
}

/**
 * Policy gate: decide whether a terminal Cursor SDK failure is
 * retryable.
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
