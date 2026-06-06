// packages/cli/tests/onboard/seeders/adr.test.ts
//
// ADR seeder unit tests — cycle 15 Phase C Task 1.
//
// Pins the per-decision rendering contract: filename pattern, auto-increment,
// section structure (Context/Decision/Consequences), evidence citation,
// per-surface token interpolation, slug-collision skip, and the "no unreplaced
// tokens" exit criterion (cycle 15 line 191).
import { describe, it, expect } from "vitest";
import { adrSeeder } from "../../../src/onboard/seeders/adr.js";
import type { RepoAnalysis } from "../../../src/onboard/schema.js";

const BASE_ANALYSIS: RepoAnalysis = {
  schemaVersion: 1,
  repoRoot: "/tmp/x",
  canonicalName: "owner/repo",
  stacks: [{ language: "typescript", versionPin: "5.5", manifestPath: "package.json" }],
  services: [],
  dependencies: [
    { name: "vitest", version: "2.1.0", manifestPath: "package-lock.json" },
    { name: "react", version: "18.3.1", manifestPath: "package-lock.json" },
  ],
  ci: {
    workflows: [{
      name: "Release", path: ".github/workflows/release.yml",
      triggers: ["push"], jobs: ["deploy"], matrixDimensions: [],
      firstRunCommand: null,
    }],
    deployStory: {
      workflowPath: ".github/workflows/release.yml",
      command: "helm upgrade myapp ./chart",
      target: "helm",
    },
  },
  tree: { topLevelDirs: [], languageBreakdown: {}, testDirs: [], fileCount: 0 },
  git: { recentCommitConventions: { conventional: true, cycleReferenced: false }, defaultBranch: "main" },
  docs: {
    existing: [], hasClaudeMd: false, hasAgentsMd: false, agentContextSetPresent: false,
    claudeMd: null, agentsMd: null,
  },
  dfPresence: { hooks: false, configJson: false, prWorkflow: false, cliPin: null },
  decisions: [],
  analyzerErrors: [],
};

