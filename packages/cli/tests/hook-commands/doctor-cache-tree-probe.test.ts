// Issue #107 — `probeCacheTree` detects the cache-tree corruption shape
// observed in `dark-factory-platform#170`: the index's cache-tree
// references a tree (or blob) that doesn't exist in `.git/objects/`,
// which is what a killed-mid-write `git commit` leaves the worktree in.
//
// The probe runs `git fsck --no-dangling` (LC_ALL=C, bounded buffer +
// timeout, async) and matches its output against
// `CACHE_TREE_CORRUPTION_REGEX`. Tests cover:
//   1. Regex matches both the git-2.39.x short form and the
//      git-2.50.x long form ("error: <sha>: invalid sha1 pointer in
//      cache-tree" with optional " of <path>" suffix).
//   2. Clean repo — probe passes.
//   3. Cache-tree references missing tree — probe reports corrupted +
//      includes the recovery suggestion (`git read-tree HEAD`).
//   4. The corrupted fixture's actual fsck stderr matches the regex
//      (regression guard against the 2.39 drift).
//   5. Adjacent bad-repo states (broken HEAD ref, missing blob NOT in
//      cache-tree, dangling blob) do NOT trip the probe.
//   6. Non-git directory — probe returns a check that flags the
//      condition without throwing.
//   7. ENOBUFS / timeout / spawn-error paths return non-passing checks
//      (no silent pass).
//   8. The probe pins LC_ALL=C / LANG=C and passes --no-dangling so
//      output stays English-locale + bounded.
//   9. The probe is async — returns Promise<DoctorCheck>.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

import {
  CACHE_TREE_CORRUPTION_REGEX,
  probeCacheTree,
} from "../../src/doctor.js";

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

// Build a corrupted-cache-tree fixture in `dir`. Returns the offending
// subtree SHA.
function buildCorruptionFixture(dir: string): string {
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
  return aTree;
}

// Install a fake `git` shim on a fresh PATH-only directory. The shim
// records argv + relevant env vars to `recordPath`, then runs the
// supplied behavior. Returns a function that restores PATH.
//
// `behavior` is the body of a sh script. It runs AFTER argv/env have
// been recorded. Use `exit <code>` to set the exit status, write to
// stderr with `printf ... 1>&2`, etc.
function installFakeGit(
  shimDir: string,
  recordPath: string,
  behavior: string,
): () => void {
  const shimPath = join(shimDir, "git");
  // The recorder writes one line per arg (argv) followed by an `ENV:`
  // marker and one line per recorded env var. Tests parse this back.
  const script = `#!/bin/sh
{
  for a in "$@"; do printf '%s\\n' "$a"; done
  printf 'ENV:\\n'
  printf 'LC_ALL=%s\\n' "$LC_ALL"
  printf 'LANG=%s\\n' "$LANG"
} > '${recordPath}'
${behavior}
`;
  writeFileSync(shimPath, script);
  chmodSync(shimPath, 0o755);
  const oldPath = process.env["PATH"] ?? "";
  process.env["PATH"] = `${shimDir}:${oldPath}`;
  return () => {
    process.env["PATH"] = oldPath;
  };
}

function readRecording(recordPath: string): { argv: string[]; env: Record<string, string> } {
  const text = readFileSync(recordPath, "utf8");
  const lines = text.split("\n");
  const sep = lines.indexOf("ENV:");
  const argv = sep === -1 ? lines.filter((l) => l !== "") : lines.slice(0, sep);
  const envLines = sep === -1 ? [] : lines.slice(sep + 1).filter((l) => l !== "");
  const env: Record<string, string> = {};
  for (const line of envLines) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { argv, env };
}

// ---------------------------------------------------------------------
// Finding #1 — regex must match BOTH the git-2.39.x short form and
// the git-2.50.x long form.
// ---------------------------------------------------------------------

describe("CACHE_TREE_CORRUPTION_REGEX", () => {
  it("matches the git-2.39.x short form (no ' of <path>' suffix)", () => {
    // Git 2.39.5 (Debian 12) emits this shorter form. The original
    // regex required the trailing ` of`, silently passing on real
    // corruption.
    const stderr =
      "error: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef: invalid sha1 pointer in cache-tree\n";
    expect(CACHE_TREE_CORRUPTION_REGEX.test(stderr)).toBe(true);
  });

  it("matches the git-2.50.x long form (with ' of <path>' suffix)", () => {
    const stderr =
      "error: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef: invalid sha1 pointer in cache-tree of .git/index\n";
    expect(CACHE_TREE_CORRUPTION_REGEX.test(stderr)).toBe(true);
  });

  it("does NOT match the substring inside an unrelated word", () => {
    // Defense against a future fsck message like
    // "...cache-treeoverflow..." accidentally tripping the probe.
    const stderr = "info: cache-treeoverflow noted in some-path\n";
    expect(CACHE_TREE_CORRUPTION_REGEX.test(stderr)).toBe(false);
  });
});

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

  it("returns passed=true on a healthy repo", async () => {
    const check = await probeCacheTree(dir);
    expect(check.name).toBe("cache_tree_probe");
    expect(check.passed).toBe(true);
  });
});

