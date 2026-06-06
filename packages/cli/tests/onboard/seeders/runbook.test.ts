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
        workflows: [{ name: "CI", path: ".github/workflows/ci.yml", triggers: ["push"], jobs: ["test"], matrixDimensions: [], firstRunCommand: null }],
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
        workflows: [{ name: "Release", path: ".github/workflows/release.yml", triggers: ["push"], jobs: ["deploy"], matrixDimensions: [], firstRunCommand: null }],
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
        workflows: [{ name: "Deploy", path: ".github/workflows/deploy.yml", triggers: ["push"], jobs: ["deploy"], matrixDimensions: [], firstRunCommand: null }],
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
          { name: "Release", path: ".github/workflows/release.yml", triggers: ["push"], jobs: ["release"], matrixDimensions: [], firstRunCommand: null },
          { name: "Publish to npm", path: ".github/workflows/publish.yml", triggers: ["push"], jobs: ["publish"], matrixDimensions: [], firstRunCommand: null },
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
          firstRunCommand: null,
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
        workflows: [{ name: "Release", path: ".github/workflows/release.yml", triggers: ["push"], jobs: ["deploy"], matrixDimensions: [], firstRunCommand: null }],
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
        workflows: [{ name: "Release", path: ".github/workflows/release.yml", triggers: ["push"], jobs: ["deploy"], matrixDimensions: [], firstRunCommand: null }],
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
        workflows: [{ name: "Promote to prod", path: ".github/workflows/promote.yml", triggers: ["workflow_dispatch"], jobs: ["promote"], matrixDimensions: [], firstRunCommand: null }],
        deployStory: null,
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("docs/runbooks/RUNBOOK-promote-to-prod.md");
  });

  // Fix #138 — composite-action / gitops deploy donor coverage.

  it("falls back to a non-deploy-named workflow when deploy-named ones have no firstRunCommand", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: [
          // Deploy-named but no single-line `run:` (mirrors sage3c's
          // promote-to-prod, where every step is a `run: |` block).
          {
            name: "Promote to Production", path: ".github/workflows/promote-to-prod.yml",
            triggers: ["workflow_dispatch"], jobs: ["promote"], matrixDimensions: [],
            firstRunCommand: null,
          },
          // Non-deploy-named but has a verbatim single-line run.
          {
            name: "Backend Tests", path: ".github/workflows/backend-tests.yml",
            triggers: ["push"], jobs: ["test"], matrixDimensions: [],
            firstRunCommand: "poetry install --no-interaction --no-root",
          },
        ],
        deployStory: null,
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining([
      "docs/runbooks/RUNBOOK-promote-to-production.md",
      "docs/runbooks/RUNBOOK-backend-tests.md",
    ]));
    // The donor runbook embeds the verbatim run command (provenance-correct:
    // the runbook for Backend Tests cites Backend Tests' own first run line).
    const backend = files.find((f) => f.path.endsWith("backend-tests.md"));
    expect(backend?.tailored_content).toContain("poetry install --no-interaction --no-root");
  });

  it("does NOT add a donor when at least one deploy-named workflow already has firstRunCommand", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: [
          {
            name: "Release", path: ".github/workflows/release.yml",
            triggers: ["push"], jobs: ["release"], matrixDimensions: [],
            firstRunCommand: "npm run release",
          },
          {
            name: "Backend Tests", path: ".github/workflows/backend-tests.yml",
            triggers: ["push"], jobs: ["test"], matrixDimensions: [],
            firstRunCommand: "poetry install --no-interaction --no-root",
          },
        ],
        deployStory: null,
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("docs/runbooks/RUNBOOK-release.md");
    expect(files[0]?.tailored_content).toContain("npm run release");
  });

  it("renders a composite-action deploy story with the composite-action target prose", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: [{
          name: "Release Please", path: ".github/workflows/release-please.yml",
          triggers: ["push"], jobs: ["release-please"], matrixDimensions: [],
          firstRunCommand: null,
        }],
        deployStory: {
          workflowPath: ".github/workflows/release-please.yml",
          command: "googleapis/release-please-action@v4",
          target: "composite-action",
        },
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toHaveLength(1);
    expect(files[0]?.tailored_content).toContain("composite GitHub Action");
    expect(files[0]?.tailored_content).toContain("googleapis/release-please-action@v4");
  });

  it("renders a gitops deploy story with the gitops target prose", async () => {
    const a: RepoAnalysis = {
      ...BASE,
      ci: {
        workflows: [{
          name: "Promote to Production", path: ".github/workflows/promote-to-prod.yml",
          triggers: ["workflow_dispatch"], jobs: ["promote"], matrixDimensions: [],
          firstRunCommand: null,
        }],
        deployStory: {
          workflowPath: ".github/workflows/promote-to-prod.yml",
          command: "git push origin main",
          target: "gitops",
        },
      },
    };
    const files = await runbookSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toHaveLength(1);
    expect(files[0]?.tailored_content).toContain("gitops promotion");
    expect(files[0]?.tailored_content).toContain("git push origin main");
  });
});
