// packages/cli/tests/onboard/generate-plan.test.ts
import { describe, it, expect, vi } from "vitest";
import { generatePlan } from "../../src/onboard/generate-plan.js";
import type { RepoAnalysis } from "../../src/onboard/schema.js";
import type { Template } from "../../src/onboard/template-loader.js";

const ANALYSIS: RepoAnalysis = {
  schemaVersion: 1,
  repoRoot: "/tmp/x",
  canonicalName: "acme/widget",
  stacks: [], services: [], dependencies: [],
  ci: { workflows: [], deployStory: null },
  tree: { topLevelDirs: [], languageBreakdown: {}, testDirs: [], fileCount: 0 },
  git: { recentCommitConventions: { conventional: false, cycleReferenced: false }, defaultBranch: "main" },
  docs: { existing: [], hasClaudeMd: false, hasAgentsMd: false, agentContextSetPresent: false,
          claudeMd: null, agentsMd: null },
  dfPresence: { hooks: false, configJson: false, prWorkflow: false, cliPin: null },
  decisions: [], analyzerErrors: [],
};

const TEMPLATE: Template = {
  canonicalRef: "file:///t@0000000000000000000000000000000000000000",
  resolvedSha: "0000000000000000000000000000000000000000",
  cacheDir: "/tmp/cache",
  files: [{ path: "CLAUDE.md", content: "# {{ project_name }}\n" }],
};

const VALID_PLAN = {
  schemaVersion: 1,
  sourceAnalysisSchemaVersion: 1,
  templateRef: "file:///t@0000000000000000000000000000000000000000",
  generatedAtIso: "2026-06-03T12:00:00.000Z",
  files: [
    { path: "CLAUDE.md", action: "emit", rationale: "no existing CLAUDE.md",
      tailored_content: "# widget\n" },
  ],
  summary: "Emitted CLAUDE.md for acme/widget.",
};

