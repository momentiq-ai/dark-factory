// packages/cli/tests/onboard/analyzers/tree.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeAnalyzer } from "../../../src/onboard/analyzers/tree.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "tree-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("treeAnalyzer", () => {
  it("classifies services/ as services category and discovers children", async () => {
    await mkdir(join(root, "services", "worker"), { recursive: true });
    await writeFile(join(root, "services", "worker", "index.ts"), "");
    const r = await treeAnalyzer.detect(root);
    expect(r?.tree?.topLevelDirs).toContainEqual(
      expect.objectContaining({ name: "services", category: "services" }),
    );
    expect(r?.services).toContainEqual(
      expect.objectContaining({ name: "worker", path: "services/worker" }),
    );
  });

  it("buckets file extensions", async () => {
    await writeFile(join(root, "a.ts"), "");
    await writeFile(join(root, "b.py"), "");
    const r = await treeAnalyzer.detect(root);
    expect(r?.tree?.languageBreakdown).toMatchObject({ typescript: 1, python: 1 });
  });

  it("identifies test directories", async () => {
    await mkdir(join(root, "tests"), { recursive: true });
    await mkdir(join(root, "src", "__tests__"), { recursive: true });
    const r = await treeAnalyzer.detect(root);
    expect(r?.tree?.testDirs).toEqual(expect.arrayContaining(["tests", "src/__tests__"]));
  });
});
