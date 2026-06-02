// Issue #105 — `df doctor` orphan-lock sweep.
//
// When a `df review` subprocess is killed mid-run, the per-SHA `.lock`
// orphans under `.git/agent-reviews/`. The doctor sweep walks the
// artifact dir, parses each `<sha>.lock`'s PID, tests liveness via
// `process.kill(pid, 0)`, and removes the dead ones. The result is
// emitted as a DoctorCheck so `make df-doctor` surfaces it.

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sweepOrphanLocks } from "../../src/doctor.js";

// A PID that is virtually guaranteed to be dead: 2^22-1 is well beyond
// any reasonable `kernel.pid_max`, and POSIX/Darwin reserve PID 0/1 for
// system processes (so we don't collide with init/scheduler).
const DEAD_PID = 4_194_303;

describe("sweepOrphanLocks — dead-PID removal", () => {
  let artifactDir: string;

  beforeEach(() => {
    artifactDir = mkdtempSync(join(tmpdir(), "df-orphan-lock-"));
  });

  afterEach(() => {
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it("removes a lock whose recorded PID is dead", () => {
    const lockPath = join(artifactDir, "abc123.lock");
    writeFileSync(lockPath, `${DEAD_PID}\n2026-06-01T00:00:00Z\n`);
    const check = sweepOrphanLocks(artifactDir);
    expect(existsSync(lockPath)).toBe(false);
    expect(check.name).toBe("orphan_lock_sweep");
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/1\s+orphan/);
    expect(check.detail).toMatch(new RegExp(String(DEAD_PID)));
  });

  it("preserves a lock whose recorded PID is the live test process", () => {
    const lockPath = join(artifactDir, "live123.lock");
    writeFileSync(lockPath, `${process.pid}\n2026-06-01T00:00:00Z\n`);
    const check = sweepOrphanLocks(artifactDir);
    expect(existsSync(lockPath)).toBe(true);
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/no orphan|0 orphan/i);
  });

  it("handles mixed live + dead locks: live preserved, dead removed", () => {
    const live = join(artifactDir, "live.lock");
    const dead1 = join(artifactDir, "dead1.lock");
    const dead2 = join(artifactDir, "dead2.lock");
    writeFileSync(live, `${process.pid}\n`);
    writeFileSync(dead1, `${DEAD_PID}\n`);
    writeFileSync(dead2, `${DEAD_PID - 1}\n`);
    const check = sweepOrphanLocks(artifactDir);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead1)).toBe(false);
    expect(existsSync(dead2)).toBe(false);
    expect(check.detail).toMatch(/2\s+orphan/);
  });

  it("removes a lock whose content is unparseable as a PID (a corrupt orphan)", () => {
    const lockPath = join(artifactDir, "garbage.lock");
    writeFileSync(lockPath, "not-a-pid\n");
    const check = sweepOrphanLocks(artifactDir);
    expect(existsSync(lockPath)).toBe(false);
    expect(check.detail).toMatch(/1\s+orphan/);
  });

  it("returns a passing check when the artifact dir does not exist (no sweep needed)", () => {
    rmSync(artifactDir, { recursive: true, force: true });
    const check = sweepOrphanLocks(artifactDir);
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/no orphan|0 orphan|not present/i);
  });

  it("returns a passing check when the artifact dir has no .lock files", () => {
    writeFileSync(join(artifactDir, "abc.json"), "{}");
    writeFileSync(join(artifactDir, "abc.md"), "");
    const check = sweepOrphanLocks(artifactDir);
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/no orphan|0 orphan/i);
    // Non-lock files are untouched.
    expect(readdirSync(artifactDir).sort()).toEqual(["abc.json", "abc.md"]);
  });
});

