// packages/cli/tests/onboard/seeders/cycle1-bootstrap.test.ts
import { describe, it, expect } from "vitest";
import { cycle1BootstrapSeeder } from "../../../src/onboard/seeders/cycle1-bootstrap.js";
import type { RepoAnalysis } from "../../../src/onboard/schema.js";

const BASE: RepoAnalysis = {
  schemaVersion: 1,
  repoRoot: "/tmp/myrepo",
  canonicalName: "owner/myrepo",
  stacks: [
    { language: "typescript", versionPin: "5.5", manifestPath: "package.json" },
    { language: "python", versionPin: "3.12", manifestPath: "pyproject.toml" },
  ],
  services: [
    { name: "api", path: "services/api", stack: "typescript" },
    { name: "worker", path: "services/worker", stack: "python" },
  ],
  dependencies: [],
  ci: {
    workflows: [{ name: "Deploy", path: ".github/workflows/deploy.yml", triggers: ["push"], jobs: ["deploy"], matrixDimensions: [], firstRunCommand: null }],
    deployStory: {
      workflowPath: ".github/workflows/deploy.yml",
      command: "kubectl apply -f k8s/",
      target: "kubernetes",
    },
  },
  tree: { topLevelDirs: [], languageBreakdown: {}, testDirs: [], fileCount: 0 },
  git: { recentCommitConventions: { conventional: true, cycleReferenced: false }, defaultBranch: "main" },
  docs: { existing: [], hasClaudeMd: false, hasAgentsMd: false, agentContextSetPresent: false, claudeMd: null, agentsMd: null },
  dfPresence: { hooks: false, configJson: false, prWorkflow: false, cliPin: null },
  decisions: [],
  analyzerErrors: [],
};

describe("cycle1BootstrapSeeder", () => {
  it("emits exactly one FilePlan", async () => {
    const files = await cycle1BootstrapSeeder.seed({ analysis: BASE, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toHaveLength(1);
    expect(files[0]?.action).toBe("emit");
  });

  it("file path uses the canonical repo-name (the part after the slash)", async () => {
    const files = await cycle1BootstrapSeeder.seed({ analysis: BASE, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files[0]?.path).toBe("docs/roadmap/cycles/cycle1-myrepo-bootstrap.md");
  });

  it("renders the real service names and paths in the Services section", async () => {
    const files = await cycle1BootstrapSeeder.seed({ analysis: BASE, existingAdrs: [], now: new Date("2026-06-03") });
    const body = files[0]!.tailored_content;
    expect(body).toContain("api");
    expect(body).toContain("services/api");
    expect(body).toContain("worker");
    expect(body).toContain("services/worker");
  });

  it("renders the real stacks with their version pins", async () => {
    const files = await cycle1BootstrapSeeder.seed({ analysis: BASE, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files[0]!.tailored_content).toMatch(/typescript.*5\.5/);
    expect(files[0]!.tailored_content).toMatch(/python.*3\.12/);
  });

  it("renders the verbatim deploy command in the Deploy story section", async () => {
    const files = await cycle1BootstrapSeeder.seed({ analysis: BASE, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files[0]!.tailored_content).toContain("kubectl apply -f k8s/");
    expect(files[0]!.tailored_content).toContain(".github/workflows/deploy.yml");
  });

  it("renders the canonical name in frontmatter related_repos", async () => {
    const files = await cycle1BootstrapSeeder.seed({ analysis: BASE, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files[0]!.tailored_content).toContain("owner/myrepo");
  });

  it("emits no unreplaced template tokens", async () => {
    const files = await cycle1BootstrapSeeder.seed({ analysis: BASE, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files[0]!.tailored_content).not.toMatch(/\{[a-z_]+\}/);
  });

  it("falls back to repoRoot basename when canonicalName is empty", async () => {
    const a: RepoAnalysis = { ...BASE, canonicalName: "" };
    const files = await cycle1BootstrapSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files[0]?.path).toBe("docs/roadmap/cycles/cycle1-myrepo-bootstrap.md");
  });

  it("emits the no-deploy story marker when deployStory is null", async () => {
    const a: RepoAnalysis = { ...BASE, ci: { workflows: [], deployStory: null } };
    const files = await cycle1BootstrapSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files[0]!.tailored_content).toContain("(no deploy workflow detected — add one before standing up CD)");
  });

  it("emits the no-services marker when services[] is empty", async () => {
    const a: RepoAnalysis = { ...BASE, services: [] };
    const files = await cycle1BootstrapSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files[0]!.tailored_content).toContain("(no services/ or apps/ directory — single-package repo)");
  });
});
