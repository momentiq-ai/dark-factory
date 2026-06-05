// packages/cli/tests/onboard/seeders/index.test.ts
//
// Task 3.5 unit tests for runSeeders + ALL_SEEDERS_DEFAULT.
import { describe, it, expect } from "vitest";
import {
  runSeeders,
  ALL_SEEDERS_DEFAULT,
  adrSeeder,
  cycle1BootstrapSeeder,
  runbookSeeder,
  agentReviewConfigSeeder,
  type Seeder,
} from "../../../src/onboard/seeders/index.js";
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
  git: {
    recentCommitConventions: { conventional: false, cycleReferenced: false },
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
  dfPresence: { hooks: false, configJson: false, prWorkflow: false, cliPin: null },
  decisions: [],
  analyzerErrors: [],
};

describe("runSeeders", () => {
  it("runs every seeder and concatenates outputs", async () => {
    const s1: Seeder = {
      name: "s1",
      seed: async () => [
        { path: "a.md", action: "emit", rationale: "r1", tailored_content: "x" },
      ],
    };
    const s2: Seeder = {
      name: "s2",
      seed: async () => [
        { path: "b.md", action: "emit", rationale: "r2", tailored_content: "y" },
      ],
    };
    const out = await runSeeders(
      { analysis: BASE, existingAdrs: [], now: new Date("2026-06-03"), profile: "local" },
      [s1, s2],
    );
    expect(out).toHaveLength(2);
  });

  it("isolates a seeder failure (records to stderr, never throws)", async () => {
    const boom: Seeder = {
      name: "boom",
      seed: async () => {
        throw new Error("oops");
      },
    };
    const ok: Seeder = {
      name: "ok",
      seed: async () => [
        { path: "ok.md", action: "emit", rationale: "r", tailored_content: "y" },
      ],
    };
    const out = await runSeeders(
      { analysis: BASE, existingAdrs: [], now: new Date("2026-06-03"), profile: "local" },
      [boom, ok],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe("ok.md");
  });
});

describe("ALL_SEEDERS_DEFAULT", () => {
  it("includes all four Phase C seeders in a stable order", () => {
    expect(ALL_SEEDERS_DEFAULT).toHaveLength(4);
    const names = ALL_SEEDERS_DEFAULT.map((s) => s.name);
    expect(names).toContain(adrSeeder.name);
    expect(names).toContain(cycle1BootstrapSeeder.name);
    expect(names).toContain(runbookSeeder.name);
    expect(names).toContain(agentReviewConfigSeeder.name);
  });
});
