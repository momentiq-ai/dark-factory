// Cycle 322.7 — JSON Schema literal for the Codex outputSchema parameter.
//
// The Codex SDK's `Thread.run(input, { outputSchema })` parameter accepts a
// JSON Schema object; the SDK passes it through to the model so the response
// in `Turn.finalResponse` is schema-validated JSON natively. This file
// exports the canonical JSON Schema for the `CriticResult` payload that the
// adapter expects back from the critic.
//
// Source of truth: a Zod schema (`CriticResultZodSchema`) that mirrors the
// content-level fields of the existing `CriticResult` type defined in
// `schema.ts` (the manual TS interface + `parseCriticResult` validator).
// `zod-to-json-schema` with `target: "openAi"` converts the Zod schema to
// a JSON Schema that satisfies OpenAI's structured-output strict mode
// (every object has `additionalProperties: false`, every property is in
// `required`).
//
// Drift control (Cursor + Gemini critic feedback on cycle 322.7 Phase A):
//   - The Zod enum tuples below are derived DIRECTLY from the canonical
//     `as const` tuples exported by `../schema.ts` (`REVIEW_SEVERITIES`,
//     `CRITIC_STATUSES`, `REVIEW_VERDICTS`, `CONFIDENCES`). A stale
//     duplicate would silently produce a JSON Schema accepting values
//     the runtime `parseCriticResult` rejects; deriving from the
//     canonical tuples means a future schema.ts update propagates here
//     automatically.
//   - The Zod schema OBJECT shape (the fields and their types) still
//     duplicates a subset of `CriticResult` because `parseCriticResult`
//     is a manual validator (not Zod-derived). A future refactor that
//     ports `parseCriticResult` to a single Zod source would let this
//     file `.pick()` the model-owned fields directly; for now the
//     duplication is bounded to ~30 lines below.
//
// The narrower Zod schema in this file is INTENTIONALLY scoped to ONLY
// the fields the model owns — `criticId`, `reviewer.*`, `durationMs`,
// and `error` are stamped on post-response by the adapter
// (`mergeAdapterMetadata` + the success-path envelope), so they live
// outside this schema. The boundary between "model-supplied" and
// "adapter-stamped" is the architectural invariant this file encodes.
//
// If a future change to `CriticResult` adds a required content-level
// field, mirror it in the Zod schema below. The TS narrowing in
// `CriticResultModelEnvelope` documents which fields the model emits.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  CONFIDENCES,
  CRITIC_STATUSES,
  REVIEW_SEVERITIES,
  REVIEW_VERDICTS,
} from "@momentiq/dark-factory-schemas";

// Single source of truth for the enum tuples: derive Zod enums DIRECTLY
// from the canonical `as const` tuples exported by `../schema.ts`. This
// closes the drift gap that the Cursor + Gemini critics flagged on the
// first review of this file — a stale duplicate here would silently
// produce a JSON Schema that accepts values the runtime parser
// rejects (or vice versa).
//
// The Zod constructors accept a non-empty readonly tuple — coerce via
// the spread + non-empty cast so the canonical readonly arrays from
// `schema.ts` align with Zod's `z.enum<[T, ...T[]]>` signature.
const ReviewSeverityZ = z.enum(
  [...REVIEW_SEVERITIES] as unknown as readonly [string, ...string[]],
);
const CriticStatusZ = z.enum(
  [...CRITIC_STATUSES] as unknown as readonly [string, ...string[]],
);
const ReviewVerdictZ = z.enum(
  [...REVIEW_VERDICTS] as unknown as readonly [string, ...string[]],
);
const ConfidenceZ = z.enum(
  [...CONFIDENCES] as unknown as readonly [string, ...string[]],
);

