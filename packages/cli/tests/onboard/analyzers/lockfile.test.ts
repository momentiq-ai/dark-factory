import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockfileAnalyzer } from "../../../src/onboard/analyzers/lockfile.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "lockfile-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const PKG_LOCK = (deps: Record<string, string>, dev: Record<string, string> = {}) => JSON.stringify({
  name: "x", version: "0.0.0", lockfileVersion: 3,
  packages: {
    "": { name: "x", version: "0.0.0", dependencies: deps, devDependencies: dev },
    ...Object.fromEntries(Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, { version: v }])),
    ...Object.fromEntries(Object.entries(dev).map(([k, v]) => [`node_modules/${k}`, { version: v }])),
  },
});

describe("lockfileAnalyzer", () => {
  it("returns null when no lockfiles are present", async () => {
    expect(await lockfileAnalyzer.detect(root)).toBeNull();
  });

  it("returns null when only package.json exists (no lockfile)", async () => {
    // package.json alone is the manifest analyzer's job. Lockfile analyzer requires a real lockfile
    // so dep versions are the PINNED values, not the requested ranges.
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "x", devDependencies: { vitest: "^2.0.0" },
    }));
    expect(await lockfileAnalyzer.detect(root)).toBeNull();
  });

  it("extracts top-N direct deps with EXACT versions from package-lock.json", async () => {
    await writeFile(join(root, "package-lock.json"),
      PKG_LOCK({ react: "18.3.1", express: "4.21.0" }, { vitest: "2.1.0" }));
    const r = await lockfileAnalyzer.detect(root);
    expect(r?.dependencies).toEqual(expect.arrayContaining([
      { name: "react", version: "18.3.1", manifestPath: "package-lock.json" },
      { name: "express", version: "4.21.0", manifestPath: "package-lock.json" },
      { name: "vitest", version: "2.1.0", manifestPath: "package-lock.json" },
    ]));
    // No ranges (e.g. "^2.0.0") in version field — pinned values only.
    for (const d of r?.dependencies ?? []) {
      expect(d.version).not.toMatch(/^[\^~]/);
    }
  });

  it("caps dependencies at 20 entries", async () => {
    const deps: Record<string, string> = {};
    for (let i = 0; i < 30; i++) deps[`pkg-${i}`] = `${i}.0.0`;
    await writeFile(join(root, "package-lock.json"), PKG_LOCK(deps));
    const r = await lockfileAnalyzer.detect(root);
    expect(r?.dependencies?.length).toBe(20);
  });

  it("surfaces 'test-framework' decision when vitest appears in the lockfile", async () => {
    await writeFile(join(root, "package-lock.json"), PKG_LOCK({}, { vitest: "2.1.0" }));
    const r = await lockfileAnalyzer.detect(root);
    expect(r?.decisions).toContainEqual(expect.objectContaining({
      surface: "test-framework",
      evidence: ["package-lock.json"],
    }));
  });

  it("surfaces 'deploy-target' decision when @kubernetes/client-node is a direct dep", async () => {
    await writeFile(join(root, "package-lock.json"),
      PKG_LOCK({ "@kubernetes/client-node": "1.0.0" }));
    const r = await lockfileAnalyzer.detect(root);
    expect(r?.decisions).toContainEqual(expect.objectContaining({ surface: "deploy-target" }));
  });

  it("parses go.sum direct deps", async () => {
    await writeFile(join(root, "go.mod"), `module x\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n`);
    await writeFile(join(root, "go.sum"),
      `github.com/gin-gonic/gin v1.10.0 h1:abc=\ngithub.com/gin-gonic/gin v1.10.0/go.mod h1:def=\n`);
    const r = await lockfileAnalyzer.detect(root);
    expect(r?.dependencies).toContainEqual({
      name: "github.com/gin-gonic/gin", version: "v1.10.0", manifestPath: "go.sum",
    });
  });

  // --- #137: multi-root aggregation across nested lockfiles --------------
  //
  // The fix replaces single-lockfile precedence with a bounded depth-3 walk
  // that aggregates dependencies + decisions across EVERY discovered
  // lockfile, deduping decisions on `(title, surface)` with evidence
  // accumulated as the sorted union of source lockfile paths.

  it("regression: single-root behavior is preserved when only a root lockfile exists", async () => {
    // Existing behavior guard — the simple sage-blueprint case.
    await writeFile(join(root, "package-lock.json"),
      PKG_LOCK({ react: "18.3.1" }, { vitest: "2.1.0" }));
    const r = await lockfileAnalyzer.detect(root);
    expect(r?.dependencies).toContainEqual(
      { name: "react", version: "18.3.1", manifestPath: "package-lock.json" },
    );
    expect(r?.decisions).toContainEqual({
      title: "Frontend stack: React",
      surface: "stack",
      evidence: ["package-lock.json"],
    });
  });

  it("walks subdirs (≤ depth 3) and aggregates decisions from every lockfile in a monorepo", async () => {
    // sage3c-shape monorepo: root lockfile has no decision-relevant deps;
    // the real frontend signals are in `web/` and backend signals are in
    // `backend/`. The pre-fix single-root chooser returned 0 decisions
    // here, breaking the ADR seeder (#137).
    await writeFile(join(root, "package-lock.json"),
      PKG_LOCK({ "tiny-helper": "1.0.0" }));
    await mkdir(join(root, "web"));
    await writeFile(join(root, "web", "package-lock.json"),
      PKG_LOCK({ next: "15.0.0", react: "18.3.1" }, { vitest: "2.1.0" }));
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend", "poetry.lock"),
      `[[package]]\nname = "fastapi"\nversion = "0.115.0"\ndescription = ""\n` +
      `[[package]]\nname = "pytest"\nversion = "8.0.0"\ndescription = ""\n`);

    const r = await lockfileAnalyzer.detect(root);
    const surfaceTitles = (r?.decisions ?? []).map((d) => `${d.surface}:${d.title}`);
    expect(surfaceTitles).toEqual(expect.arrayContaining([
      "stack:Frontend stack: Next.js",
      "stack:Frontend stack: React",
      "test-framework:Repo uses Vitest as test framework",
      "stack:Backend framework: FastAPI",
      "test-framework:Repo uses Pytest as test framework",
    ]));

    // manifestPath uses forward-slash repo-relative paths (no leading "./").
    expect(r?.decisions).toContainEqual({
      title: "Frontend stack: Next.js",
      surface: "stack",
      evidence: ["web/package-lock.json"],
    });
    expect(r?.decisions).toContainEqual({
      title: "Backend framework: FastAPI",
      surface: "stack",
      evidence: ["backend/poetry.lock"],
    });

    // Dependencies preserve subdir provenance too.
    expect(r?.dependencies).toContainEqual(
      { name: "fastapi", version: "0.115.0", manifestPath: "backend/poetry.lock" },
    );
  });

  it("dedupes a decision surfaced by two lockfiles, unioning evidence", async () => {
    // Two sibling Next.js apps in a monorepo: both lockfiles contribute the
    // same `(title, surface)` decision; we want ONE entry with BOTH
    // lockfile paths in `evidence[]`, sorted.
    await mkdir(join(root, "apps"));
    await mkdir(join(root, "apps", "marketing"));
    await mkdir(join(root, "apps", "dashboard"));
    await writeFile(join(root, "apps", "marketing", "package-lock.json"),
      PKG_LOCK({ next: "15.0.0" }));
    await writeFile(join(root, "apps", "dashboard", "package-lock.json"),
      PKG_LOCK({ next: "15.0.0" }));

    const r = await lockfileAnalyzer.detect(root);
    const nextDecisions = (r?.decisions ?? []).filter(
      (d) => d.title === "Frontend stack: Next.js",
    );
    expect(nextDecisions).toHaveLength(1);
    expect(nextDecisions[0]?.evidence).toEqual([
      "apps/dashboard/package-lock.json",
      "apps/marketing/package-lock.json",
    ]);
  });

  it("never exceeds the 20-dependency aggregate cap across lockfiles", async () => {
    // Two lockfiles, each with > 20 direct deps. The aggregate result must
    // be ≤ 20 (the schema's hard contract — exceeding throws inside
    // `RepoAnalysisSchema.parse()`).
    const many = (prefix: string): Record<string, string> => {
      const d: Record<string, string> = {};
      for (let i = 0; i < 30; i++) d[`${prefix}-${i}`] = `${i}.0.0`;
      return d;
    };
    await writeFile(join(root, "package-lock.json"), PKG_LOCK(many("root")));
    await mkdir(join(root, "web"));
    await writeFile(join(root, "web", "package-lock.json"), PKG_LOCK(many("web")));
    const r = await lockfileAnalyzer.detect(root);
    expect(r?.dependencies?.length).toBeLessThanOrEqual(20);
  });

  it("skips node_modules and other build-artifact subtrees during the walk", async () => {
    // A nested lockfile inside `node_modules/` is a transitive-dep lockfile,
    // NOT a real signal — the walk must skip it.
    await writeFile(join(root, "package-lock.json"),
      PKG_LOCK({}, { vitest: "2.1.0" }));
    await mkdir(join(root, "node_modules"));
    await mkdir(join(root, "node_modules", "some-pkg"));
    await writeFile(join(root, "node_modules", "some-pkg", "package-lock.json"),
      PKG_LOCK({ next: "15.0.0" }));
    const r = await lockfileAnalyzer.detect(root);
    // Only the root lockfile's signal should be present.
    const titles = (r?.decisions ?? []).map((d) => d.title);
    expect(titles).toContain("Repo uses Vitest as test framework");
    expect(titles).not.toContain("Frontend stack: Next.js");
  });
});
