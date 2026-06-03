import { describe, it, expect } from "vitest";
import {
  runAnalyzers,
  type Analyzer,
} from "../../src/onboard/analyzer.js";

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