describe("generatePlan", () => {
  it("returns a Zod-validated ScaffoldPlan on first LLM success", async () => {
    const callLlm = vi.fn().mockResolvedValue({
      planJson: VALID_PLAN, modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
    });
    const plan = await generatePlan(ANALYSIS, TEMPLATE, { callLlm, apiKey: "k", modelId: "claude", profile: "local" });
    expect(plan.files[0]?.path).toBe("CLAUDE.md");
    expect(plan.files[0]?.action).toBe("emit");
  });

  it("retries once when the LLM returns a malformed plan, succeeds on retry", async () => {
    const callLlm = vi.fn()
      .mockResolvedValueOnce({
        planJson: { schemaVersion: 99 }, // wrong version → Zod rejects
        modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
      })
      .mockResolvedValueOnce({
        planJson: VALID_PLAN,
        modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
      });
    const plan = await generatePlan(ANALYSIS, TEMPLATE, { callLlm, apiKey: "k", modelId: "claude", profile: "local" });
    expect(plan.summary).toContain("widget");
    expect(callLlm).toHaveBeenCalledTimes(2);
  });

  it("throws loudly on persistent malformed-plan failure with every attempt's Zod errors included", async () => {
    const callLlm = vi.fn().mockResolvedValue({
      planJson: { schemaVersion: 99 },
      modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
    });
    await expect(generatePlan(ANALYSIS, TEMPLATE, { callLlm, apiKey: "k", modelId: "claude", profile: "local" }))
      .rejects.toThrow(/scaffold plan validation failed after \d+ attempts/i);
    // MAX_ATTEMPTS rounds when every call returns malformed.
    expect(callLlm).toHaveBeenCalledTimes(3);
  });

  it("on validation failure, replays the malformed tool_use as an assistant turn + a tool_result error to the next call", async () => {
    // The corrective-retry contract (#158): instead of re-asking blind, the
    // next call's `messages` array MUST include the model's prior malformed
    // output (as an assistant `tool_use` block) AND a user turn whose content
    // is a `tool_result` with `is_error: true` carrying the Zod issues. This
    // gives the model patch-mode (fix only what was wrong, against its own
    // prior output) instead of regen-mode (rewrite the whole plan).
    const malformedPayload = { schemaVersion: 99, garbage: "yes" };
    let secondCallArgs: { messages: unknown[] } | null = null;
    const callLlm = vi.fn()
      .mockImplementationOnce(async () => ({
        planJson: malformedPayload,
        modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
      }))
      .mockImplementationOnce(async (args: { messages: unknown[] }) => {
        secondCallArgs = args;
        return {
          planJson: VALID_PLAN,
          modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
        };
      });

    await generatePlan(ANALYSIS, TEMPLATE, { callLlm, apiKey: "k", modelId: "claude", profile: "local" });

    expect(callLlm).toHaveBeenCalledTimes(2);
    expect(secondCallArgs).not.toBeNull();
    const msgs = (secondCallArgs as unknown as { messages: Array<{ role: string; content: unknown }> }).messages;
    // 3 turns: initial user prompt + replayed assistant tool_use + corrective user tool_result.
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.role).toBe("user");

    const assistantTurn = msgs[1]!;
    expect(assistantTurn.role).toBe("assistant");
    const assistantContent = assistantTurn.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>;
    expect(assistantContent[0]!.type).toBe("tool_use");
    expect(assistantContent[0]!.name).toBe("emit_scaffold_plan");
    // Critical: the model sees its own prior output verbatim — not an
    // abstract description of it. Patch-mode, not regen-mode.
    expect(assistantContent[0]!.input).toEqual(malformedPayload);
    const synthesizedId = assistantContent[0]!.id;
    expect(typeof synthesizedId).toBe("string");

    const correctiveTurn = msgs[2]!;
    expect(correctiveTurn.role).toBe("user");
    const correctiveContent = correctiveTurn.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: string }>;
    expect(correctiveContent[0]!.type).toBe("tool_result");
    expect(correctiveContent[0]!.is_error).toBe(true);
    // tool_use_id ties the user reply back to the assistant tool_use — the
    // API is stateless so a fabricated id is fine, but they must match.
    expect(correctiveContent[0]!.tool_use_id).toBe(synthesizedId);
    // Feedback must carry the actual Zod error path so the model knows what to fix.
    expect(correctiveContent[0]!.content).toMatch(/schemaVersion/);
  });

  it("loops up to MAX_ATTEMPTS (3) total calls when the model keeps returning malformed plans", async () => {
    // First two calls malformed, third succeeds — proves the loop runs > 2 rounds.
    const callLlm = vi.fn()
      .mockResolvedValueOnce({
        planJson: { schemaVersion: 99 },
        modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
      })
      .mockResolvedValueOnce({
        planJson: { schemaVersion: 99, files: "string-not-array" },
        modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
      })
      .mockResolvedValueOnce({
        planJson: VALID_PLAN,
        modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
      });
    const plan = await generatePlan(ANALYSIS, TEMPLATE, { callLlm, apiKey: "k", modelId: "claude", profile: "local" });
    expect(plan.summary).toContain("widget");
    expect(callLlm).toHaveBeenCalledTimes(3);
  });

  it("enforces the 64 KB byte budget on the validated plan", async () => {
    const huge = {
      ...VALID_PLAN,
      files: Array.from({ length: 5 }, (_, i) => ({
        path: `f${i}.md`, action: "emit" as const, rationale: "x",
        tailored_content: "x".repeat(15_000), // 5 × 15 KB ≈ 75 KB total
      })),
    };
    const callLlm = vi.fn().mockResolvedValue({
      planJson: huge, modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
    });
    await expect(generatePlan(ANALYSIS, TEMPLATE, { callLlm, apiKey: "k", modelId: "claude", profile: "local" }))
      .rejects.toThrow(/64.*KB|byte budget/);
  });

  it("stamps templateRef from the input Template, not from the LLM", async () => {
    const callLlm = vi.fn().mockResolvedValue({
      planJson: { ...VALID_PLAN, templateRef: "gh:fake/wrong@1111111111111111111111111111111111111111" },
      modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
    });
    const plan = await generatePlan(ANALYSIS, TEMPLATE, { callLlm, apiKey: "k", modelId: "claude", profile: "local" });
    expect(plan.templateRef).toBe("file:///t@0000000000000000000000000000000000000000");
  });
});
