// packages/cli/tests/onboard/cmd-onboard-integration.test.ts
//
// Task 4.5b integration test for the new `cmdOnboard(opts)` orchestrator.
//
// ESM MOCKING DOCTRINE:
//
// 1. Use top-of-file `vi.mock(modulePath, factory)` — these calls are
//    HOISTED above all `import` statements at compile time. `vi.spyOn` does
//    NOT intercept statically-imported ESM bindings; `vi.doMock` runs at
//    runtime AFTER imports have already been resolved → both flavors miss
//    the real call site. Top-of-file `vi.mock` is the only pattern that
//    works.
// 2. Use PARTIAL-MOCK factories (`...actual, fn: vi.fn(actual.fn)`) so
//    other exports from the same module (e.g. `ALL_SEEDERS_DEFAULT` next to
//    `runSeeders`) stay real for tests that don't override them.
// 3. CLOSURE TRAP: mock factories run ONCE per file at hoist time, BEFORE
//    any `beforeEach`. Mocks MUST NOT close over `beforeEach`-scoped
//    variables (e.g. `root`) — those variables are `undefined` when the
//    factory runs, and the FIRST `beforeEach` mutation is then captured by
//    all later tests. Per-test overrides MUST read from CALL ARGS via
//    `mockImplementationOnce(...)`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Phase B's generatePlan is a real LLM call; the top-of-file `vi.mock`
// keeps the integration test offline + deterministic. Per the cross-phase
// contract (Task 3.6), Phase B does NOT emit `.agent-review/config.json`
// — that's Phase C's seeder's job. The mock honors that contract.
vi.mock("../../src/onboard/generate-plan.js", () => ({
  generatePlan: vi.fn(async () => ({
    schemaVersion: 1,
    sourceAnalysisSchemaVersion: 1,
    templateRef: "gh:momentiq-ai/sage-blueprint@0000000000000000000000000000000000000000",
    generatedAtIso: new Date("2026-06-03T00:00:00Z").toISOString(),
    files: [
      {
        path: "CLAUDE.md",
        action: "emit",
        rationale: "LLM-tailored CLAUDE.md for the integration test fixture",
        tailored_content: "# CLAUDE.md\n\n## Stack\n\n- TypeScript\n\n## Services\n\n- api\n",
      },
    ],
    summary: "Mock LLM scaffold for integration test",
  })),
}));

// Phase C seeders: partial mock keeps `ALL_SEEDERS_DEFAULT` real for the
// default-path tests; the dedupe test overrides `runSeeders` per-call.
vi.mock("../../src/onboard/seeders/index.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/onboard/seeders/index.js")>();
  return { ...actual, runSeeders: vi.fn(actual.runSeeders) };
});

// autoProfile runs against a partial-shaped analysis derived from a fresh
// tmpdir — hard-pin to "local" so the agent-review-config seeder's emit
// shape is reproducible.
vi.mock("../../src/onboard/auto-profile.js", () => ({
  autoProfile: vi.fn(() => "local"),
}));

// Template loader: avoid network — return a synthetic template object.
vi.mock("../../src/onboard/template-loader.js", () => ({
  loadTemplate: vi.fn(async () => ({
    canonicalRef: "file:///tmp/synthetic@0000000000000000000000000000000000000000",
    resolvedSha: "0000000000000000000000000000000000000000",
    cacheDir: "/tmp/synthetic-cache",
    files: [{ path: "CLAUDE.md", content: "# {{ project_name }}\n" }],
  })),
}));

import { cmdOnboard, type CmdOnboardPlanResult } from "../../src/commands/onboard.js";
import { runSeeders } from "../../src/onboard/seeders/index.js";