// Non-empty-string constraints mirror parseFinding (schema.ts:894-901)
// and parseQualityGateResult (schema.ts:953-959). The runtime parser
// rejects empty values for these fields with SchemaError; the Zod
// schema mirrors that via `.min(1)` so the JSON Schema fed to Codex's
// outputSchema also rejects empty strings at the SDK layer. Without
// this the model would be told an empty string satisfies the schema,
// only to have the adapter reject the result downstream.
const ReviewFindingZ = z.object({
  severity: ReviewSeverityZ,
  category: z.string().min(1),
  file: z.string().optional(),
  line: z.number().int().optional(),
  symbol: z.string().optional(),
  evidence: z.string().min(1),
  impact: z.string().min(1),
  requiredFix: z.string().min(1),
  manifestoSection: z.string().optional(),
  // Cycle 318.2 Component 5 rubric fields — the critic can supply these
  // to attach evidence-pointers / commit-trailer justifications to a
  // finding so `enforceFindingRubric` honors the override.
  evidencePath: z.string().optional(),
  routeId: z.string().optional(),
  justification: z.string().optional(),
});

const QualityGateResultZ = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  durationMs: z.number().int(),
  logExcerpt: z.string(),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  routeId: z.string().optional(),
});

const CriticValidationViewZ = z.object({
  qualityGateResults: z.array(QualityGateResultZ),
  qualityGatesMissing: z.array(z.string()),
});

/**
 * Cycle 322.7 — Zod source-of-truth for the Codex `outputSchema`.
 *
 * Narrowed to the fields the MODEL is responsible for emitting. Fields
 * the adapter stamps post-response (`criticId`, `reviewer`, `durationMs`,
 * `error`) are NOT included — they belong on the adapter side via
 * `mergeAdapterMetadata` and the success-path envelope.
 *
 * `verdict` is REQUIRED here even though the downstream `CriticResult`
 * type treats it as optional. Rationale:
 *   - Under OpenAI structured-output strict mode (the `target: "openAi"`
 *     conversion), `target: "openAi"` lists every declared property in
 *     `required` regardless of `.optional()`; the "optional" semantic is
 *     instead encoded by widening the type to `["X", "null"]`. That
 *     means listing `verdict` as `.optional()` here would produce a
 *     schema where the model is allowed to emit `verdict: null` — which
 *     `parseCriticResult` (status==="complete" branch) rejects as a
 *     schema error.
 *   - The Codex adapter only invokes the SDK for live critic runs (not
 *     telemetry-only retries). On a successful completion the model
 *     ALWAYS owes us a verdict; emitting `null` is a model bug that
 *     should be caught at parse time, not silently accepted. Listing
 *     `verdict` as required (status="complete" path always emits one)
 *     pushes that validation up to the SDK layer.
 *   - On adapter-induced error paths (auth_failed, transport_error,
 *     etc.), the adapter goes through `buildErrorResult` which sets
 *     `status: "error"` and omits `verdict` — those never reach the
 *     model, so the schema requirement does not apply.
 *
 * Same reasoning for `findings`/`validation` being REQUIRED but allowed
 * to be empty arrays — those structural slots must be present so the
 * schema is consistent across statuses.
 */
export const CriticResultZodSchema = z.object({
  status: CriticStatusZ,
  verdict: ReviewVerdictZ,
  requiresHumanJudgment: z.boolean(),
  summary: z.string(),
  findings: z.array(ReviewFindingZ),
  validation: CriticValidationViewZ,
  confidence: ConfidenceZ,
});

export type CriticResultModelEnvelope = z.infer<typeof CriticResultZodSchema>;

/**
 * Cycle 322.7 — JSON Schema literal for the Codex SDK's `outputSchema`
 * parameter. Generated from `CriticResultZodSchema` at module-load time
 * using `zod-to-json-schema` with `target: "openAi"` (OpenAI strict-mode
 * compatible). Frozen-ish via `Object.freeze` is intentionally NOT used
 * here because the Codex SDK serializes the schema through the
 * subprocess boundary and TOML/JSON serialization doesn't preserve
 * frozen flags anyway.
 *
 * The shape is asserted in `tests/codex-adapter.test.ts` to catch
 * accidental Zod-source drift before merge.
 */
export const CRITIC_RESULT_JSON_SCHEMA = zodToJsonSchema(CriticResultZodSchema, {
  target: "openAi",
});
