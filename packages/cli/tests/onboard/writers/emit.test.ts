// packages/cli/tests/onboard/writers/emit.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEmit } from "../../../src/onboard/writers/emit.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "emit-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("writeEmit", () => {
  it("writes a new file with the tailored content", async () => {
    await writeEmit(root, {
      path: "CLAUDE.md", action: "emit", rationale: "x", tailored_content: "# hi\n",
    });
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("# hi\n");
  });

  it("creates parent directories as needed", async () => {
    await writeEmit(root, {
      path: "docs/ADR/2026-01.md", action: "emit", rationale: "x", tailored_content: "y",
    });
    expect((await stat(join(root, "docs/ADR/2026-01.md"))).isFile()).toBe(true);
  });

  it("refuses to overwrite an existing file when force=false", async () => {
    await writeFile(join(root, "CLAUDE.md"), "existing\n");
    await expect(writeEmit(root, {
      path: "CLAUDE.md", action: "emit", rationale: "x", tailored_content: "new\n",
    })).rejects.toThrow(/refuses to overwrite|already exists/);
  });

  it("overwrites an existing file when force=true", async () => {
    await writeFile(join(root, "CLAUDE.md"), "existing\n");
    await writeEmit(root, {
      path: "CLAUDE.md", action: "emit", rationale: "x", tailored_content: "new\n",
    }, { force: true });
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("new\n");
  });

  it("refuses to write outside the root (path traversal)", async () => {
    await expect(writeEmit(root, {
      path: "../escape.md", action: "emit", rationale: "x", tailored_content: "y",
    })).rejects.toThrow(/path traversal|outside the target root/);
  });

  it("refuses absolute paths", async () => {
    await expect(writeEmit(root, {
      path: "/etc/passwd", action: "emit", rationale: "x", tailored_content: "y",
    })).rejects.toThrow(/absolute|outside the target root/);
  });
});
