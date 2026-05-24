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
