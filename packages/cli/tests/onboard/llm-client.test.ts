import { describe, it, expect } from "vitest";
import { callScaffoldLlm, type LlmClientFactory, type LlmInputs } from "../../src/onboard/llm-client.js";

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
      async create() {
        const idx = call++;
        stub.beforeReturn?.(call);
        const r = stub.responses[idx];
        if (!r) throw new Error(`fake factory exhausted at call ${call}`);
        if (r.type === "throw") {
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

  it("retries once on a 503 then succeeds", async () => {
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
        async create() {
          return {
            id: "msg_x", model: "m", stop_reason: "end_turn",
            content: [{ type: "text", text: "no tool call here" }],
            usage: { input_tokens: 1, output_tokens: 1 },
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
});
