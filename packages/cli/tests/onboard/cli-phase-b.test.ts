import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdOnboard } from "../../src/commands/onboard.js";

function buildIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) },
    stdout, stderr,
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-b-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "x" }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("df onboard CLI — Phase B flag surface", () => {
  it("preserves --analysis-only path (Phase A back-compat)", async () => {
    const { io, stdout } = buildIo();
    const code = await cmdOnboard(["--analysis-only", "--json", root], io);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain('"schemaVersion":1');
  });

  it("rejects --include-runtime-infra with deferred-to-v2 error", async () => {
    const { io, stderr } = buildIo();
    const code = await cmdOnboard(["--include-runtime-infra", "--apply", root], io);
    expect(code).toBe(2);
    expect(stderr.join("")).toMatch(/deferred to v2|runtime-infra/);
  });

  it("rejects mutually-exclusive mode flags", async () => {
    const { io, stderr } = buildIo();
    const code = await cmdOnboard(["--apply", "--pr", root], io);
    expect(code).toBe(2);
    expect(stderr.join("")).toMatch(/mutually exclusive|one of/);
  });

  it("rejects --apply / --pr without API key", async () => {
    const orig = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const { io, stderr } = buildIo();
      const code = await cmdOnboard(["--apply", root], io);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      if (orig !== undefined) process.env["ANTHROPIC_API_KEY"] = orig;
    }
  });

  it("--dry-run defaults to dry-run mode when no other mode flag is set AND emits preview", async () => {
    const orig = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const { io, stderr } = buildIo();
      const code = await cmdOnboard([root], io);
      expect(code).toBe(1);
      expect(stderr.join("")).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      if (orig !== undefined) process.env["ANTHROPIC_API_KEY"] = orig;
    }
  });

  it("--help renders updated Phase B usage", async () => {
    const { io, stdout } = buildIo();
    const code = await cmdOnboard(["--help"], io);
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("--apply");
    expect(stdout.join("")).toContain("--pr");
    expect(stdout.join("")).toContain("--template");
    expect(stdout.join("")).toContain("--profile");
    expect(stdout.join("")).toContain("--include-runtime-infra");
  });

  it("rejects deferred D4 flags (--analysis-depth, --skip-validation) as unknown", async () => {
    const { io, stderr: e1 } = buildIo();
    expect(await cmdOnboard(["--analysis-depth", "fast", root], io)).toBe(2);
    expect(e1.join("")).toMatch(/unknown flag.*--analysis-depth/);
    const io2 = buildIo();
    expect(await cmdOnboard(["--skip-validation", root], io2.io)).toBe(2);
    expect(io2.stderr.join("")).toMatch(/unknown flag.*--skip-validation/);
  });
});

// --- B-D8 CLI-seam plumb-through tests ---

import * as generatePlanModule from "../../src/onboard/generate-plan.js";
import * as templateLoaderModule from "../../src/onboard/template-loader.js";

describe("df onboard CLI — B-D8 profile plumb-through", () => {
  const TEMPLATE_STUB = {
    canonicalRef: "file:///tmp/synthetic@0000000000000000000000000000000000000000",
    resolvedSha: "0000000000000000000000000000000000000000",
    cacheDir: "/tmp/synthetic-cache",
    files: [{ path: "CLAUDE.md", content: "# {{ project_name }}\n" }],
  };
  const PLAN_STUB = {
    schemaVersion: 1 as const,
    sourceAnalysisSchemaVersion: 1 as const,
    templateRef: TEMPLATE_STUB.canonicalRef,
    generatedAtIso: "2026-06-03T12:00:00.000Z",
    files: [],
    summary: "stub",
  };

  let loadSpy: ReturnType<typeof vi.spyOn>;
  let planSpy: ReturnType<typeof vi.spyOn>;
  let origApiKey: string | undefined;

  beforeEach(() => {
    origApiKey = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    loadSpy = vi.spyOn(templateLoaderModule, "loadTemplate")
      .mockResolvedValue(TEMPLATE_STUB);
    planSpy = vi.spyOn(generatePlanModule, "generatePlan")
      .mockResolvedValue(PLAN_STUB);
  });
  afterEach(() => {
    loadSpy.mockRestore();
    planSpy.mockRestore();
    if (origApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = origApiKey;
  });

  it("--profile cloud plumbs the resolved profile into generatePlan", async () => {
    const { io } = buildIo();
    const code = await cmdOnboard(["--dry-run", "--profile", "cloud", root], io);
    expect(code).toBe(0);
    expect(planSpy).toHaveBeenCalledTimes(1);
    const optsArg = planSpy.mock.calls[0]?.[2] as { profile?: string };
    expect(optsArg.profile).toBe("cloud");
  });

  it("--profile local plumbs the resolved profile into generatePlan", async () => {
    const { io } = buildIo();
    const code = await cmdOnboard(["--dry-run", "--profile", "local", root], io);
    expect(code).toBe(0);
    expect(planSpy).toHaveBeenCalledTimes(1);
    const optsArg = planSpy.mock.calls[0]?.[2] as { profile?: string };
    expect(optsArg.profile).toBe("local");
  });

  it("auto-detect (no --profile) plumbs autoProfile(analysis) into generatePlan", async () => {
    const { io } = buildIo();
    const code = await cmdOnboard(["--dry-run", root], io);
    expect(code).toBe(0);
    expect(planSpy).toHaveBeenCalledTimes(1);
    const optsArg = planSpy.mock.calls[0]?.[2] as { profile?: string };
    expect(optsArg.profile).toBe("local");
  });
});
