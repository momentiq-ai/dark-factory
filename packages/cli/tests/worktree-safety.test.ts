// Tests for dark-factory#227 worktree-corruption safety:
//   - ensureGcAutoDisabled (prevention — disables auto-gc so the prune race
//     can't corrupt a linked worktree's index)
//   - recoverCacheTree (recovery — `git read-tree HEAD` rebuilds a corrupt
//     index from HEAD)
//
// Real temp git repos (the corruption is a git-object-store fact, not mockable).

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureGcAutoDisabled, recoverCacheTree } from "../src/worktree-safety.js";
import { probeCacheTree } from "../src/doctor.js";

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  const r = git(dir, ["commit", "-q", "-m", message]);
  if (r.status !== 0) throw new Error(`commit failed: ${r.stderr}`);
}

// Read the LOCAL-scope gc.auto only, so assertions don't pick up an ambient
// global/system gc.auto (this machine and CI may set one). The helper itself
// reads ALL scopes on purpose — if auto-gc is already off globally there's
// nothing to fix — so each test sets an explicit local precondition.
function gcAutoLocal(dir: string): string {
  return git(dir, ["config", "--local", "--get", "gc.auto"]).stdout.trim();
}

describe("ensureGcAutoDisabled (#227 prevention)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-gcauto-"));
    initRepo(dir);
    writeFileSync(join(dir, "x.txt"), "one\n");
    commitAll(dir, "initial");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env["DF_KEEP_GC_AUTO"];
  });

  it("flips gc.auto to 0 when auto-gc is enabled, and logs once", async () => {
    git(dir, ["config", "gc.auto", "6700"]); // simulate auto-gc enabled
    const logs: string[] = [];
    const res = await ensureGcAutoDisabled(dir, (m) => logs.push(m));
    expect(res.flipped).toBe(true);
    expect(gcAutoLocal(dir)).toBe("0");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/gc\.auto=0/);
    expect(logs[0]).toMatch(/#227/);
  });

  it("is idempotent: a second call is a silent no-op", async () => {
    git(dir, ["config", "gc.auto", "6700"]);
    await ensureGcAutoDisabled(dir, () => {});
    const logs: string[] = [];
    const res = await ensureGcAutoDisabled(dir, (m) => logs.push(m));
    expect(res.flipped).toBe(false);
    expect(gcAutoLocal(dir)).toBe("0");
    expect(logs).toHaveLength(0); // no log when already disabled
  });

  it("no-op when gc.auto already resolves to 0 (does not log or rewrite)", async () => {
    git(dir, ["config", "gc.auto", "0"]);
    const logs: string[] = [];
    const res = await ensureGcAutoDisabled(dir, (m) => logs.push(m));
    expect(res.flipped).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it("respects the DF_KEEP_GC_AUTO=1 opt-out (leaves config untouched)", async () => {
    git(dir, ["config", "gc.auto", "6700"]);
    process.env["DF_KEEP_GC_AUTO"] = "1";
    const logs: string[] = [];
    const res = await ensureGcAutoDisabled(dir, (m) => logs.push(m));
    expect(res.flipped).toBe(false);
    expect(gcAutoLocal(dir)).toBe("6700"); // untouched — opt-out short-circuits
    expect(logs).toHaveLength(0);
  });

  it("is best-effort: a non-repo directory does not throw", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "df-nonrepo-"));
    try {
      const res = await ensureGcAutoDisabled(nonRepo, () => {});
      expect(res.flipped).toBe(false); // git config write failed → swallowed
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("recoverCacheTree (#227 recovery)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-recover-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recovers a corrupt cache-tree so the probe passes afterward", async () => {
    // Build the exact corruption probeCacheTree detects: the index cache-tree
    // references a staged subtree object that's been removed from the store.
    initRepo(dir);
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "file.txt"), "one\n");
    commitAll(dir, "initial");
    writeFileSync(join(dir, "a", "file.txt"), "modified\n");
    git(dir, ["add", "a/file.txt"]);
    const rootTree = git(dir, ["write-tree"]).stdout.trim();
    const aTree = git(dir, ["ls-tree", rootTree, "a"]).stdout.trim().split(/\s+/)[2];
    expect(aTree).toMatch(/^[0-9a-f]{40}$/);
    unlinkSync(join(dir, ".git", "objects", aTree!.slice(0, 2), aTree!.slice(2)));

    // Precondition: the probe sees the corruption.
    const before = await probeCacheTree(dir);
    expect(before.passed).toBe(false);

    const rec = await recoverCacheTree(dir);
    expect(rec.ok).toBe(true);
    expect(rec.detail).toMatch(/read-tree HEAD/);

    // Postcondition: the probe is clean.
    const after = await probeCacheTree(dir);
    expect(after.passed).toBe(true);
  });

  it("reports failure (with the worktree-remove fallback) when HEAD's tree is gone", async () => {
    initRepo(dir);
    writeFileSync(join(dir, "x.txt"), "one\n");
    commitAll(dir, "initial");
    // Remove HEAD's own root tree object → `git read-tree HEAD` cannot read it.
    const headTree = git(dir, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    expect(headTree).toMatch(/^[0-9a-f]{40}$/);
    unlinkSync(join(dir, ".git", "objects", headTree.slice(0, 2), headTree.slice(2)));

    const rec = await recoverCacheTree(dir);
    expect(rec.ok).toBe(false);
    expect(rec.detail).toMatch(/git worktree remove --force/);
  });
});
