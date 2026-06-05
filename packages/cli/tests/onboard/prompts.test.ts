// packages/cli/tests/onboard/prompts.test.ts
import { describe, it, expect } from "vitest";
import { renderScaffoldPrompt } from "../../src/onboard/prompts.js";
import type { RepoAnalysis } from "../../src/onboard/schema.js";
import type { TemplateFile } from "../../src/onboard/template-loader.js";

const ANALYSIS_STUB: RepoAnalysis = {
  schemaVersion: 1,
  repoRoot: "/tmp/x",
  canonicalName: "acme/widget",
  stacks: [{ language: "typescript", versionPin: "20", manifestPath: "package.json" }],
  services: [],
  dependencies: [],
  ci: { workflows: [], deployStory: null },
  tree: { topLevelDirs: [], languageBreakdown: {}, testDirs: [], fileCount: 0 },
  git: { recentCommitConventions: { conventional: true, cycleReferenced: false }, defaultBranch: "main" },
  docs: { existing: [], hasClaudeMd: false, hasAgentsMd: false, agentContextSetPresent: false,
          claudeMd: null, agentsMd: null },
  dfPresence: { hooks: false, configJson: false, prWorkflow: false, cliPin: null },
  decisions: [],
  analyzerErrors: [],
};

const TEMPLATE_STUB: TemplateFile[] = [
  { path: "CLAUDE.md", content: "# {{ project_name }}\n" },
  { path: "AGENTS.md", content: "# Agents\n" },
];

describe("renderScaffoldPrompt", () => {
  it("substitutes {{ANALYSIS_JSON}} with the analysis JSON", async () => {
    const { userMessage } = await renderScaffoldPrompt(ANALYSIS_STUB, TEMPLATE_STUB, { profile: "local" });
    expect(userMessage).toContain('"canonicalName": "acme/widget"');
    expect(userMessage).toContain('"language": "typescript"');
  });

  it("emits a TEMPLATE_FILE_LIST line per file", async () => {
    const { userMessage } = await renderScaffoldPrompt(ANALYSIS_STUB, TEMPLATE_STUB, { profile: "local" });
    expect(userMessage).toContain("CLAUDE.md");
    expect(userMessage).toContain("AGENTS.md");
  });

  it("emits a TEMPLATE_FILE_BODIES block per file with path header and content", async () => {
    const { userMessage } = await renderScaffoldPrompt(ANALYSIS_STUB, TEMPLATE_STUB, { profile: "local" });
    expect(userMessage).toContain("path: CLAUDE.md");
    expect(userMessage).toContain("{{ project_name }}");
  });

  it("system prompt names the emit_scaffold_plan tool", async () => {
    const { systemPrompt } = await renderScaffoldPrompt(ANALYSIS_STUB, TEMPLATE_STUB, { profile: "local" });
    expect(systemPrompt).toContain("emit_scaffold_plan");
  });

  it("system prompt forbids body content for skip", async () => {
    const { systemPrompt } = await renderScaffoldPrompt(ANALYSIS_STUB, TEMPLATE_STUB, { profile: "local" });
    expect(systemPrompt.toLowerCase()).toContain("skip");
    // Asset uses markdown backticks around the field name: "NO `tailored_content`".
    // The regex accommodates the inline-code formatting.
    expect(systemPrompt).toMatch(/no\s+[`'"]?tailored_content/i);
  });

  it("renders {{ }} substitution guidance for the template (in the system prompt)", async () => {
    // The substitution guidance lives in rule 2 of the operating contract,
    // which is in the SYSTEM prompt half (before "## Inputs").
    const { systemPrompt } = await renderScaffoldPrompt(ANALYSIS_STUB, TEMPLATE_STUB, { profile: "local" });
    expect(systemPrompt.toLowerCase()).toContain("placeholder");
    expect(systemPrompt.toLowerCase()).toContain("replace");
  });

  it("substitutes {{CRITIC_PROFILE}} in the user message half (per B-D8)", async () => {
    // After the Phase B↔C contract reconciliation, {{CRITIC_PROFILE}} only
    // appears in the "### Resolved critic profile" subsection of "## Inputs"
    // (the user-message half). The system half no longer references the
    // profile by name — rule 4a is now a hardcoded "ALWAYS SKIP" rule that
    // doesn't take the profile as a parameter (the Phase C seeder owns the
    // config.json path entirely). The placeholder substitution still happens
    // on the user side so the LLM sees the resolved profile in context.
    const local = await renderScaffoldPrompt(ANALYSIS_STUB, TEMPLATE_STUB, { profile: "local" });
    expect(local.systemPrompt).not.toContain("{{CRITIC_PROFILE}}");
    expect(local.userMessage).not.toContain("{{CRITIC_PROFILE}}");
    expect(local.userMessage).toContain("local");

    const cloud = await renderScaffoldPrompt(ANALYSIS_STUB, TEMPLATE_STUB, { profile: "cloud" });
    expect(cloud.userMessage).toContain("cloud");
  });

  it("instructs the model to ALWAYS SKIP .agent-review/config.json (phase C owns it)", async () => {
    const { systemPrompt } = await renderScaffoldPrompt(ANALYSIS_STUB, TEMPLATE_STUB, { profile: "local" });
    expect(systemPrompt).toContain(".agent-review/config.json");
    expect(systemPrompt.toLowerCase()).toContain("phase c");
    expect(systemPrompt.toLowerCase()).toMatch(/skip/);
  });
});
