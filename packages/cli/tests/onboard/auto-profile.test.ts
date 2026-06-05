import { describe, it, expect } from "vitest";
import { autoProfile } from "../../src/onboard/auto-profile.js";
import type { RepoAnalysis } from "../../src/onboard/schema.js";

const BASE: RepoAnalysis = {
  schemaVersion: 1,
  repoRoot: "/tmp/x",
  canonicalName: "acme/widget",
  stacks: [],
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

describe("autoProfile", () => {
  it("returns 'local' for a fresh repo with no DF gate", () => {
    expect(autoProfile(BASE)).toBe("local");
  });

  it("returns 'cloud' when cliPin is set AND prWorkflow is true (already on the cloud quartet)", () => {
    expect(autoProfile({
      ...BASE,
      dfPresence: { ...BASE.dfPresence, cliPin: "2.0.0", prWorkflow: true },
    })).toBe("cloud");
  });

  it("returns 'local' when cliPin is set but prWorkflow is false (gate-less consumer)", () => {
    expect(autoProfile({
      ...BASE,
      dfPresence: { ...BASE.dfPresence, cliPin: "2.0.0", prWorkflow: false },
    })).toBe("local");
  });

  it("returns 'local' when prWorkflow is true but cliPin is null (manual-wire consumer)", () => {
    expect(autoProfile({
      ...BASE,
      dfPresence: { ...BASE.dfPresence, cliPin: null, prWorkflow: true },
    })).toBe("local");
  });
});
