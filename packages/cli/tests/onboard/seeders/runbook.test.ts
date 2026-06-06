// packages/cli/tests/onboard/seeders/runbook.test.ts
import { describe, it, expect } from "vitest";
import { runbookSeeder } from "../../../src/onboard/seeders/runbook.js";
import type { RepoAnalysis } from "../../../src/onboard/schema.js";

const BASE: RepoAnalysis = {
  schemaVersion: 1,
  repoRoot: "/tmp/x",
  canonicalName: "owner/repo",
  stacks: [],
  services: [],
  dependencies: [],
  ci: { workflows: [], deployStory: null },
  tree: { topLevelDirs: [], languageBreakdown: {}, testDirs: [], fileCount: 0 },
  git: { recentCommitConventions: { conventional: false, cycleReferenced: false }, defaultBranch: "main" },
  docs: { existing: [], hasClaudeMd: false, hasAgentsMd: false, agentContextSetPresent: false, claudeMd: null, agentsMd: null },
  dfPresence: { hooks: false, configJson: false, prWorkflow: false, cliPin: null },
  decisions: [],
  analyzerErrors: [],
};

describe("runbookSeeder", () => {
  it("emits no files when no workflow matches the deploy-pattern heuristic", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: [{ name: "CI", path: ".github/workflows/ci.yml", triggers: ["push"], jobs: ["test"], matrixDimensions: [] }],
        deployStory: null,
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toEqual([]);
  });

  it("emits a runbook for a workflow named 'Release'", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: [{ name: "Release", path: ".github/workflows/release.yml", triggers: ["push"], jobs: ["deploy"], matrixDimensions: [] }],
        deployStory: { workflowPath: ".github/workflows/release.yml", command: "helm upgrade myapp ./chart", target: "helm" },
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("docs/runbooks/RUNBOOK-release.md");
    expect(files[0]?.action).toBe("emit");
  });

  it("includes the verbatim deploy command for the workflow that produced deployStory", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: [{ name: "Deploy", path: ".github/workflows/deploy.yml", triggers: ["push"], jobs: ["deploy"], matrixDimensions: [] }],
        deployStory: { workflowPath: ".github/workflows/deploy.yml", command: "kubectl apply -f k8s/", target: "kubernetes" },
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files[0]!.tailored_content).toContain("kubectl apply -f k8s/");
  });

  it("emits separate runbooks for multiple matching workflows", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: [
          { name: "Release", path: ".github/workflows/release.yml", triggers: ["push"], jobs: ["release"], matrixDimensions: [] },
          { name: "Publish to npm", path: ".github/workflows/publish.yml", triggers: ["push"], jobs: ["publish"], matrixDimensions: [] },
        ],
        deployStory: null,
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining([
      "docs/runbooks/RUNBOOK-release.md",
      "docs/runbooks/RUNBOOK-publish-to-npm.md",
    ]));
  });

  it("caps at 5 runbooks", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: Array.from({ length: 8 }, (_, i) => ({
          name: `Deploy ${i}`, path: `.github/workflows/deploy-${i}.yml`,
          triggers: ["push"], jobs: ["deploy"], matrixDimensions: [],
        })),
        deployStory: null,
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toHaveLength(5);
  });

  it("cites the workflow path in the runbook body", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: [{ name: "Release", path: ".github/workflows/release.yml", triggers: ["push"], jobs: ["deploy"], matrixDimensions: [] }],
        deployStory: { workflowPath: ".github/workflows/release.yml", command: "helm upgrade myapp ./chart", target: "helm" },
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files[0]!.tailored_content).toContain(".github/workflows/release.yml");
  });

  it("emits no unreplaced template tokens", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: [{ name: "Release", path: ".github/workflows/release.yml", triggers: ["push"], jobs: ["deploy"], matrixDimensions: [] }],
        deployStory: { workflowPath: ".github/workflows/release.yml", command: "helm upgrade myapp ./chart", target: "helm" },
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files[0]!.tailored_content).not.toMatch(/\{[a-z_]+\}/);
  });

  it("matches 'Promote to prod' workflow via the regex", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: [{ name: "Promote to prod", path: ".github/workflows/promote.yml", triggers: ["workflow_dispatch"], jobs: ["promote"], matrixDimensions: [] }],
        deployStory: null,
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("docs/runbooks/RUNBOOK-promote-to-prod.md");
  });
});
