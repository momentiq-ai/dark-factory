// packages/cli/src/onboard/generate-plan.ts
//
// Stage B entry point. Composes the prompt renderer, the LLM client, and
// the ScaffoldPlanSchema validator into one async function. One retry on
// validation failure (the model gets a chance to fix its own JSON when
// shown the Zod error); zero retries on transient LLM errors (the LLM
// client wrapper already handles those).

import { zodToJsonSchema } from "zod-to-json-schema";

import {
  ScaffoldPlanSchema,
  SCAFFOLD_PLAN_BYTE_BUDGET,
  type ScaffoldPlan,
} from "./scaffold-schema.js";
import { renderScaffoldPrompt } from "./prompts.js";
import {
  callScaffoldLlm,
  type LlmInputs,
  type LlmResult,
} from "./llm-client.js";
import type { RepoAnalysis } from "./schema.js";
import type { Template } from "./template-loader.js";

export interface GeneratePlanOptions {
  apiKey?: string;
  modelId: string;
  /** Resolved critic profile (B-D8). Flows into the scaffold prompt so the LLM
   *  emits a profile-correct `.agent-review/config.json`. The CLI resolves the
   *  profile (explicit `--profile` flag, else `autoProfile(analysis)`) before
   *  calling generatePlan. */
  profile: "local" | "cloud";
  // Test-injection hook. Default delegates to callScaffoldLlm.
  callLlm?: (inputs: LlmInputs) => Promise<LlmResult>;
}

export interface GeneratePlanResult extends Omit<ScaffoldPlan, never> {
  // ScaffoldPlan IS the contract; alias here for clarity at the call site.
}

const TOOL_NAME = "emit_scaffold_plan";

export async function generatePlan(
  analysis: RepoAnalysis,
  template: Template,
  opts: GeneratePlanOptions,
): Promise<ScaffoldPlan> {
  const { systemPrompt, userMessage } = await renderScaffoldPrompt(
    analysis,
    template.files,
    { profile: opts.profile },
  );
  const inputSchema = zodToJsonSchema(ScaffoldPlanSchema, "ScaffoldPlan") as object;
  const callLlm = opts.callLlm ?? ((i) => callScaffoldLlm(i));

  // exactOptionalPropertyTypes forbids assigning `undefined` to an optional
  // property; conditionally spread `apiKey` only when defined so the llm-client
  // falls through to its ANTHROPIC_API_KEY env-var lookup.
  const baseInputs: Omit<LlmInputs, "userMessage"> = {
    systemPrompt,
    toolName: TOOL_NAME,
    toolInputSchema: inputSchema,
    modelId: opts.modelId,
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  };

  // Attempt 1
  let result = await callLlm({ ...baseInputs, userMessage });
  let parsed = ScaffoldPlanSchema.safeParse(stampTemplateRef(result.planJson, template));
  if (!parsed.success) {
    // Capture the first-attempt issues BEFORE the retry overwrites `parsed`,
    // so the final error can cite both attempts (per W3 finding round-1).
    const firstAttemptIssues = parsed.error.issues;
    // Retry once with the validation error appended — the model often self-corrects.
    const retryMessage =
      `${userMessage}\n\n## Previous attempt rejected\n` +
      "Your last tool call did not validate. Issues:\n" +
      firstAttemptIssues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n") +
      "\n\nEmit `emit_scaffold_plan` again, fixing each issue above.";
    result = await callLlm({ ...baseInputs, userMessage: retryMessage });
    parsed = ScaffoldPlanSchema.safeParse(stampTemplateRef(result.planJson, template));
    if (!parsed.success) {
      throw new Error(
        `df onboard: scaffold plan validation failed after retry. ` +
          `First-attempt issues: ${formatZodIssues(firstAttemptIssues)}; ` +
          `second-attempt issues: ${formatZodIssues(parsed.error.issues)}`,
      );
    }
  }

  // Byte-budget backstop (per B-D2). Per-array caps and per-field maxLength
  // catch most overflows; this is the final guardrail before the writer.
  const serialized = JSON.stringify(parsed.data);
  if (serialized.length > SCAFFOLD_PLAN_BYTE_BUDGET) {
    throw new Error(
      `df onboard: ScaffoldPlan exceeds ${SCAFFOLD_PLAN_BYTE_BUDGET}-byte (64 KB) budget: ` +
        `produced ${serialized.length} bytes. Tighten per-file tailored_content or files[] count.`,
    );
  }
  return parsed.data;
}

// stampTemplateRef forces the plan's templateRef to be the loader's canonicalRef,
// not the LLM's value — the LLM could echo a stale or fabricated ref, and the
// plan's provenance must be ground-truth.
function stampTemplateRef(planJson: unknown, template: Template): unknown {
  if (planJson && typeof planJson === "object" && !Array.isArray(planJson)) {
    return { ...(planJson as Record<string, unknown>), templateRef: template.canonicalRef };
  }
  return planJson;
}

function formatZodIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}
