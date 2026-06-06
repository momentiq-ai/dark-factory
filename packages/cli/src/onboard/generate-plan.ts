// packages/cli/src/onboard/generate-plan.ts
//
// Stage B entry point. Composes the prompt renderer, the LLM client, and
// the ScaffoldPlanSchema validator into one async function.
//
// Corrective-retry loop (#158): on Zod validation failure we don't re-ask
// blind. We replay the model's own malformed `tool_use` block as an
// `assistant` turn and reply with a `tool_result` user turn carrying the
// specific Zod issues. That gives the model *patch mode* (fix exactly the
// fields the validator flagged) instead of regen mode (rewrite the whole
// plan and risk re-breaking parts that were already valid). Empirically on
// sage-blueprint the first attempt returned `files` as a string + summary
// >800 chars; the second attempt (text-only feedback) converged on `files`
// as an array but dropped `rationale` on some items — convergence proves
// the model *can* correct, but one round of abstract text-only feedback
// wasn't enough. Multi-turn replay with the model's actual prior output
// pushes per-round effectiveness up; a small bounded loop (MAX_ATTEMPTS)
// then catches the residual cases without ballooning cost (each round is
// ~5 min wallclock on the full template).

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
  type LlmMessage,
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

// Total LLM calls (initial attempt + up to MAX_ATTEMPTS-1 corrective
// rounds). Each round on the sage-blueprint template costs ~5 min wallclock
// + ~960k input tokens, so this is the dominant cost knob. 3 attempts is
// the sweet spot empirically: attempt 1 makes the bulk of the plan;
// attempt 2 corrects most violations; attempt 3 catches the long tail
// without inflating cost in the happy path (which exits after attempt 1).
const MAX_ATTEMPTS = 3;

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
  // Anthropic's tool-use `input_schema` requires `type: "object"` at the top
  // level. zodToJsonSchema(s, NAME) emits `{$ref, definitions: {NAME: ...}}`
  // — no top-level type, so the API rejects it with `tools.0.custom.input_schema.type:
  // Field required`. Omit the name to get the schema inlined at top level.
  // Empirical verification (2026-06-06, #158): the derived schema already
  // mirrors the zod contract — `files: {type: array, items: {required:
  // [..., "rationale"]}}`, `summary: {maxLength: 800}`. Tool-call schemas
  // are advisory in the Anthropic API (not enforced at the boundary like
  // Vertex's strict mode), so a tight schema steers the model but doesn't
  // *guarantee* a valid response — hence the corrective-retry loop below.
  const inputSchema = zodToJsonSchema(ScaffoldPlanSchema) as object;
  const callLlm = opts.callLlm ?? ((i) => callScaffoldLlm(i));

  // exactOptionalPropertyTypes forbids assigning `undefined` to an optional
  // property; conditionally spread `apiKey` only when defined so the llm-client
  // falls through to its ANTHROPIC_API_KEY env-var lookup.
  const baseInputs: Omit<LlmInputs, "messages"> = {
    systemPrompt,
    toolName: TOOL_NAME,
    toolInputSchema: inputSchema,
    modelId: opts.modelId,
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  };

  // Conversational state grows across corrective rounds. Initial turn is the
  // rendered user message (analysis + template bodies + tailoring rules).
  const messages: LlmMessage[] = [{ role: "user", content: userMessage }];
  const attemptIssues: { path: (string | number)[]; message: string }[][] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await callLlm({ ...baseInputs, messages });
    const candidate = stampTemplateRef(result.planJson, template);
    const parsed = ScaffoldPlanSchema.safeParse(candidate);
    if (parsed.success) {
      // Byte-budget backstop (per B-D2). Per-array caps and per-field
      // maxLength catch most overflows; this is the final guardrail before
      // the writer.
      const serialized = JSON.stringify(parsed.data);
      if (serialized.length > SCAFFOLD_PLAN_BYTE_BUDGET) {
        throw new Error(
          `df onboard: ScaffoldPlan exceeds ${SCAFFOLD_PLAN_BYTE_BUDGET}-byte (64 KB) budget: ` +
            `produced ${serialized.length} bytes. Tighten per-file tailored_content or files[] count.`,
        );
      }
      return parsed.data;
    }

    attemptIssues.push(parsed.error.issues);

    if (attempt === MAX_ATTEMPTS) break;

    // Build the corrective turn pair: replay the assistant's actual tool_use
    // block (so the model sees its *own* prior output verbatim, not an
    // abstract description of it) + a tool_result user turn carrying the
    // specific Zod issues. The Anthropic API is stateless; we own both
    // sides of the conversation, so a synthesized `tool_use_id` is fine —
    // it just has to be consistent between the assistant `tool_use` and
    // the user `tool_result` in the same round.
    const synthesizedToolUseId = `toolu_retry_${attempt}`;
    messages.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: synthesizedToolUseId,
            name: TOOL_NAME,
            input: result.planJson,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: synthesizedToolUseId,
            is_error: true,
            content: formatCorrectiveFeedback(parsed.error.issues),
          },
        ],
      },
    );
  }

  // Exhausted retries — surface every round's issues so the operator (or a
  // critic) can see *what* the model kept getting wrong, not just that it
  // failed N times.
  const summary = attemptIssues
    .map((issues, i) => `attempt ${i + 1}: ${formatZodIssues(issues)}`)
    .join(" | ");
  throw new Error(
    `df onboard: scaffold plan validation failed after ${MAX_ATTEMPTS} attempts. ${summary}`,
  );
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

// Format the Zod issues for the corrective tool_result turn. The model sees
// its own prior output (via the assistant `tool_use` block we replay), so the
// feedback only needs to enumerate *what to fix*, not echo *what was wrong* —
// which the model can read off its own output. Keep it terse: each issue is
// path + message, and we anchor the instruction so the model patches in place
// instead of regenerating the whole plan from scratch.
function formatCorrectiveFeedback(
  issues: { path: (string | number)[]; message: string }[],
): string {
  const lines = issues.map(
    (i) => `- ${i.path.join(".") || "<root>"}: ${i.message}`,
  );
  return (
    "Your previous `emit_scaffold_plan` call failed schema validation. " +
    "Fix ONLY the issues below; keep every other field unchanged. " +
    "Emit a corrected `emit_scaffold_plan` tool call.\n\n" +
    "Issues:\n" +
    lines.join("\n")
  );
}
