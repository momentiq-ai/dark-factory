import { describe, it, expect } from "vitest";
import {
  ScaffoldPlanSchema,
  FilePlanSchema,
  SCAFFOLD_PLAN_SCHEMA_VERSION,
  type ScaffoldPlan,
  type FilePlan,
} from "../../src/onboard/scaffold-schema.js";

describe("ScaffoldPlanSchema", () => {
  const minimal: ScaffoldPlan = {
    schemaVersion: 1,
    sourceAnalysisSchemaVersion: 1,
    templateRef: "gh:momentiq-ai/sage-blueprint@0000000000000000000000000000000000000000",
    generatedAtIso: "2026-06-03T00:00:00.000Z",
    files: [],
    summary: "Empty plan.",
  };

  it("validates a minimal ScaffoldPlan", () => {
    expect(ScaffoldPlanSchema.parse(minimal)).toEqual(minimal);
  });

  it("enforces SCAFFOLD_PLAN_SCHEMA_VERSION === 1", () => {
    const bad = { ...minimal, schemaVersion: 2 };
    expect(() => ScaffoldPlanSchema.parse(bad)).toThrow();
  });

  it("pins sourceAnalysisSchemaVersion to the Phase A version (1)", () => {
    const bad = { ...minimal, sourceAnalysisSchemaVersion: 2 };
    expect(() => ScaffoldPlanSchema.parse(bad)).toThrow();
  });

  it("rejects unknown top-level fields (strict)", () => {
    const bad = { ...minimal, bogus: true } as unknown;
    expect(() => ScaffoldPlanSchema.parse(bad)).toThrow();
  });

  it("caps files at 100 entries", () => {
    const tooMany = {
      ...minimal,
      files: Array.from({ length: 101 }, (_, i) => ({
        path: `f${i}.md`, action: "skip" as const, rationale: "x",
      })),
    };
    expect(() => ScaffoldPlanSchema.parse(tooMany)).toThrow();
  });

  it("caps summary at 800 chars", () => {
    const tooLong = { ...minimal, summary: "x".repeat(801) };
    expect(() => ScaffoldPlanSchema.parse(tooLong)).toThrow();
  });

  it("requires tailored_content on emit", () => {
    const bad: unknown = {
      ...minimal,
      files: [{ path: "CLAUDE.md", action: "emit", rationale: "x" }],
    };
    expect(() => ScaffoldPlanSchema.parse(bad)).toThrow();
  });

  it("requires tailored_content on merge", () => {
    const bad: unknown = {
      ...minimal,
      files: [{ path: "CLAUDE.md", action: "merge", rationale: "x" }],
    };
    expect(() => ScaffoldPlanSchema.parse(bad)).toThrow();
  });

  it("rejects tailored_content on skip", () => {
    const bad: unknown = {
      ...minimal,
      files: [{ path: "CLAUDE.md", action: "skip", rationale: "x", tailored_content: "y" }],
    };
    expect(() => ScaffoldPlanSchema.parse(bad)).toThrow();
  });

  it("accepts emit + merge + skip in one files[] array", () => {
    const good: ScaffoldPlan = {
      ...minimal,
      files: [
        { path: "CLAUDE.md", action: "emit",  rationale: "no existing CLAUDE.md", tailored_content: "# Title\n" },
        { path: "AGENTS.md", action: "merge", rationale: "existing AGENTS.md found; append",
          tailored_content: "## New section\n" },
        { path: ".agent-review/config.json", action: "skip", rationale: "phase C seeder owns this path" },
      ],
    };
    expect(() => ScaffoldPlanSchema.parse(good)).not.toThrow();
  });

  it("caps per-file tailored_content at 16 KB", () => {
    const bad: unknown = {
      ...minimal,
      files: [{ path: "x.md", action: "emit", rationale: "x", tailored_content: "y".repeat(16_385) }],
    };
    expect(() => ScaffoldPlanSchema.parse(bad)).toThrow();
  });

  it("requires generatedAtIso to be a valid ISO-8601 datetime", () => {
    const bad = { ...minimal, generatedAtIso: "not-a-date" };
    expect(() => ScaffoldPlanSchema.parse(bad)).toThrow();
  });

  it("requires templateRef to match the outer shape grammar", () => {
    expect(() => ScaffoldPlanSchema.parse({ ...minimal, templateRef: "bogus" })).toThrow();
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@",
    })).toThrow();
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "file:///tmp/x@",
    })).toThrow();
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "file:///tmp/x@0000000000000000000000000000000000000000",
    })).not.toThrow();
  });

  it("accepts legitimate git refs the prior regex iterations falsely rejected", () => {
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@" + "a".repeat(40),
    })).not.toThrow();
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@main",
    })).not.toThrow();
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@feature/x",
    })).not.toThrow();
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@v1.0.0",
    })).not.toThrow();
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@123456",
    })).not.toThrow();
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@20260603",
    })).not.toThrow();
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@cafe",
    })).not.toThrow();
  });

  it("rejects short-sha-shaped refs via the .refine() delegate to parseTemplateRef", () => {
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@abc1234",
    })).toThrow(/short sha/i);
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@deadbeef",
    })).toThrow(/short sha/i);
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@" + "a".repeat(39),
    })).toThrow(/short sha/i);
    expect(() => ScaffoldPlanSchema.parse({
      ...minimal, templateRef: "gh:owner/repo@" + "abcdef0123".repeat(2),
    })).toThrow(/short sha/i);
  });

  it("FilePlanSchema is the per-file discriminated union (exported for reuse)", () => {
    const emit: FilePlan = { path: "x", action: "emit", rationale: "y", tailored_content: "z" };
    expect(FilePlanSchema.parse(emit)).toEqual(emit);
  });
});
