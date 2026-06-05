import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, ScaffoldApplyError } from "../../src/onboard/apply-plan.js";
import type { ScaffoldPlan } from "../../src/onboard/scaffold-schema.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "apply-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const PLAN: ScaffoldPlan = {
  schemaVersion: 1, sourceAnalysisSchemaVersion: 1,
  templateRef: "file:///t@0000000000000000000000000000000000000000",
  generatedAtIso: "2026-06-03T12:00:00.000Z",
  files: [
    { path: "CLAUDE.md", action: "emit", rationale: "x", tailored_content: "# hi\n" },
    { path: "AGENTS.md", action: "merge", rationale: "x", tailored_content: "## new\n" },
    { path: ".agent-review/config.json", action: "skip", rationale: "x" },
  ],
  summary: "stub",
};

describe("applyPlan — dry-run mode", () => {
  it("returns rendered preview + per-file results without writing", async () => {
    const r = await applyPlan(root, PLAN, { mode: "dry-run" });
    expect(r.rendered).toBeDefined();
    expect(r.results).toHaveLength(3);
    expect(r.results.find((x) => x.path === "CLAUDE.md")?.wrote).toBe(false);
    await expect(readFile(join(root, "CLAUDE.md"))).rejects.toThrow();
  });
});

describe("applyPlan — apply mode", () => {
  it("writes emit + merge files (merge falls back to emit because target absent)", async () => {
    const r = await applyPlan(root, PLAN, { mode: "apply" });
    const cm = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(cm).toBe("# hi\n");
    const am = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(am).toBe("## new\n");
    expect(r.rendered).toBeUndefined();
    expect(r.results.find((x) => x.path === ".agent-review/config.json")?.wrote).toBe(false);
  });

  it("uses merge semantics when target file exists", async () => {
    await writeFile(join(root, "AGENTS.md"), "# Existing\n");
    await applyPlan(root, PLAN, { mode: "apply" });
    const am = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(am).toContain("# Existing");
    expect(am).toContain("## new");
    expect(am).toContain("BEGIN");
    expect(am).toContain("END");
  });

  it("throws ScaffoldApplyError with partial-state on write failure", async () => {
    const badPlan: ScaffoldPlan = {
      ...PLAN,
      files: [
        { path: "CLAUDE.md", action: "emit", rationale: "x", tailored_content: "# ok\n" },
        { path: "readonly/x.md", action: "emit", rationale: "x", tailored_content: "y\n" },
      ],
    };
    await mkdir(join(root, "readonly"));
    await chmod(join(root, "readonly"), 0o555);
    try {
      await applyPlan(root, badPlan, { mode: "apply" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ScaffoldApplyError);
      if (e instanceof ScaffoldApplyError) {
        expect(e.written).toContain("CLAUDE.md");
        expect(e.notWritten).toContain("readonly/x.md");
      }
    } finally {
      await chmod(join(root, "readonly"), 0o755).catch(() => {});
    }
  });
});

describe("applyPlan — pr mode rejects", () => {
  it("pr mode is not handled here (use runPrMode in pr-writer.ts)", async () => {
    await expect(applyPlan(root, PLAN, { mode: "pr" } as never)).rejects.toThrow(
      /pr mode|use runPrMode/i,
    );
  });
});
