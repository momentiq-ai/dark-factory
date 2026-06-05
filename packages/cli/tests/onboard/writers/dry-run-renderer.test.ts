// packages/cli/tests/onboard/writers/dry-run-renderer.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDryRun } from "../../../src/onboard/writers/dry-run-renderer.js";
import type { ScaffoldPlan } from "../../../src/onboard/scaffold-schema.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "dry-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const PLAN: ScaffoldPlan = {
  schemaVersion: 1,
  sourceAnalysisSchemaVersion: 1,
  templateRef: "file:///t@0000000000000000000000000000000000000000",
  generatedAtIso: "2026-06-03T12:00:00.000Z",
  files: [
    { path: "NEW.md", action: "emit",  rationale: "no existing file", tailored_content: "# new\n" },
    { path: "CLAUDE.md", action: "merge", rationale: "additive append",
      tailored_content: "## Section\nbody\n" },
    { path: ".agent-review/config.json", action: "skip", rationale: "already present" },
  ],
  summary: "Tailored 1 emit + 1 merge + 1 skip.",
};

describe("renderDryRun", () => {
  it("renders an 'emit (new file)' line for files that don't exist", async () => {
    const r = await renderDryRun(root, PLAN, { color: false });
    expect(r).toContain("emit");
    expect(r).toContain("NEW.md");
    expect(r).toContain("new file");
  });

  it("renders a unified diff for emit when the file exists (overwrite preview)", async () => {
    await writeFile(join(root, "NEW.md"), "# existing\n");
    const r = await renderDryRun(root, PLAN, { color: false });
    // `createPatch` from the `diff` package emits unified-diff context lines
    // as `-<content>` and `+<content>` (no space between sign and content for
    // changed lines). Assert against the actual emission shape.
    expect(r).toContain("-# existing");
    expect(r).toContain("+# new");
  });

  it("renders a 'merge (append)' line for merge files that exist", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# existing\nbody\n");
    const r = await renderDryRun(root, PLAN, { color: false });
    expect(r).toContain("merge");
    expect(r).toContain("CLAUDE.md");
    expect(r).toContain("Section");
  });

  it("renders a 'skip (no-op)' line for skip files", async () => {
    const r = await renderDryRun(root, PLAN, { color: false });
    expect(r).toContain("skip");
    expect(r).toContain(".agent-review/config.json");
  });

  it("includes the summary line at the end", async () => {
    const r = await renderDryRun(root, PLAN, { color: false });
    expect(r).toContain("Tailored 1 emit + 1 merge + 1 skip.");
  });

  it("respects color: false (no ANSI escapes)", async () => {
    const r = await renderDryRun(root, PLAN, { color: false });
    expect(r).not.toMatch(/\x1b\[/);
  });

  it("includes ANSI escapes when color: true", async () => {
    const r = await renderDryRun(root, PLAN, { color: true });
    expect(r).toMatch(/\x1b\[/);
  });

  it("respects NO_COLOR env var when color option omitted", async () => {
    const orig = process.env["NO_COLOR"];
    process.env["NO_COLOR"] = "1";
    try {
      const r = await renderDryRun(root, PLAN);
      expect(r).not.toMatch(/\x1b\[/);
    } finally {
      if (orig === undefined) delete process.env["NO_COLOR"]; else process.env["NO_COLOR"] = orig;
    }
  });
});
