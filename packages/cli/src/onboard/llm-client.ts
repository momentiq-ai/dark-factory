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
//
// Why streaming (client.messages.stream) instead of client.messages.create:
// the inlined sage-blueprint template pushes Phase B's request to ~960k
// input tokens + 32k output, which routinely exceeds Anthropic's 10-minute
// hard guard on non-streaming requests ("Streaming is required for
// operations that may take longer than 10 minutes"). The SDK refused the
// request pre-flight before any retry logic could fire — see #147 for the
// full empirical trace. The stream() helper auto-assembles tool_use input
// from input_json_delta events into the final Message; finalMessage() then
// returns the same { content, usage, stop_reason, model } shape we already
// read from create(), so the rest of the call site is unchanged.

import Anthropic from "@anthropic-ai/sdk";

// Conversational-turn shape we accept from callers. Mirrors the Anthropic
// Messages API's `MessagesParam` (role + content), but typed locally so the
// LLM-client surface is not coupled to a specific SDK version. The content
// array carries the rich block types we need for tool-use replay:
// - `text`: ordinary user / assistant prose
// - `tool_use`: an assistant turn that calls a tool (we replay these when
//   feeding back a malformed-plan failure so the next assistant turn can
//   *correct* the prior tool call instead of starting over)
// - `tool_result`: the user-side reply to a `tool_use` block, carrying the
//   error feedback (`is_error: true`) so the model is told *which* fields
//   were wrong, against *its own* prior output — patch-mode, not blind retry.
export type LlmContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      is_error?: boolean;
      content: string | Array<{ type: "text"; text: string }>;
    };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | LlmContentBlock[];
}

export interface LlmInputs {
  systemPrompt: string;
  /** Conversational turn list. The first turn is conventionally the user
   *  prompt; for corrective retries, callers append an `assistant` turn that
   *  replays the prior malformed `tool_use` block + a `user` turn whose
   *  content is a `tool_result` carrying the error feedback. */
  messages: LlmMessage[];
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

export interface LlmStreamResult {
  id: string;
  model: string;
  content: Array<
    | { type: "tool_use"; name: string; input: unknown }
    | { type: "text"; text: string }
    | { type: string }
  >;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}

export interface LlmStreamHandle {
  finalMessage(): Promise<LlmStreamResult>;
}

export interface LlmClientLike {
  messages: {
    // Mirrors the SDK's client.messages.stream(...) — returns a helper
    // synchronously; finalMessage() resolves to the assembled Message after
    // all delta events have been consumed.
    stream(params: unknown): LlmStreamHandle;
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
    messages: inputs.messages,
  };

  let attempts = 0;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    try {
      // Both the stream() call and finalMessage() awaiting must live inside
      // the try block — with streaming, the SDK's API errors (401/429/5xx,
      // network failures) now surface as rejections on finalMessage() rather
      // than on the synchronous stream() call. The SDK's APIError subclasses
      // still carry .status, so isTransient() classification continues to
      // work; tests must mock by throwing from finalMessage() with .status
      // set to keep that contract verified.
      const stream = client.messages.stream(request);
      const r = await stream.finalMessage();
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
