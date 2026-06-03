// packages/cli/tests/onboard/analyzers/git.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitAnalyzer } from "../../../src/onboard/analyzers/git.js";

const ex = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "git-"));
  await ex("git", ["init", "-b", "main"], { cwd: root });
  await ex("git", ["config", "user.email", "test@x"], { cwd: root });
  await ex("git", ["config", "user.name", "Test"], { cwd: root });
  await ex("git", ["commit", "--allow-empty", "-m", "feat: add thing"], { cwd: root });
  await ex("git", ["commit", "--allow-empty", "-m", "fix: bad bug"], { cwd: root });
  await ex("git", ["commit", "--allow-empty", "-m", "docs: readme — Cycle 15"], { cwd: root });
  await ex("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("gitAnalyzer", () => {
  it("returns null when not a git repo", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "nogit-"));
    expect(await gitAnalyzer.detect(tmp)).toBeNull();
    await rm(tmp, { recursive: true });
  });

  it("parses owner/repo from origin remote", async () => {
    const r = await gitAnalyzer.detect(root);
    expect(r?.canonicalName).toBe("owner/repo");
  });

  it("detects conventional commits", async () => {
    const r = await gitAnalyzer.detect(root);
    expect(r?.git?.recentCommitConventions?.conventional).toBe(true);
  });

  it("detects cycle-referenced commits", async () => {
    const r = await gitAnalyzer.detect(root);
    expect(r?.git?.recentCommitConventions?.cycleReferenced).toBe(true);
  });
});
