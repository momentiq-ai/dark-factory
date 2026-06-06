// packages/cli/src/onboard/llm-client.ts
//
// Anthropic Messages-API wrapper with tool-use structured output.
//
// Why a wrapper instead of calling the SDK directly: the call shape is
// shared by generatePlan() (Phase B) AND a future Phase B.1 prompt-test
// harness, and the retry classification (transient vs permanent) is
// security-critical (a 401 must never silently retry). Centralizing the
// shape here means a new caller can't accidentally drift from the policy.
//
// Tool-use binding: declare a single tool `emit_scaffold_plan` whose
// `input_schema` is the JSON-Schema rendering of ScaffoldPlanSchema; set
// tool_choice to force the model into a tool call; read the tool-use
// block's `input` as the candidate JSON. The SDK validates the JSON
// shape at the API boundary; downstream Zod validation re-checks the
// semantics (discriminated-union, byte budgets).

import Anthropic from "@anthropic-ai/sdk";

export interface LlmInputs {
  systemPrompt: string;
  userMessage: string;
  toolName: string;
  toolInputSchema: object;
  apiKey?: string;
  modelId: string;
  maxTokens?: number;
}

export interface LlmResult {
  planJson: unknown;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
}

export interface LlmClientLike {
  messages: {
    create(params: unknown): Promise<{
      id: string;
      model: string;
      content: Array<
        | { type: "tool_use"; name: string; input: unknown }
        | { type: "text"; text: string }
        | { type: string }
      >;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    }>;
  };
}

export type LlmClientFactory = (apiKey: string) => LlmClientLike;

const DEFAULT_FACTORY: LlmClientFactory = (apiKey) =>
  new Anthropic({ apiKey }) as unknown as LlmClientLike;

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as Error & { status?: number }).status;
  if (typeof status === "number") return TRANSIENT_STATUSES.has(status);
  const code = (err as Error & { code?: string }).code;
  if (typeof code === "string" && /ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/.test(code)) {
    return true;
  }
  return false;
}

export interface CallOptions {
  createClient?: LlmClientFactory;
}

export async function callScaffoldLlm(
  inputs: LlmInputs,
  opts: CallOptions = {},
): Promise<LlmResult> {
  const apiKey = inputs.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey || !apiKey.trim()) {
    throw new Error(
      "df onboard: ANTHROPIC_API_KEY is required for Phase B's scaffold-generation LLM call. " +
        "Set the env var (or pass --api-key) and re-run.",
    );
  }
  const factory = opts.createClient ?? DEFAULT_FACTORY;
  const client = factory(apiKey);

  const request = {
    model: inputs.modelId,
    // 8192 was the original default; sage-blueprint at 701 template files
    // produced a ScaffoldPlan that truncated mid-tool-use (stop_reason:
    // max_tokens), so the `files` array was incomplete and Zod validation
    // failed on `files: Required`. Sonnet 4.6 supports up to 64k output
    // tokens; 32k is the sweet spot for one full ScaffoldPlan with headroom
    // without paying for capacity we never use.
    max_tokens: inputs.maxTokens ?? 32768,
    system: inputs.systemPrompt,
    tools: [
      {
        name: inputs.toolName,
        description:
          "Emit the tailored ScaffoldPlan JSON. The input schema is enforced strictly; " +
            "fields not in the schema are rejected.",
        input_schema: inputs.toolInputSchema,
      },
    ],
    tool_choice: { type: "tool", name: inputs.toolName } as const,
    messages: [{ role: "user" as const, content: inputs.userMessage }],
  };

  let attempts = 0;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    try {
      const r = await client.messages.create(request);
      // Opt-in diagnostic — stop_reason + token counts + content shape are the
      // discriminating signals when downstream Zod validation fails on the
      // returned plan (truncation vs. malformed output vs. wrong block type).
      // Gated behind DF_ONBOARD_DEBUG so the benign-info line does not pollute
      // stderr in normal use (per #57's severity-routing convention — benign
      // info on stderr lights up GKE/Cloud Logging as severity:ERROR).
      if (process.env["DF_ONBOARD_DEBUG"]) {
        console.error(
          `[llm-diag] attempt=${attempts} stop_reason=${r.stop_reason} ` +
            `input_tokens=${r.usage.input_tokens} output_tokens=${r.usage.output_tokens} ` +
            `content_types=${JSON.stringify(r.content.map((b) => (b as { type: string }).type))}`,
        );
      }
      const toolBlock = r.content.find(
        (b): b is { type: "tool_use"; name: string; input: unknown } =>
          (b as { type: string }).type === "tool_use" &&
          (b as { name?: string }).name === inputs.toolName,
      );
      if (!toolBlock) {
        throw new Error(
          `df onboard: no tool_use block found in LLM response (got stop_reason=${r.stop_reason}). ` +
            "The model did not honor tool_choice; check the prompt and model selection.",
        );
      }
      return {
        planJson: toolBlock.input,
        modelId: r.model,
        inputTokens: r.usage.input_tokens,
        outputTokens: r.usage.output_tokens,
        attempts,
      };
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isTransient(err)) continue;
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
