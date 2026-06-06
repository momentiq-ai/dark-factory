import { describe, it, expect } from "vitest";
import {
  RepoAnalysisSchema,
  type RepoAnalysis,
} from "../../src/onboard/schema.js";

describe("RepoAnalysisSchema", () => {
  const minimal: RepoAnalysis = {
    schemaVersion: 1,
    repoRoot: "/tmp/x",
    canonicalName: "owner/repo",
    stacks: [],
    services: [],
    dependencies: [],
    ci: { workflows: [], deployStory: null },
    tree: {
      topLevelDirs: [],
      languageBreakdown: {},
      testDirs: [],
      fileCount: 0,
    },
    git: {
      recentCommitConventions: {
        conventional: false,
        cycleReferenced: false,
      },
      defaultBranch: "main",
    },
    docs: {
      existing: [],
      hasClaudeMd: false,
      hasAgentsMd: false,
      agentContextSetPresent: false,
      claudeMd: null,
      agentsMd: null,
    },
    dfPresence: {
      hooks: false,
      configJson: false,
      prWorkflow: false,
      cliPin: null,
    },
    decisions: [],
    analyzerErrors: [],
  };

  it("validates a minimal RepoAnalysis", () => {
    expect(RepoAnalysisSchema.parse(minimal)).toEqual(minimal);
  });

  it("rejects unknown top-level fields", () => {
    const bad = { ...minimal, bogus: true } as unknown;
    expect(() => RepoAnalysisSchema.parse(bad)).toThrow();
  });

  it("enforces schemaVersion === 1", () => {
    const bad = { ...minimal, schemaVersion: 2 };
    expect(() => RepoAnalysisSchema.parse(bad)).toThrow();
  });

  it("serializes to JSON under 16KB for the minimal case", () => {
    const json = JSON.stringify(RepoAnalysisSchema.parse(minimal));
    expect(json.length).toBeLessThan(16_384);
  });

  it("caps dependencies at 20 entries", () => {
    const tooMany = {
      ...minimal,
      dependencies: Array.from({ length: 21 }, (_, i) => ({
        name: `pkg-${i}`,
        version: "1.0.0",
        manifestPath: "package-lock.json",
      })),
    };
    expect(() => RepoAnalysisSchema.parse(tooMany)).toThrow();
  });

  it("accepts ci.workflows at exactly 50 entries (cycle 15 Phase C cap = 50)", () => {
    const exactly50 = {
      ...minimal,
      ci: {
        deployStory: null,
        workflows: Array.from({ length: 50 }, (_, i) => ({
          name: `workflow-${i}`,
          path: `.github/workflows/wf-${i}.yml`,
          triggers: ["push"],
          jobs: ["build"],
          matrixDimensions: [],
          firstRunCommand: null,
        })),
      },
    };
    expect(() => RepoAnalysisSchema.parse(exactly50)).not.toThrow();
  });

  it("rejects ci.workflows at 51 entries (cycle 15 Phase C cap = 50)", () => {
    const tooMany = {
      ...minimal,
      ci: {
        deployStory: null,
        workflows: Array.from({ length: 51 }, (_, i) => ({
          name: `workflow-${i}`,
          path: `.github/workflows/wf-${i}.yml`,
          triggers: ["push"],
          jobs: ["build"],
          matrixDimensions: [],
          firstRunCommand: null,
        })),
      },
    };
    expect(() => RepoAnalysisSchema.parse(tooMany)).toThrow();
  });

  it("caps docs.claudeMd.headings at 50 entries", () => {
    const tooMany = {
      ...minimal,
      docs: {
        ...minimal.docs,
        hasClaudeMd: true,
        claudeMd: {
          sizeBytes: 1024,
          headings: Array.from({ length: 51 }, (_, i) => `H${i}`),
        },
      },
    };
    expect(() => RepoAnalysisSchema.parse(tooMany)).toThrow();
  });

  it("accepts a kubernetes deployStory target", () => {
    const k8s = {
      ...minimal,
      ci: {
        workflows: [],
        deployStory: {
          workflowPath: ".github/workflows/deploy.yml",
          command: "kubectl apply -f k8s/",
          target: "kubernetes" as const,
        },
      },
    };
    expect(() => RepoAnalysisSchema.parse(k8s)).not.toThrow();
  });

  it("defaults analyzerErrors to empty array when absent", () => {
    const { analyzerErrors: _drop, ...withoutErrors } = minimal;
    void _drop;
    const parsed = RepoAnalysisSchema.parse(withoutErrors);
    expect(parsed.analyzerErrors).toEqual([]);
  });
});
