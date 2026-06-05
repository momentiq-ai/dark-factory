// packages/cli/src/onboard/scaffold-schema.ts
//
// ScaffoldPlan — Stage B output envelope (cycle 15 Phase B).
//
// The LLM (Stage B) consumes a RepoAnalysis (Phase A) + a sage-blueprint
// template directory and emits a ScaffoldPlan: per-file action decisions
// (emit | merge | skip) with rationale and (for emit/merge) the tailored
// body content. Discriminated union on `action` makes the LLM tool-call
// shape unambiguous and Zod-rejects mixed states.
//
// Budget contract: serialized ScaffoldPlan ≤ 64 KB; per-file tailored_content
// ≤ 16 KB; files[] ≤ 100. Per-file cap + files cap together bound the LLM
// context AND the writer cost.

import { z } from "zod";
import { parseTemplateRef, TEMPLATE_REF_SHAPE_RE } from "./template-ref.js";

export const SCAFFOLD_PLAN_SCHEMA_VERSION = 1 as const;
export const SOURCE_ANALYSIS_SCHEMA_VERSION = 1 as const;
export const SCAFFOLD_PLAN_BYTE_BUDGET = 64_512;
export const FILE_PLAN_CONTENT_CAP = 16_384;
export const SCAFFOLD_PLAN_FILES_CAP = 100;
export const SCAFFOLD_PLAN_SUMMARY_CAP = 800;

const EmitPlan = z.object({
  path: z.string().min(1).max(512),
  action: z.literal("emit"),
  rationale: z.string().min(1).max(800),
  tailored_content: z.string().max(FILE_PLAN_CONTENT_CAP),
}).strict();

const MergePlan = z.object({
  path: z.string().min(1).max(512),
  action: z.literal("merge"),
  rationale: z.string().min(1).max(800),
  tailored_content: z.string().max(FILE_PLAN_CONTENT_CAP),
}).strict();

const SkipPlan = z.object({
  path: z.string().min(1).max(512),
  action: z.literal("skip"),
  rationale: z.string().min(1).max(800),
}).strict();

export const FilePlanSchema = z.discriminatedUnion("action", [
  EmitPlan,
  MergePlan,
  SkipPlan,
]);

export const ScaffoldPlanSchema = z.object({
  schemaVersion: z.literal(SCAFFOLD_PLAN_SCHEMA_VERSION),
  sourceAnalysisSchemaVersion: z.literal(SOURCE_ANALYSIS_SCHEMA_VERSION),
  templateRef: z
    .string()
    .regex(TEMPLATE_REF_SHAPE_RE, {
      message:
        "templateRef must match gh:<owner>/<repo>@<ref> or file:///<abs-path>@<ref>",
    })
    .refine(
      (s) => {
        try { parseTemplateRef(s); return true; } catch { return false; }
      },
      (s) => {
        try { parseTemplateRef(s); return { message: "(unreachable — refine should have passed)" }; }
        catch (e) { return { message: e instanceof Error ? e.message : String(e) }; }
      },
    ),
  generatedAtIso: z.string().datetime({ offset: false }),
  files: z.array(FilePlanSchema).max(SCAFFOLD_PLAN_FILES_CAP),
  summary: z.string().max(SCAFFOLD_PLAN_SUMMARY_CAP),
}).strict();

export type ScaffoldPlan = z.infer<typeof ScaffoldPlanSchema>;
export type FilePlan = z.infer<typeof FilePlanSchema>;
export type EmitFilePlan = z.infer<typeof EmitPlan>;
export type MergeFilePlan = z.infer<typeof MergePlan>;
export type SkipFilePlan = z.infer<typeof SkipPlan>;
