// Loader-side tests ONLY. parseTemplateRef tests live in template-ref.test.ts
// (Task 1) — round-4 restructure-completion: the parser is in template-ref.ts
// (a co-located Task 1 foundation file imported by both the schema and the
// loader); the loader file owns ONLY the loadTemplate logic.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTemplate } from "../../src/onboard/template-loader.js";

let srcRoot: string;
let cacheRoot: string;
beforeEach(async () => {
  srcRoot = await mkdtemp(join(tmpdir(), "tmpl-src-"));
  cacheRoot = await mkdtemp(join(tmpdir(), "tmpl-cache-"));
});
afterEach(async () => {
  await rm(srcRoot, { recursive: true, force: true });
  await rm(cacheRoot, { recursive: true, force: true });
});

describe("loadTemplate (file://)", () => {
  it("loads files from a file:// template into the cache", async () => {
    await writeFile(join(srcRoot, "CLAUDE.md"), "# CLAUDE\n");
    await mkdir(join(srcRoot, "docs"));
    await writeFile(join(srcRoot, "docs", "PRINCIPLES.md"), "# Principles\n");
    const t = await loadTemplate(
      `file://${srcRoot}@0000000000000000000000000000000000000000`,
      { cacheRoot },
    );
    expect(t.resolvedSha).toBe("0000000000000000000000000000000000000000");
    expect(t.canonicalRef).toBe(
      `file://${srcRoot}@0000000000000000000000000000000000000000`,
    );
    expect(t.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "CLAUDE.md", content: "# CLAUDE\n" }),
      expect.objectContaining({ path: "docs/PRINCIPLES.md", content: "# Principles\n" }),
    ]));
  });

  it("skips .git, node_modules, dist, build", async () => {
    await mkdir(join(srcRoot, ".git"));
    await writeFile(join(srcRoot, ".git", "config"), "x");
    await mkdir(join(srcRoot, "node_modules"));
    await writeFile(join(srcRoot, "node_modules", "foo.js"), "y");
    await writeFile(join(srcRoot, "real.md"), "# real\n");
    const t = await loadTemplate(
      `file://${srcRoot}@0000000000000000000000000000000000000000`,
      { cacheRoot },
    );
    const paths = t.files.map((f) => f.path);
    expect(paths).toContain("real.md");
    expect(paths.find((p) => p.startsWith(".git/"))).toBeUndefined();
    expect(paths.find((p) => p.startsWith("node_modules/"))).toBeUndefined();
  });

  it("skips files larger than 64 KB", async () => {
    await writeFile(join(srcRoot, "huge.md"), "x".repeat(65_537));
    await writeFile(join(srcRoot, "small.md"), "ok\n");
    const t = await loadTemplate(
      `file://${srcRoot}@0000000000000000000000000000000000000000`,
      { cacheRoot },
    );
    const paths = t.files.map((f) => f.path);
    expect(paths).toContain("small.md");
    expect(paths).not.toContain("huge.md");
  });

  it("skips binary files (null-byte heuristic)", async () => {
    const binary = Buffer.from([0, 1, 2, 3, 0, 0, 0, 0]);
    await writeFile(join(srcRoot, "img.png"), binary);
    await writeFile(join(srcRoot, "text.md"), "ok\n");
    const t = await loadTemplate(
      `file://${srcRoot}@0000000000000000000000000000000000000000`,
      { cacheRoot },
    );
    const paths = t.files.map((f) => f.path);
    expect(paths).toContain("text.md");
    expect(paths).not.toContain("img.png");
  });

  it("rejects when the total entry count would exceed 200", async () => {
    for (let i = 0; i < 201; i++) {
      await writeFile(join(srcRoot, `f-${i}.md`), "x");
    }
    await expect(loadTemplate(
      `file://${srcRoot}@0000000000000000000000000000000000000000`,
      { cacheRoot },
    )).rejects.toThrow(/200/);
  });

  it("hits the cache on second load (same sha)", async () => {
    await writeFile(join(srcRoot, "one.md"), "first");
    const t1 = await loadTemplate(
      `file://${srcRoot}@1111111111111111111111111111111111111111`,
      { cacheRoot },
    );
    await writeFile(join(srcRoot, "one.md"), "second");
    const t2 = await loadTemplate(
      `file://${srcRoot}@1111111111111111111111111111111111111111`,
      { cacheRoot },
    );
    expect(t1.files.find((f) => f.path === "one.md")?.content).toBe("first");
    expect(t2.files.find((f) => f.path === "one.md")?.content).toBe("first");
  });
});
