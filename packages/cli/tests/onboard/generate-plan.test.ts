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

  it("throws loudly on second malformed-plan failure with the Zod error included", async () => {
    const callLlm = vi.fn().mockResolvedValue({
      planJson: { schemaVersion: 99 },
      modelId: "claude", inputTokens: 100, outputTokens: 50, attempts: 1,
    });
    await expect(generatePlan(ANALYSIS, TEMPLATE, { callLlm, apiKey: "k", modelId: "claude", profile: "local" }))
      .rejects.toThrow(/scaffold plan validation failed.*after retry/i);
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