describe("adrSeeder", () => {
  it("emits no files when decisions[] is empty", async () => {
    const files = await adrSeeder.seed({ analysis: BASE_ANALYSIS, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toEqual([]);
  });

  it("emits one ADR per decision entry", async () => {
    const a: RepoAnalysis = {
      ...BASE_ANALYSIS,
      decisions: [
        { title: "Vitest as test framework", surface: "test-framework", evidence: ["package-lock.json"] },
        { title: "Helm deploy target", surface: "deploy-target", evidence: [".github/workflows/release.yml"] },
        { title: "React frontend stack", surface: "stack", evidence: ["package-lock.json"] },
      ],
    };
    const files = await adrSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    expect(files).toHaveLength(3);
    for (const f of files) {
      expect(f.path).toMatch(/^docs\/ADR\/2026-\d{2}-[a-z0-9-]+\.md$/);
      expect(f.action).toBe("emit");
    }
  });

  it("auto-increments NN from the highest existing ADR with the same year prefix", async () => {
    const a: RepoAnalysis = {
      ...BASE_ANALYSIS,
      decisions: [
        { title: "Vitest as test framework", surface: "test-framework", evidence: ["package-lock.json"] },
        { title: "Helm deploy target", surface: "deploy-target", evidence: [".github/workflows/release.yml"] },
      ],
    };
    const files = await adrSeeder.seed({
      analysis: a,
      existingAdrs: ["2026-05-creator-model-autonomy.md", "2026-07-some-existing-decision.md"],
      now: new Date("2026-06-03"),
    });
    // Highest existing 2026 ADR is 07; new ADRs start at 08.
    expect(files[0]?.path).toBe("docs/ADR/2026-08-vitest-as-test-framework.md");
    expect(files[1]?.path).toBe("docs/ADR/2026-09-helm-deploy-target.md");
  });

  it("starts at 01 when no existing ADRs match the current year", async () => {
    const a: RepoAnalysis = {
      ...BASE_ANALYSIS,
      decisions: [{ title: "Vitest as test framework", surface: "test-framework", evidence: ["package-lock.json"] }],
    };
    const files = await adrSeeder.seed({
      analysis: a,
      existingAdrs: ["2024-12-old-decision.md"],
      now: new Date("2026-06-03"),
    });
    expect(files[0]?.path).toBe("docs/ADR/2026-01-vitest-as-test-framework.md");
  });

  it("each emitted ADR has non-empty Context, Decision, Consequences sections", async () => {
    const a: RepoAnalysis = {
      ...BASE_ANALYSIS,
      decisions: [
        { title: "Vitest as test framework", surface: "test-framework", evidence: ["package-lock.json"] },
      ],
    };
    const files = await adrSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    const first = files[0]!;
    expect(first.action).toBe("emit");
    // Discriminated-union narrowing: only emit/merge carry tailored_content.
    if (first.action !== "emit" && first.action !== "merge") throw new Error("expected emit");
    const body = first.tailored_content;
    expect(body).toMatch(/^## Context\s*$/m);
    expect(body).toMatch(/^## Decision\s*$/m);
    expect(body).toMatch(/^## Consequences\s*$/m);
    // Non-empty sections: between each H2 and the next there is at least one non-blank, non-heading line.
    const sections = body.split(/^## /m).slice(1);
    for (const s of sections) {
      const inner = s.split("\n").slice(1).join("\n").trim();
      expect(inner.length).toBeGreaterThan(0);
    }
  });

  it("Context section cites at least one evidence file verbatim", async () => {
    const a: RepoAnalysis = {
      ...BASE_ANALYSIS,
      decisions: [
        { title: "Helm deploy target", surface: "deploy-target", evidence: [".github/workflows/release.yml"] },
      ],
    };
    const files = await adrSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    const first = files[0]!;
    if (first.action !== "emit" && first.action !== "merge") throw new Error("expected emit");
    expect(first.tailored_content).toContain(".github/workflows/release.yml");
  });

  it("interpolates the deploy command verbatim in the deploy-target ADR Decision section", async () => {
    const a: RepoAnalysis = {
      ...BASE_ANALYSIS,
      decisions: [
        { title: "Helm deploy target", surface: "deploy-target", evidence: [".github/workflows/release.yml"] },
      ],
    };
    const files = await adrSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    const first = files[0]!;
    if (first.action !== "emit" && first.action !== "merge") throw new Error("expected emit");
    expect(first.tailored_content).toContain("helm upgrade myapp ./chart");
  });

  it("interpolates the pinned test-runner version in the test-framework ADR Consequences section", async () => {
    const a: RepoAnalysis = {
      ...BASE_ANALYSIS,
      decisions: [
        { title: "Vitest as test framework", surface: "test-framework", evidence: ["package-lock.json"] },
      ],
    };
    const files = await adrSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    const first = files[0]!;
    if (first.action !== "emit" && first.action !== "merge") throw new Error("expected emit");
    expect(first.tailored_content).toContain("vitest@2.1.0");
  });

  it("skips with a structured reason when an ADR with the same slug already exists", async () => {
    const a: RepoAnalysis = {
      ...BASE_ANALYSIS,
      decisions: [
        { title: "Vitest as test framework", surface: "test-framework", evidence: ["package-lock.json"] },
      ],
    };
    const files = await adrSeeder.seed({
      analysis: a,
      existingAdrs: ["2026-03-vitest-as-test-framework.md"],
      now: new Date("2026-06-03"),
    });
    expect(files).toHaveLength(1);
    expect(files[0]!.action).toBe("skip");
    expect(files[0]!.rationale).toContain("adr_already_exists");
  });

  it("emits no unreplaced template tokens in any rendered ADR", async () => {
    const a: RepoAnalysis = {
      ...BASE_ANALYSIS,
      decisions: [
        { title: "Vitest as test framework", surface: "test-framework", evidence: ["package-lock.json"] },
        { title: "Helm deploy target", surface: "deploy-target", evidence: [".github/workflows/release.yml"] },
        { title: "React frontend stack", surface: "stack", evidence: ["package-lock.json"] },
        { title: "Some unknown decision", surface: "other", evidence: ["README.md"] },
      ],
    };
    const files = await adrSeeder.seed({ analysis: a, existingAdrs: [], now: new Date("2026-06-03") });
    for (const f of files) {
      if (f.action !== "emit" && f.action !== "merge") continue;
      // The `{token}` placeholder regex catches any unbound token the per-surface
      // template forgot to expand. Critical for the "no template placeholders"
      // exit criterion (cycle 15 line 191).
      expect(f.tailored_content).not.toMatch(/\{[a-z_]+\}/);
    }
  });
});
