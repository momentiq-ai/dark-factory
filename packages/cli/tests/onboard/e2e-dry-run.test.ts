import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../../src/onboard/analyze.js";
import { loadTemplate } from "../../src/onboard/template-loader.js";
import { generatePlan } from "../../src/onboard/generate-plan.js";
import { applyPlan } from "../../src/onboard/apply-plan.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SYNTHETIC_TEMPLATE = resolve(HERE, "fixtures/synthetic-template");

let root: string;
let cacheRoot: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e2e-"));
  cacheRoot = await mkdtemp(join(tmpdir(), "e2e-cache-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "widget" }));
  await mkdir(join(root, "services", "api"), { recursive: true });
  await writeFile(join(root, "services", "api", "index.ts"), "");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(cacheRoot, { recursive: true, force: true });
});

describe("e2e dry-run — analyze → generatePlan → applyPlan", () => {
  it("renders a ScaffoldPlan preview that exercises emit + merge + skip", async () => {
    const analysis = await analyze(root);
    const template = await loadTemplate(
      `file://${SYNTHETIC_TEMPLATE}@0000000000000000000000000000000000000000`,
      { cacheRoot },
    );
    const callLlm = vi.fn().mockResolvedValue({
      planJson: {
        schemaVersion: 1,
        sourceAnalysisSchemaVersion: 1,
        templateRef: template.canonicalRef,
        generatedAtIso: "2026-06-03T12:00:00.000Z",
        files: [
          { path: "CLAUDE.md", action: "emit",
            rationale: "No existing CLAUDE.md (analysis.docs.hasClaudeMd === false).",
            tailored_content: "# CLAUDE.md — widget\n\n# CLAUDE.md\n" },
          { path: ".agent-review/config.json", action: "skip",
            rationale: "phase C seeder owns this path; phase B does not emit config.json" },
          { path: "docs/PRINCIPLES.md", action: "skip",
            rationale: "Generic template; nothing to tailor for the synthetic target." },
        ],
        summary: "Tailored CLAUDE.md for widget; skipped PRINCIPLES.md and config.json.",
      },
      modelId: "claude-3-7-sonnet-latest",
      inputTokens: 1000, outputTokens: 500, attempts: 1,
    });
    const plan = await generatePlan(analysis, template, { callLlm, apiKey: "k", modelId: "claude", profile: "local" });
    expect(plan.files).toHaveLength(3);

    const r = await applyPlan(root, plan, { mode: "dry-run", color: false });
    expect(r.rendered).toBeDefined();
    expect(r.rendered).toContain("emit");
    expect(r.rendered).toContain("CLAUDE.md");
    expect(r.rendered).toContain("skip");
    expect(r.rendered).toContain(".agent-review/config.json");
    // No disk writes in dry-run.
    await expect(stat(join(root, "CLAUDE.md"))).rejects.toThrow();
  });

  it("--json mode emits a Zod-valid ScaffoldPlan", async () => {
    const analysis = await analyze(root);
    const template = await loadTemplate(
      `file://${SYNTHETIC_TEMPLATE}@0000000000000000000000000000000000000000`,
      { cacheRoot },
    );
    const callLlm = vi.fn().mockResolvedValue({
      planJson: {
        schemaVersion: 1, sourceAnalysisSchemaVersion: 1,
        templateRef: template.canonicalRef,
        generatedAtIso: "2026-06-03T12:00:00.000Z",
        files: [
          { path: "CLAUDE.md", action: "emit", rationale: "x", tailored_content: "# hi\n" },
        ],
        summary: "x",
      },
      modelId: "claude", inputTokens: 1, outputTokens: 1, attempts: 1,
    });
    const plan = await generatePlan(analysis, template, { callLlm, apiKey: "k", modelId: "claude", profile: "local" });
    const { ScaffoldPlanSchema } = await import("../../src/onboard/scaffold-schema.js");
    expect(() => ScaffoldPlanSchema.parse(plan)).not.toThrow();
  });

  it("merge action with the inserted-by-cycle-15 marker round-trips through apply", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# Existing\nbody\n");
    const analysis = await analyze(root);
    const template = await loadTemplate(
      `file://${SYNTHETIC_TEMPLATE}@0000000000000000000000000000000000000000`,
      { cacheRoot },
    );
    const callLlm = vi.fn().mockResolvedValue({
      planJson: {
        schemaVersion: 1, sourceAnalysisSchemaVersion: 1,
        templateRef: template.canonicalRef,
        generatedAtIso: "2026-06-03T12:00:00.000Z",
        files: [
          { path: "CLAUDE.md", action: "merge", rationale: "additive append",
            tailored_content: "## Dark Factory onboarding\nappended section\n" },
        ],
        summary: "Merged CLAUDE.md.",
      },
      modelId: "claude", inputTokens: 1, outputTokens: 1, attempts: 1,
    });
    const plan = await generatePlan(analysis, template, { callLlm, apiKey: "k", modelId: "claude", profile: "local" });
    await applyPlan(root, plan, { mode: "apply" });
    const after = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(after).toContain("# Existing");
    expect(after).toContain("body");
    expect(after).toContain("<!-- df onboard: inserted-by-cycle-15 BEGIN -->");
    expect(after).toContain("<!-- df onboard: inserted-by-cycle-15 END -->");
    expect(after).toContain("## Dark Factory onboarding");
  });
});
