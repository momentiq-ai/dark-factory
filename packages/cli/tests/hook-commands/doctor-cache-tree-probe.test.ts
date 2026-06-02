// Issue #107 — `probeCacheTree` detects the cache-tree corruption shape
// observed in `dark-factory-platform#170`: the index's cache-tree
// references a tree (or blob) that doesn't exist in `.git/objects/`,
// which is what a killed-mid-write `git commit` leaves the worktree in.
//
// The probe runs `git fsck` and matches stderr against the literal
// substring `invalid sha1 pointer in cache-tree of`. Tests cover:
//   1. Clean repo — probe passes.
//   2. Cache-tree references missing tree — probe reports corrupted +
//      includes the recovery suggestion (`git read-tree HEAD`).
//   3. Adjacent bad-repo states (broken HEAD ref, missing blob NOT in
//      cache-tree, dangling blob) do NOT trip the probe.
//   4. Non-git directory — probe returns a check that flags the
//      condition without throwing.

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { probeCacheTree } from "../../src/doctor.js";

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
  if (r.status !== 0) {
    throw new Error(`commit failed: ${r.stderr}`);
  }
}

describe("probeCacheTree — clean repo", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-probe-clean-"));
    initRepo(dir);
    writeFileSync(join(dir, "x.txt"), "one\n");
    commitAll(dir, "initial");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns passed=true on a healthy repo", () => {
    const check = probeCacheTree(dir);
    expect(check.name).toBe("cache_tree_probe");
    expect(check.passed).toBe(true);
  });
});

describe("probeCacheTree — cache-tree references missing tree", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-probe-corrupt-"));
    initRepo(dir);
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "file.txt"), "one\n");
    commitAll(dir, "initial");

    // Stage a modification and force cache-tree population.
    writeFileSync(join(dir, "a", "file.txt"), "modified\n");
    git(dir, ["add", "a/file.txt"]);
    git(dir, ["write-tree"]);

    // Identify the cache-tree's `a/` subtree SHA, then delete the
    // tree object — this is the state a killed-mid-write `git commit`
    // leaves the worktree in.
    const rootTree = git(dir, ["write-tree"]).stdout.trim();
    const aTree = git(dir, ["ls-tree", rootTree, "a"]).stdout.trim().split(/\s+/)[2];
    if (!aTree || aTree.length !== 40) {
      throw new Error(`failed to resolve subtree SHA: got "${aTree ?? "(empty)"}"`);
    }
    unlinkSync(join(dir, ".git", "objects", aTree.slice(0, 2), aTree.slice(2)));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns passed=false and flags the corruption", () => {
    const check = probeCacheTree(dir);
    expect(check.name).toBe("cache_tree_probe");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("cache-tree");
  });

  it("includes the recovery suggestion in remediation", () => {
    const check = probeCacheTree(dir);
    expect(check.remediation).toBeDefined();
    expect(check.remediation).toContain("git read-tree HEAD");
    // The recovery is destructive — surface that loudly so the
    // operator doesn't run it without thinking.
    expect(check.remediation).toMatch(/discard|warn|destroys|destructive/i);
  });
});

describe("probeCacheTree — adjacent bad-repo states (false-positive sweep)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-probe-adjacent-"));
    initRepo(dir);
    writeFileSync(join(dir, "x.txt"), "one\n");
    commitAll(dir, "initial");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT trip on a broken HEAD ref", () => {
    // Overwrite the branch ref to point at a SHA that doesn't exist.
    writeFileSync(
      join(dir, ".git", "refs", "heads", "main"),
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n",
    );
    const check = probeCacheTree(dir);
    // The probe is cache-tree-specific. A broken ref is a different
    // failure mode (`invalid sha1 pointer` WITHOUT `cache-tree of`)
    // and must NOT be reported here — `df doctor` has a separate
    // surface for ref-integrity checks.
    expect(check.passed).toBe(true);
  });

  it("does NOT trip on a missing blob unrelated to cache-tree", () => {
    // Delete the only committed blob. fsck reports `missing blob <sha>`
    // but the cache-tree itself is fine.
    const blob = git(dir, ["ls-files", "-s", "x.txt"]).stdout.trim().split(/\s+/)[1];
    if (!blob || blob.length !== 40) {
      throw new Error(`failed to resolve committed blob SHA: got "${blob ?? "(empty)"}"`);
    }
    unlinkSync(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const check = probeCacheTree(dir);
    expect(check.passed).toBe(true);
  });

  it("does NOT trip on a dangling orphan object", () => {
    // Write an orphan blob; fsck reports `dangling blob`, NOT
    // `cache-tree`.
    writeFileSync(join(dir, "orphan-input"), "orphan contents\n");
    git(dir, ["hash-object", "-w", "orphan-input"]);
    // remove the working tree file so it doesn't get auto-added
    unlinkSync(join(dir, "orphan-input"));
    const check = probeCacheTree(dir);
    expect(check.passed).toBe(true);
  });
});

describe("probeCacheTree — error handling", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-probe-error-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not throw on a non-git directory", () => {
    // A bare directory with no .git/. fsck refuses; the probe should
    // surface this as a non-blocking check rather than blowing up.
    const check = probeCacheTree(dir);
    expect(check.name).toBe("cache_tree_probe");
    // The probe is INFORMATIONAL when it can't run — it doesn't know
    // whether the cache-tree is fine, so it returns passed=true with
    // a clear detail. (The base-infra `git_core_hookspath` /
    // `artifact_dir_writable` checks already cover "is this a git
    // repo at all" diagnostics.)
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/not.*git|skipped/i);
  });
});

// Acceptance: the probe is DETECT-ONLY. We assert here that
// probeCacheTree does NOT auto-remediate by invoking `git read-tree`
// on the operator's behalf. The mechanism: run the probe, then verify
// the corrupted index file is byte-for-byte unchanged after the call.
describe("probeCacheTree — detect-only invariant", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-probe-detect-"));
    initRepo(dir);
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "file.txt"), "one\n");
    commitAll(dir, "initial");
    writeFileSync(join(dir, "a", "file.txt"), "modified\n");
    git(dir, ["add", "a/file.txt"]);
    git(dir, ["write-tree"]);
    const rootTree = git(dir, ["write-tree"]).stdout.trim();
    const aTree = git(dir, ["ls-tree", rootTree, "a"]).stdout.trim().split(/\s+/)[2];
    if (!aTree || aTree.length !== 40) {
      throw new Error(`failed to resolve subtree SHA: got "${aTree ?? "(empty)"}"`);
    }
    unlinkSync(join(dir, ".git", "objects", aTree.slice(0, 2), aTree.slice(2)));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not mutate the index when it reports corruption", () => {
    const indexPath = join(dir, ".git", "index");
    const before = readFileSync(indexPath);
    const check = probeCacheTree(dir);
    expect(check.passed).toBe(false);
    const after = readFileSync(indexPath);
    expect(after.equals(before)).toBe(true);
  });
});