const runSeedersMock = vi.mocked(runSeeders);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cmd-onboard-int-"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "owner/repo",
    devDependencies: { vitest: "^2.1.0" },
  }));
  await mkdir(join(root, "services", "api"), { recursive: true });
  await writeFile(join(root, "services", "api", "index.ts"), "");
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await writeFile(
    join(root, ".github", "workflows", "release.yml"),
    "name: Release\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: helm upgrade myapp ./chart\n",
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  // `mockClear()` only resets call history; the partial-mock factory's
  // `vi.fn(actual.runSeeders)` default implementation stays installed.
  // `mockReset()` would DESTROY that default — subsequent tests would see
  // `runSeeders` return `undefined` and fail.
  runSeedersMock.mockClear();
});

describe("cmdOnboard integration — merged ScaffoldPlan from Phase B + Phase C", () => {
  it("--dry-run --json emits a ScaffoldPlan whose files[] contains BOTH the Phase B CLAUDE.md AND Phase C seeder entries", async () => {
    const out = (await cmdOnboard({ target: root, mode: "dry-run", json: true })) as CmdOnboardPlanResult;
    expect(out.analysis).toBeDefined();
    expect(out.plan).toBeDefined();

    const paths = out.plan.files.map((f) => f.path);

    // Phase B contribution: CLAUDE.md (from the mocked LLM scaffold).
    expect(paths).toContain("CLAUDE.md");

    // Phase C contribution: at least the agent-review config (Task 3.6,
    // produces Task 5 metric 5). The other seeders (ADR, cycle1-bootstrap,
    // runbook) emit conditionally based on analysis shape — assert at
    // least one Phase C entry, with `.agent-review/config.json` always
    // present because the seeder is unconditional.
    expect(paths).toContain(".agent-review/config.json");
  });

  it("dedupes on path: Phase B's entry wins when both phases emit the same path", async () => {
    // Force a path collision: override runSeeders per-call to return a
    // seeder output that emits CLAUDE.md with deliberately-different
    // content. The default seeders (adr / cycle1 / runbook /
    // agent-review-config) NEVER emit CLAUDE.md, so the only way to
    // verify the collision-resolution path is to override per-call.
    runSeedersMock.mockResolvedValueOnce([
      {
        path: "CLAUDE.md",
        action: "emit",
        rationale: "Phase C deliberately-different stub to test dedupe collision",
        tailored_content: "# Phase-C-stub-that-MUST-LOSE-to-Phase-B\n",
      },
    ]);
    const out = (await cmdOnboard({ target: root, mode: "dry-run", json: true })) as CmdOnboardPlanResult;
    const claudeEntries = out.plan.files.filter((f) => f.path === "CLAUDE.md");
    expect(claudeEntries).toHaveLength(1);
    const entry = claudeEntries[0]!;
    if (entry.action !== "emit") throw new Error("expected emit action");
    // Phase B's mock body — proves the Phase B (LLM) entry won the collision.
    expect(entry.tailored_content).toContain("## Stack");
    expect(entry.tailored_content).toContain("TypeScript");
    // Phase C's deliberately-different stub MUST NOT appear in the merged plan.
    expect(entry.tailored_content).not.toContain("MUST-LOSE");
  });

  it("returns a Zod-validated merged ScaffoldPlan (schema parse at the merge boundary)", async () => {
    const out = (await cmdOnboard({ target: root, mode: "dry-run", json: true })) as CmdOnboardPlanResult;
    expect(out.plan.schemaVersion).toBe(1);
    expect(out.plan.sourceAnalysisSchemaVersion).toBe(1);
    expect(typeof out.plan.templateRef).toBe("string");
    expect(typeof out.plan.generatedAtIso).toBe("string");
    expect(typeof out.plan.summary).toBe("string");
    expect(out.plan.files.length).toBeGreaterThan(1);
    expect(out.plan.files.length).toBeLessThanOrEqual(100);
  });

  it("analysis-only mode returns { analysis } only — skips Phase B + Phase C", async () => {
    const out = (await cmdOnboard({ target: root, mode: "analysis-only" })) as { analysis: { schemaVersion: number } };
    expect(out.analysis).toBeDefined();
    expect(out.analysis.schemaVersion).toBe(1);
    expect("plan" in out).toBe(false);
  });
});
