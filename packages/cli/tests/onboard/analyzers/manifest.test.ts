// packages/cli/tests/onboard/analyzers/manifest.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestAnalyzer } from "../../../src/onboard/analyzers/manifest.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "manifest-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("manifestAnalyzer", () => {
  it("returns null when no manifests are present", async () => {
    const r = await manifestAnalyzer.detect(root);
    expect(r).toBeNull();
  });

  it("detects a Node package from package.json + engines.node", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "x", engines: { node: ">=20" } }));
    const r = await manifestAnalyzer.detect(root);
    expect(r?.stacks).toEqual([{ language: "typescript", versionPin: ">=20", manifestPath: "package.json" }]);
  });

  it("falls back to .nvmrc for Node version", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "x" }));
    await writeFile(join(root, ".nvmrc"), "20.10.0\n");
    const r = await manifestAnalyzer.detect(root);
    expect(r?.stacks[0]?.versionPin).toBe("20.10.0");
  });

  it("detects Python from pyproject.toml + requires-python", async () => {
    await writeFile(join(root, "pyproject.toml"),
      `[project]\nname = "x"\nrequires-python = ">=3.12"\n`);
    const r = await manifestAnalyzer.detect(root);
    expect(r?.stacks).toContainEqual({
      language: "python", versionPin: ">=3.12", manifestPath: "pyproject.toml",
    });
  });

  it("detects go from go.mod", async () => {
    await writeFile(join(root, "go.mod"), `module x\n\ngo 1.22\n`);
    const r = await manifestAnalyzer.detect(root);
    expect(r?.stacks).toContainEqual({
      language: "go", versionPin: "1.22", manifestPath: "go.mod",
    });
  });

  it("detects multiple stacks in a polyglot repo", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "x" }));
    await writeFile(join(root, "go.mod"), `module x\n\ngo 1.22\n`);
    const r = await manifestAnalyzer.detect(root);
    expect(r?.stacks).toHaveLength(2);
  });

  it("treats Dockerfile-only as 'other' stack", async () => {
    await writeFile(join(root, "Dockerfile"), `FROM alpine:3.20\n`);
    const r = await manifestAnalyzer.detect(root);
    expect(r?.stacks).toContainEqual({
      language: "other", versionPin: "alpine:3.20", manifestPath: "Dockerfile",
    });
  });

  it("detects multi-runtime pins from .tool-versions", async () => {
    await writeFile(join(root, ".tool-versions"),
      "nodejs 22.11.0\npython 3.12.5\ngolang 1.22.0\nrust 1.80.0\n");
    const r = await manifestAnalyzer.detect(root);
    expect(r?.stacks).toEqual(expect.arrayContaining([
      expect.objectContaining({ language: "typescript", versionPin: "22.11.0", manifestPath: ".tool-versions" }),
      expect.objectContaining({ language: "python", versionPin: "3.12.5", manifestPath: ".tool-versions" }),
      expect.objectContaining({ language: "go", versionPin: "1.22.0", manifestPath: ".tool-versions" }),
      expect.objectContaining({ language: "rust", versionPin: "1.80.0", manifestPath: ".tool-versions" }),
    ]));
  });

  it(".tool-versions overrides version pin when same language has a primary manifest", async () => {
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "x", engines: { node: ">=20" } }));
    await writeFile(join(root, ".tool-versions"), "nodejs 22.11.0\n");
    const r = await manifestAnalyzer.detect(root);
    // De-duped to one TS entry; manifestPath stays package.json; versionPin comes from .tool-versions.
    const ts = (r?.stacks ?? []).filter((s) => s.language === "typescript");
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ language: "typescript", versionPin: "22.11.0", manifestPath: "package.json" });
  });
});
