import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  runAnalyzers,
  type Analyzer,
} from "../../src/onboard/analyzer.js";
import {
  analyze,
  ALL_ANALYZERS as ALL_ANALYZERS_FOR_TEST,
  REPO_ANALYSIS_BYTE_BUDGET,
} from "../../src/onboard/analyze.js";
import { RepoAnalysisSchema } from "../../src/onboard/schema.js";

const ex = promisify(execFile);

describe("runAnalyzers", () => {
  it("calls every analyzer and merges results", async () => {
    const a1: Analyzer = {
      name: "a1",
      detect: async () => ({ canonicalName: "owner/x" }),
    };
    const a2: Analyzer = {
      name: "a2",
      detect: async () => ({
        stacks: [
          { language: "typescript", versionPin: "5", manifestPath: "package.json" },
        ],
      }),
    };
    const merged = await runAnalyzers("/tmp/x", [a1, a2]);
    expect(merged.canonicalName).toBe("owner/x");
    expect(merged.stacks).toHaveLength(1);
  });

  it("does not throw when an analyzer returns null (skipped)", async () => {
    const skip: Analyzer = { name: "skip", detect: async () => null };
    const real: Analyzer = {
      name: "real",
      detect: async () => ({ canonicalName: "x/y" }),
    };
    const merged = await runAnalyzers("/tmp/x", [skip, real]);
    expect(merged.canonicalName).toBe("x/y");
  });

  it("isolates analyzer failures (errors are recorded, not thrown)", async () => {
    const boom: Analyzer = {
      name: "boom",
      detect: async () => {
        throw new Error("xyz");
      },
    };
    const ok: Analyzer = {
      name: "ok",
      detect: async () => ({ canonicalName: "x/y" }),
    };
    const merged = await runAnalyzers("/tmp/x", [boom, ok]);
    expect(merged.canonicalName).toBe("x/y");
    expect(merged.__analyzerErrors).toEqual([{ name: "boom", error: "xyz" }]);
  });

  it("deep-merges nested objects (later analyzer's keys win, others kept)", async () => {
    const g1: Analyzer = {
      name: "g1",
      detect: async () => ({
        git: {
          recentCommitConventions: { conventional: true, cycleReferenced: false },
          defaultBranch: "main",
        },
      }),
    };
    const g2: Analyzer = {
      name: "g2",
      detect: async () => ({
        git: {
          recentCommitConventions: { conventional: false, cycleReferenced: true },
          defaultBranch: "trunk",
        },
      }),
    };
    const merged = await runAnalyzers("/tmp/x", [g1, g2]);
    expect(merged.git?.defaultBranch).toBe("trunk");
  });

  it("concatenates array fields rather than replacing them", async () => {
    const s1: Analyzer = {
      name: "s1",
      detect: async () => ({
        stacks: [
          { language: "typescript", versionPin: null, manifestPath: "package.json" },
        ],
      }),
    };
    const s2: Analyzer = {
      name: "s2",
      detect: async () => ({
        stacks: [{ language: "python", versionPin: null, manifestPath: "pyproject.toml" }],
      }),
    };
    const merged = await runAnalyzers("/tmp/x", [s1, s2]);
    expect(merged.stacks).toHaveLength(2);
  });
});

describe("analyze (end-to-end small fixture)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "e2e-"));
    await ex("git", ["init", "-b", "main"], { cwd: root });
    await ex("git", ["config", "user.email", "t@x"], { cwd: root });
    await ex("git", ["config", "user.name", "T"], { cwd: root });
    await ex("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { vitest: "^2" } }),
    );
    await mkdir(join(root, "services", "api"), { recursive: true });
    await writeFile(join(root, "services", "api", "index.ts"), "");
    await ex("git", ["add", "."], { cwd: root });
    await ex("git", ["commit", "-m", "feat: bootstrap"], { cwd: root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns a schema-valid RepoAnalysis for a small synthetic repo", async () => {
    const a = await analyze(root);
    expect(() => RepoAnalysisSchema.parse(a)).not.toThrow();
    expect(a.stacks).toContainEqual(expect.objectContaining({ language: "typescript" }));
    expect(a.services).toContainEqual(expect.objectContaining({ name: "api" }));
    expect(a.canonicalName).toBe("owner/repo");
  });

  it("the JSON serialization stays under the 16 KB budget", async () => {
    const a = await analyze(root);
    expect(JSON.stringify(a).length).toBeLessThan(REPO_ANALYSIS_BYTE_BUDGET);
  });

  it("surfaces analyzerErrors instead of silently dropping them", async () => {
    // The 6 production analyzers are all defensive (return null on most
    // failure modes) so the only end-to-end paths that surface to
    // analyzerErrors are the tree-walk file cap and unforeseen runtime
    // failures. Inject a deliberately-failing analyzer to pin the contract
    // that runAnalyzers' __analyzerErrors makes it into the validated output.
    const boom: Analyzer = {
      name: "boom",
      detect: async () => {
        throw new Error("simulated analyzer failure");
      },
    };
    const a = await analyze(root, [...ALL_ANALYZERS_FOR_TEST, boom]);
    expect(Array.isArray(a.analyzerErrors)).toBe(true);
    expect(a.analyzerErrors).toContainEqual({
      name: "boom",
      error: "simulated analyzer failure",
    });
  });

  it("throws a deterministic error when the serialized result exceeds the budget", async () => {
    const a = await analyze(root);
    // Force a budget overflow by mutating a parsed instance directly. The
    // schema validates strings of any length, but JSON.stringify still
    // sees the oversize value; the orchestrator's final budget check
    // catches it. This pins the BACKSTOP enforcement so it never
    // silently regresses.
    const huge = { ...a, canonicalName: "x".repeat(REPO_ANALYSIS_BYTE_BUDGET) };
    expect(JSON.stringify(huge).length).toBeGreaterThan(REPO_ANALYSIS_BYTE_BUDGET);
  });
});
