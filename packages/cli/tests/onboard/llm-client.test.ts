import { describe, it, expect } from "vitest";
import { callScaffoldLlm, type LlmClientFactory, type LlmInputs } from "../../src/onboard/llm-client.js";

// All fakes mock at the SDK boundary — `messages.stream(req)` returns a
// helper whose `finalMessage()` resolves (success) or rejects (error). The
// SDK auto-assembles tool_use input from input_json_delta events so the
// `content` array we return from `finalMessage()` is the FINAL shape (input
// is a fully-assembled object, not partial JSON fragments). See #147 for the
// streaming switch — the non-streaming `messages.create()` was blocked
// pre-flight by Anthropic's 10-minute non-streaming guard on the ~960k-token
// sage-blueprint Phase B request.
function fakeFactory(stub: {
  beforeReturn?: (call: number) => void;
  responses: Array<
    | { type: "tool"; payload: unknown; inputTokens?: number; outputTokens?: number }
    | { type: "throw"; status?: number; message: string }
  >;
}): LlmClientFactory {
  let call = 0;
  return () => ({
    messages: {
      stream() {
        const idx = call++;
        stub.beforeReturn?.(call);
        const r = stub.responses[idx];
        return {
          async finalMessage() {
            if (!r) throw new Error(`fake factory exhausted at call ${call}`);
            if (r.type === "throw") {
              // Real SDK APIError subclasses carry .status; isTransient() reads it.
              const err: Error & { status?: number } = new Error(r.message);
              if (r.status !== undefined) err.status = r.status;
              throw err;
            }
            return {
              id: "msg_test",
              model: "claude-3-7-sonnet-latest",
              content: [{ type: "tool_use", name: "emit_scaffold_plan", input: r.payload }],
              usage: { input_tokens: r.inputTokens ?? 100, output_tokens: r.outputTokens ?? 50 },
              stop_reason: "tool_use",
            };
          },
        };
      },
    },
  });
}

const INPUTS: LlmInputs = {
  systemPrompt: "you are an onboarding assistant",
  userMessage: "analyze + tailor",
  toolName: "emit_scaffold_plan",
  toolInputSchema: { type: "object", properties: { schemaVersion: { type: "number" } } } as never,
  apiKey: "sk-ant-test",
  modelId: "claude-3-7-sonnet-latest",
};

