// packages/cli/tests/onboard/writers/merge.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMerge, BEGIN_MARKER, END_MARKER } from "../../../src/onboard/writers/merge.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "merge-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("writeMerge — first-run additive append", () => {
  it("appends after the existing content with BEGIN/END markers", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# Existing\nbody line\n");
    const r = await writeMerge(root, {
      path: "CLAUDE.md", action: "merge", rationale: "x",
      tailored_content: "## Added\ndetail\n",
    });
    expect(r.wrote).toBe(true);
    expect(r.skipped).toBe(false);
    const after = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(after).toBe(
      "# Existing\nbody line\n\n" +
      BEGIN_MARKER + "\n" +
      "## Added\ndetail\n" +
      END_MARKER + "\n",
    );
  });

  it("normalizes a missing trailing newline before appending", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# Existing\nbody line"); // no final newline
    await writeMerge(root, {
      path: "CLAUDE.md", action: "merge", rationale: "x", tailored_content: "## Added\n",
    });
    const after = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(after.startsWith("# Existing\nbody line\n")).toBe(true);
    expect(after).toContain(BEGIN_MARKER);
  });

  it("falls back to emit when the target file does not exist", async () => {
    const r = await writeMerge(root, {
      path: "CLAUDE.md", action: "merge", rationale: "x", tailored_content: "# fresh\n",
    });
    expect(r.wrote).toBe(true);
    expect(r.fellBackToEmit).toBe(true);
    const after = await readFile(join(root, "CLAUDE.md"), "utf8");
    // No BEGIN/END markers in the emit path — those only matter for merging.
    expect(after).toBe("# fresh\n");
  });
});

describe("writeMerge — re-run replaces the marker block", () => {
  it("replaces an existing BEGIN/END block with the new tailored_content", async () => {
    const first = "# Existing\nbody\n\n" + BEGIN_MARKER + "\nold content\n" + END_MARKER + "\n";
    await writeFile(join(root, "CLAUDE.md"), first);
    const r = await writeMerge(root, {
      path: "CLAUDE.md", action: "merge", rationale: "x", tailored_content: "new content\n",
    });
    expect(r.wrote).toBe(true);
    const after = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(after).toBe("# Existing\nbody\n\n" + BEGIN_MARKER + "\nnew content\n" + END_MARKER + "\n");
    expect(after).not.toContain("old content");
  });

  it("preserves user edits OUTSIDE the marker block on re-run", async () => {
    const first =
      "# Existing\nbody\n\n" + BEGIN_MARKER + "\nold\n" + END_MARKER + "\n\n## My Hand-edit\nmine\n";
    await writeFile(join(root, "CLAUDE.md"), first);
    await writeMerge(root, {
      path: "CLAUDE.md", action: "merge", rationale: "x", tailored_content: "new\n",
    });
    const after = await readFile(join(root, "CLAUDE.md"), "utf8");
    expect(after).toContain("## My Hand-edit");
    expect(after).toContain("mine");
    expect(after).toContain("new");
    expect(after).not.toContain("old");
  });
});

describe("writeMerge — parse-error skip", () => {
  it("skips merge on a binary target with a stderr warning", async () => {
    await writeFile(join(root, "CLAUDE.md"), Buffer.from([0, 1, 2, 3, 0, 0]));
    const stderr: string[] = [];
    const r = await writeMerge(root, {
      path: "CLAUDE.md", action: "merge", rationale: "x", tailored_content: "y",
    }, { stderr: (s) => stderr.push(s) });
    expect(r.wrote).toBe(false);
    expect(r.skipped).toBe(true);
    expect(stderr.join("")).toMatch(/merge skipped for CLAUDE.md/);
    // File untouched
    const after = await readFile(join(root, "CLAUDE.md"));
    expect(after[0]).toBe(0);
  });

  it("skips merge on a > 128 KB target", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# X\n" + "x\n".repeat(70_000));
    const r = await writeMerge(root, {
      path: "CLAUDE.md", action: "merge", rationale: "x", tailored_content: "y",
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/128|size/);
  });

  it("skips merge on a file with unbalanced fenced code blocks", async () => {
    // Three triple-backtick fences = parser can't pair them.
    await writeFile(join(root, "CLAUDE.md"), "# X\n\n```\ncode\n```\n```\nmore\n");
    const r = await writeMerge(root, {
      path: "CLAUDE.md", action: "merge", rationale: "x", tailored_content: "y",
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/fence|unbalanced|could not parse headings/);
  });

  it("skips merge on a valid markdown file with zero headings (per B-D6 'no headings' branch)", async () => {
    // Balanced fences, no `#` headings — append would yield a structurally
    // surprising file (heading-less prose followed by a marker block).
    await writeFile(join(root, "CLAUDE.md"), "just some prose, no headings.\n\nAnother paragraph.\n");
    const stderr: string[] = [];
    const r = await writeMerge(root, {
      path: "CLAUDE.md", action: "merge", rationale: "x", tailored_content: "y",
    }, { stderr: (s) => stderr.push(s) });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/could not parse headings/);
    expect(stderr.join("")).toMatch(/could not parse headings/);
    // File untouched.
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(
      "just some prose, no headings.\n\nAnother paragraph.\n",
    );
  });

  it("does NOT touch the file when skipped", async () => {
    const original = "# X\n```\nunclosed\n```\n```\n";
    await writeFile(join(root, "CLAUDE.md"), original);
    await writeMerge(root, {
      path: "CLAUDE.md", action: "merge", rationale: "x", tailored_content: "new\n",
    });
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(original);
  });
});

describe("writeMerge — path safety", () => {
  it("refuses to merge to absolute paths", async () => {
    await expect(writeMerge(root, {
      path: "/etc/CLAUDE.md", action: "merge", rationale: "x", tailored_content: "y",
    })).rejects.toThrow(/absolute|outside the target root/);
  });

  it("refuses to merge to traversal paths", async () => {
    await expect(writeMerge(root, {
      path: "../escape.md", action: "merge", rationale: "x", tailored_content: "y",
    })).rejects.toThrow(/traversal|outside the target root/);
  });
});
