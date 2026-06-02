// Issue #105 — SIGTERM/SIGINT lock release.
//
// `runReview` wraps the per-SHA lock in try/finally, but a signal-killed
// process bypasses `finally` and orphans `.git/agent-reviews/<sha>.lock`.
// `installSignalLockGuard` registers process signal handlers that release
// the lock on SIGTERM/SIGINT and restore the original handlers on
// `uninstall()` so listeners don't leak across programmatic re-runs.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSignalLockGuard } from "../src/runner.js";

describe("installSignalLockGuard — releases lock on signal", () => {
  let tmp: string;
  let lockPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "df-siglock-"));
    lockPath = join(tmp, "test.lock");
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removes the lock file when SIGTERM is received", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      // Swallow the exit so the test process survives.
      return undefined as never;
    }) as typeof process.exit);
    const guard = installSignalLockGuard(lockPath);
    try {
      expect(existsSync(lockPath)).toBe(true);
      process.emit("SIGTERM");
      expect(existsSync(lockPath)).toBe(false);
      expect(exitSpy).toHaveBeenCalledWith(143);
    } finally {
      guard.uninstall();
      exitSpy.mockRestore();
    }
  });

  it("removes the lock file when SIGINT is received", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      return undefined as never;
    }) as typeof process.exit);
    const guard = installSignalLockGuard(lockPath);
    try {
      expect(existsSync(lockPath)).toBe(true);
      process.emit("SIGINT");
      expect(existsSync(lockPath)).toBe(false);
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
      guard.uninstall();
      exitSpy.mockRestore();
    }
  });

  it("uninstall() removes the listeners so they do not leak across runs", () => {
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeInt = process.listenerCount("SIGINT");
    const guard = installSignalLockGuard(lockPath);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt + 1);
    guard.uninstall();
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    expect(process.listenerCount("SIGINT")).toBe(beforeInt);
  });

  it("uninstall() preserves pre-existing handlers (no listener leak across programmatic re-runs)", () => {
    const preExisting = vi.fn();
    process.on("SIGTERM", preExisting);
    try {
      const guard = installSignalLockGuard(lockPath);
      guard.uninstall();
      // The pre-existing handler must still be wired up.
      expect(process.listeners("SIGTERM")).toContain(preExisting);
    } finally {
      process.removeListener("SIGTERM", preExisting);
    }
  });

  it("re-installing after uninstall does not duplicate the lock-release listener", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      return undefined as never;
    }) as typeof process.exit);
    try {
      const baseline = process.listenerCount("SIGTERM");
      for (let i = 0; i < 5; i++) {
        const g = installSignalLockGuard(lockPath);
        g.uninstall();
      }
      expect(process.listenerCount("SIGTERM")).toBe(baseline);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