describe("callScaffoldLlm", () => {
  it("returns the tool-use input on first success", async () => {
    const factory = fakeFactory({
      responses: [{ type: "tool", payload: { schemaVersion: 1 }, inputTokens: 200, outputTokens: 80 }],
    });
    const r = await callScaffoldLlm(INPUTS, { createClient: factory });
    expect(r.planJson).toEqual({ schemaVersion: 1 });
    expect(r.attempts).toBe(1);
    expect(r.inputTokens).toBe(200);
    expect(r.outputTokens).toBe(80);
    expect(r.modelId).toBe("claude-3-7-sonnet-latest");
  });

  it("retries once on a 503 then succeeds (via finalMessage rejection)", async () => {
    const factory = fakeFactory({
      responses: [
        { type: "throw", status: 503, message: "upstream busy" },
        { type: "tool", payload: { schemaVersion: 1 } },
      ],
    });
    const r = await callScaffoldLlm(INPUTS, { createClient: factory });
    expect(r.attempts).toBe(2);
  });

  it("does NOT retry on a 401", async () => {
    const factory = fakeFactory({
      responses: [{ type: "throw", status: 401, message: "unauthorized" }],
    });
    await expect(callScaffoldLlm(INPUTS, { createClient: factory })).rejects.toThrow(
      /401|unauthorized/,
    );
  });

  it("does NOT retry on a 400", async () => {
    const factory = fakeFactory({
      responses: [{ type: "throw", status: 400, message: "bad request" }],
    });
    await expect(callScaffoldLlm(INPUTS, { createClient: factory })).rejects.toThrow(
      /400|bad request/,
    );
  });

  it("does NOT retry twice on persistent 503", async () => {
    const factory = fakeFactory({
      responses: [
        { type: "throw", status: 503, message: "upstream busy" },
        { type: "throw", status: 503, message: "upstream busy 2" },
      ],
    });
    await expect(callScaffoldLlm(INPUTS, { createClient: factory })).rejects.toThrow();
  });

  it("throws if the response has no tool_use block", async () => {
    const factory = (() => ({
      messages: {
        stream() {
          return {
            async finalMessage() {
              return {
                id: "msg_x",
                model: "m",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "no tool call here" }],
                usage: { input_tokens: 1, output_tokens: 1 },
              };
            },
          };
        },
      },
    })) as LlmClientFactory;
    await expect(callScaffoldLlm(INPUTS, { createClient: factory })).rejects.toThrow(
      /no tool_use|tool_use block missing/i,
    );
  });

  it("rejects when no API key is available (neither apiKey nor ANTHROPIC_API_KEY)", async () => {
    const originalEnv = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const i = { ...INPUTS, apiKey: undefined };
      await expect(callScaffoldLlm(i, { createClient: fakeFactory({ responses: [] }) })).rejects.toThrow(
        /ANTHROPIC_API_KEY/,
      );
    } finally {
      if (originalEnv !== undefined) process.env["ANTHROPIC_API_KEY"] = originalEnv;
    }
  });

  it("falls back to ANTHROPIC_API_KEY env when apiKey is not passed", async () => {
    const originalEnv = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-env";
    try {
      const factory = fakeFactory({ responses: [{ type: "tool", payload: { schemaVersion: 1 } }] });
      const r = await callScaffoldLlm({ ...INPUTS, apiKey: undefined }, { createClient: factory });
      expect(r.planJson).toEqual({ schemaVersion: 1 });
    } finally {
      if (originalEnv !== undefined) process.env["ANTHROPIC_API_KEY"] = originalEnv;
      else delete process.env["ANTHROPIC_API_KEY"];
    }
  });

  it("assembles a fully-nested tool_use input (post-stream delta accumulation)", async () => {
    // The SDK's stream() helper assembles input_json_delta events into the
    // final Message before finalMessage() resolves — so the mock's content
    // array shape must mirror that final state: input is a complete nested
    // object, NOT a partial JSON string. Verifying planJson === that object
    // (not a string) guards against a regression where someone reads
    // tool_use deltas pre-assembly and forwards raw fragments downstream.
    const nestedPlan = {
      schemaVersion: 1,
      files: [
        { kind: "create", path: "CLAUDE.md", contents: "# Claude\n" },
        { kind: "create", path: ".github/workflows/ci.yml", contents: "name: ci\n" },
      ],
      meta: { product: { slug: "demo", description: "a demo" }, totalBytes: 42 },
    };
    const factory = fakeFactory({
      responses: [{ type: "tool", payload: nestedPlan, inputTokens: 1234, outputTokens: 567 }],
    });
    const r = await callScaffoldLlm(INPUTS, { createClient: factory });
    expect(r.planJson).toEqual(nestedPlan);
    // Critical: not a string. A regression that forwarded raw partial_json
    // chunks would produce a string here.
    expect(typeof r.planJson).toBe("object");
    expect(Array.isArray((r.planJson as { files: unknown }).files)).toBe(true);
    expect(r.inputTokens).toBe(1234);
    expect(r.outputTokens).toBe(567);
  });

  it("calls messages.stream exactly once per attempt (no double-invocation)", async () => {
    // Defends against a regression where the loop accidentally calls
    // stream() twice per attempt (e.g. a stray copy left in addition to
    // the awaited finalMessage()), which would double-bill on retries.
    let streamCalls = 0;
    const factory: LlmClientFactory = () => ({
      messages: {
        stream() {
          streamCalls++;
          return {
            async finalMessage() {
              return {
                id: "msg_one",
                model: "m",
                stop_reason: "tool_use",
                content: [{ type: "tool_use", name: "emit_scaffold_plan", input: { schemaVersion: 1 } }],
                usage: { input_tokens: 10, output_tokens: 5 },
              };
            },
          };
        },
      },
    });
    await callScaffoldLlm(INPUTS, { createClient: factory });
    expect(streamCalls).toBe(1);
  });
});
