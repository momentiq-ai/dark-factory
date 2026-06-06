// packages/cli/tests/onboard/seeders/agent-review-config.test.ts
//
// Task 3.6 unit tests for the agent-review-config seeder. The canonical JSON
// bodies live at the PRODUCTION path
// `packages/cli/src/onboard/seeders/agent-review-config/{local,cloud}.canonical.json`
// (ships in the published npm package). The seeder reads from that same
// path at runtime; this test `readFile`s the same path — single source of
// truth, no tests/fixtures/ duplicate.
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { agentReviewConfigSeeder } from "../../../src/onboard/seeders/agent-review-config.js";
import type { RepoAnalysis } from "../../../src/onboard/schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Recursive deep-sort: compare nested JSON without false-failing on key-order
// drift. Mirrors the Task 5 sage3c harness helper.
function deepSort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepSort);
  if (v && typeof v === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = deepSort((v as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return v;
}

describe("agentReviewConfigSeeder", () => {
  it("emits exactly one FilePlan at path `.agent-review/config.json` with action=emit", async () => {
    const out = await agentReviewConfigSeeder.seed({
      analysis: BASE,
      existingAdrs: [],
      now: new Date("2026-06-03"),
      profile: "local",
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe(".agent-review/config.json");
    expect(out[0]?.action).toBe("emit");
  });

  it("local profile: tailored_content deep-sort-equals the local canonical JSON (production-located, single source)", async () => {
    const out = await agentReviewConfigSeeder.seed({
      analysis: BASE,
      existingAdrs: [],
      now: new Date("2026-06-03"),
      profile: "local",
    });
    const entry = out[0] as { tailored_content: string };
    const actual = JSON.parse(entry.tailored_content);
    const expected = JSON.parse(
      await readFile(
        resolve(
          __dirname,
          "..",
          "..",
          "..",
          "src",
          "onboard",
          "seeders",
          "agent-review-config",
          "local.canonical.json",
        ),
        "utf8",
      ),
    );
    expect(JSON.stringify(deepSort(actual))).toEqual(JSON.stringify(deepSort(expected)));
  });

  it("cloud profile: tailored_content deep-sort-equals the cloud canonical JSON (production-located, single source)", async () => {
    const out = await agentReviewConfigSeeder.seed({
      analysis: BASE,
      existingAdrs: [],
      now: new Date("2026-06-03"),
      profile: "cloud",
    });
    const entry = out[0] as { tailored_content: string };
    const actual = JSON.parse(entry.tailored_content);
    const expected = JSON.parse(
      await readFile(
        resolve(
          __dirname,
          "..",
          "..",
          "..",
          "src",
          "onboard",
          "seeders",
          "agent-review-config",
          "cloud.canonical.json",
        ),
        "utf8",
      ),
    );
    expect(JSON.stringify(deepSort(actual))).toEqual(JSON.stringify(deepSort(expected)));
  });

  it("defaults profile to 'local' when SeederInput.profile is absent", async () => {
    const out = await agentReviewConfigSeeder.seed({
      analysis: BASE,
      existingAdrs: [],
      now: new Date("2026-06-03"),
    });
    const entry = out[0] as { tailored_content: string };
    const actual = JSON.parse(entry.tailored_content);
    expect(actual.profiles.local).toBeDefined();
    expect(actual.profiles.local.quorum).toBe(2);
  });
});
