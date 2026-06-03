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
});