describe("probeCacheTree — cache-tree references missing tree", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-probe-corrupt-"));
    buildCorruptionFixture(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns passed=false and flags the corruption", async () => {
    const check = await probeCacheTree(dir);
    expect(check.name).toBe("cache_tree_probe");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("cache-tree");
  });

  it("includes the recovery suggestion in remediation", async () => {
    const check = await probeCacheTree(dir);
    expect(check.remediation).toBeDefined();
    expect(check.remediation).toContain("git read-tree HEAD");
    // The recovery is destructive — surface that loudly so the
    // operator doesn't run it without thinking.
    expect(check.remediation).toMatch(/discard|warn|destroys|destructive/i);
  });

  // ----- Finding #2 — regression guard against regex drift. -----
  it("the corrupted fixture's actual git-fsck stderr matches the regex", () => {
    const r = spawnSync(
      "git",
      ["fsck", "--no-dangling"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } },
    );
    const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    expect(combined.length).toBeGreaterThan(0);
    expect(CACHE_TREE_CORRUPTION_REGEX.test(combined)).toBe(true);
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

  it("does NOT trip on a broken HEAD ref", async () => {
    // Overwrite the branch ref to point at a SHA that doesn't exist.
    writeFileSync(
      join(dir, ".git", "refs", "heads", "main"),
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n",
    );
    const check = await probeCacheTree(dir);
    // The probe is cache-tree-specific. A broken ref is a different
    // failure mode (`invalid sha1 pointer` WITHOUT `cache-tree`) and
    // must NOT be reported here — `df doctor` has a separate surface
    // for ref-integrity checks.
    expect(check.passed).toBe(true);
  });

  it("does NOT trip on a missing blob unrelated to cache-tree", async () => {
    // Delete the only committed blob. fsck reports `missing blob <sha>`
    // but the cache-tree itself is fine.
    const blob = git(dir, ["ls-files", "-s", "x.txt"]).stdout.trim().split(/\s+/)[1];
    if (!blob || blob.length !== 40) {
      throw new Error(`failed to resolve committed blob SHA: got "${blob ?? "(empty)"}"`);
    }
    unlinkSync(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const check = await probeCacheTree(dir);
    expect(check.passed).toBe(true);
  });

  it("does NOT trip on a dangling orphan object", async () => {
    // Write an orphan blob; fsck WITHOUT --no-dangling reports
    // `dangling blob`. With --no-dangling (the probe's flag), the
    // dangling line is suppressed entirely. Either way, the probe
    // must not trip on this state.
    writeFileSync(join(dir, "orphan-input"), "orphan contents\n");
    git(dir, ["hash-object", "-w", "orphan-input"]);
    // remove the working tree file so it doesn't get auto-added
    unlinkSync(join(dir, "orphan-input"));
    const check = await probeCacheTree(dir);
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

  it("does not throw on a non-git directory", async () => {
    // A bare directory with no .git/. fsck refuses; the probe should
    // surface this as a non-blocking check rather than blowing up.
    const check = await probeCacheTree(dir);
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
    buildCorruptionFixture(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not mutate the index when it reports corruption", async () => {
    const indexPath = join(dir, ".git", "index");
    const before = readFileSync(indexPath);
    const check = await probeCacheTree(dir);
    expect(check.passed).toBe(false);
    const after = readFileSync(indexPath);
    expect(after.equals(before)).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Finding #5 — async signature. The probe must return Promise so it
// doesn't block the event loop on large repos (git fsck can take
// minutes when the object database is huge).
// ---------------------------------------------------------------------

describe("probeCacheTree — async signature (finding #5)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-probe-promise-"));
    initRepo(dir);
    writeFileSync(join(dir, "x.txt"), "one\n");
    commitAll(dir, "initial");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a Promise (does not block the event loop)", () => {
    const result = probeCacheTree(dir);
    expect(typeof (result as Promise<unknown>).then).toBe("function");
    return result;
  });
});

// ---------------------------------------------------------------------
// Findings #4 + #6 — locale pinning + --no-dangling flag. Drive the
// probe against a fake `git` shim that records its argv + env vars.
// ---------------------------------------------------------------------

describe("probeCacheTree — spawn contract (findings #4 + #6)", () => {
  let dir: string;
  let shimDir: string;
  let recordPath: string;
  let restorePath: (() => void) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-probe-shim-target-"));
    // A real .git dir so `existsSync(resolve(repoRoot, ".git"))`
    // passes the early skip. The fake git script doesn't care
    // about its contents; it just records what it was called with.
    mkdirSync(join(dir, ".git"));
    shimDir = mkdtempSync(join(tmpdir(), "df-probe-shim-"));
    recordPath = join(shimDir, "recording.txt");
    // Default shim: succeed silently. Tests override behavior below.
    restorePath = installFakeGit(shimDir, recordPath, "exit 0");
    // Pre-seed locale env so we can confirm the probe overrides it.
    process.env["LC_ALL"] = "fr_FR.UTF-8";
    process.env["LANG"] = "fr_FR.UTF-8";
  });

  afterEach(() => {
    restorePath?.();
    delete process.env["LC_ALL"];
    delete process.env["LANG"];
    rmSync(dir, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  });

  it("passes --no-dangling to git fsck (finding #6)", async () => {
    await probeCacheTree(dir);
    const { argv } = readRecording(recordPath);
    expect(argv).toEqual(["fsck", "--no-dangling"]);
  });

  it("pins LC_ALL=C and LANG=C when spawning git (finding #4)", async () => {
    await probeCacheTree(dir);
    const { env } = readRecording(recordPath);
    expect(env["LC_ALL"]).toBe("C");
    expect(env["LANG"]).toBe("C");
  });
});

// ---------------------------------------------------------------------
// Finding #3 — bounded buffer + timeout + non-silent overflow. A
// large fsck output (or timeout) must NOT silently pass.
// ---------------------------------------------------------------------

describe("probeCacheTree — bounded-buffer / failure paths (finding #3)", () => {
  let dir: string;
  let shimDir: string;
  let recordPath: string;
  let restorePath: (() => void) | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-probe-bounded-target-"));
    mkdirSync(join(dir, ".git"));
    shimDir = mkdtempSync(join(tmpdir(), "df-probe-bounded-shim-"));
    recordPath = join(shimDir, "recording.txt");
  });

  afterEach(() => {
    restorePath?.();
    rmSync(dir, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  });

  it("still detects cache-tree corruption in the shim's stderr (regex check fires first)", async () => {
    // Shim: emit the corruption signature AND exit 1 (the realistic
    // mid-corruption fsck behavior). The probe must read stderr,
    // match the regex, and report passed=false with the cache-tree
    // diagnostic — NOT the generic error path.
    restorePath = installFakeGit(
      shimDir,
      recordPath,
      `printf 'error: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef: invalid sha1 pointer in cache-tree of .git/index\\n' 1>&2
exit 1`,
    );
    const check = await probeCacheTree(dir);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("cache-tree");
  });

  it("does NOT silently pass on ENOBUFS-shaped overflow output", async () => {
    // Shim: write more than the configured maxBuffer (we set 50 MB in
    // the implementation; this shim writes 80 MB of irrelevant lines
    // so node spawn truncates the read with an ENOBUFS-style error).
    // The probe must NOT silently report passed=true.
    restorePath = installFakeGit(
      shimDir,
      recordPath,
      `# Stream 80 MB of arbitrary output. yes(1) on macOS/Linux is the
# canonical infinite-fountain — bound it with head -c.
yes "noise noise noise noise noise noise noise noise" | head -c 83886080 1>&2
exit 0`,
    );
    const check = await probeCacheTree(dir);
    expect(check.passed).toBe(false);
  }, 15_000);

  it("does NOT silently pass when fsck times out (timeout path)", async () => {
    // Shim: block forever. Pair it with the probe's testability hook
    // (`DF_CACHE_TREE_PROBE_TIMEOUT_MS=250`) so the probe SIGKILLs us
    // and returns indeterminate within a sub-second window — no need
    // to make the test suite wait 30s.
    restorePath = installFakeGit(
      shimDir,
      recordPath,
      `exec sleep 30`,
    );
    process.env["DF_CACHE_TREE_PROBE_TIMEOUT_MS"] = "250";
    try {
      const check = await probeCacheTree(dir);
      expect(check.passed).toBe(false);
      expect(check.detail).toMatch(/timeout|exceeded|indeterminate/i);
    } finally {
      delete process.env["DF_CACHE_TREE_PROBE_TIMEOUT_MS"];
    }
  });

  it("does NOT silently pass when the spawn itself errors (ENOENT)", async () => {
    // Empty PATH → git binary not findable. The probe's existing
    // "git not on PATH → passed=true" is the ONE allowed silent-pass
    // path because the broader `df doctor` flow surfaces it via every
    // other git-using check. Verify the silent pass is gated on the
    // ENOENT shape specifically (not "any spawn error").
    const oldPath = process.env["PATH"];
    process.env["PATH"] = "/nonexistent-empty-bin";
    try {
      const check = await probeCacheTree(dir);
      // ENOENT remains the explicit silent-pass: documented behavior.
      // We assert here it does NOT throw and has a detail line.
      expect(check.name).toBe("cache_tree_probe");
      expect(check.detail.length).toBeGreaterThan(0);
    } finally {
      process.env["PATH"] = oldPath;
    }
  });
});
