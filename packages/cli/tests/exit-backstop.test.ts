// Regression coverage for issue #167 — the `df` CLI hung for ~12 minutes
// after `df critic` had already printed its verdict and written its
// artifact, then was force-killed by the GitHub Actions `timeout-minutes`
// clamp (run 27080325829: work done at 8m, process killed at 20m as an
// orphan `node` process).
//
// Root cause: the entrypoint sets `process.exitCode` and returns, trusting
// the event loop to drain. A leaked libuv handle in a vendor SDK (e.g.
// sqlite3 via @cursor/sdk, or an SDK keep-alive socket) keeps the loop
// alive, so the process never exits on its own. `finalizeExit` arms an
// **unref'd** force-exit backstop: a clean loop still drains and exits
// naturally (the unref'd timer is discarded), but a wedged loop gets
// force-exited with the command's exit code instead of hanging until the
// CI job clamp.
//
// The integration cases reproduce the exact failure shape with a real
// child process: a deliberately-leaked `setInterval` stands in for the
// SDK handle. Without the backstop the child hangs forever; with it, the
// child exits within the grace window.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_EXIT_GRACE_MS, finalizeExit } from "../src/exit.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_EXIT_URL = pathToFileURL(resolve(HERE, "..", "dist", "exit.js")).href;

describe("finalizeExit — unit contract", () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    // CRITICAL: never let a test's exit-code probe leak into vitest's own
    // process exit code.
    process.exitCode = savedExitCode;
    vi.useRealTimers();
  });

  it("sets process.exitCode to the command's code", () => {
    const timer = finalizeExit(3, { exit: () => {} });
    expect(process.exitCode).toBe(3);
    clearTimeout(timer);
  });

  it("arms the backstop as an unref'd timer so a clean loop still exits naturally", () => {
    const timer = finalizeExit(0, { exit: () => {} });
    // An unref'd timer does not, by itself, keep the event loop alive.
    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
  });

  it("force-exits with the command's code once the grace window elapses", () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    finalizeExit(7, { graceMs: 1000, exit });
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(7);
  });

  it("exposes a positive default grace window", () => {
    expect(DEFAULT_EXIT_GRACE_MS).toBeGreaterThan(0);
  });
});

interface SpawnResult {
  exitCode: number;
  timedOut: boolean;
}

// Spawn `node <fixture>` and resolve with its exit code, killing it if it
// outlives `killAfterMs` (the hang we are guarding against).
function runFixture(source: string, killAfterMs: number): Promise<SpawnResult> {
  const dir = mkdtempSync(join(tmpdir(), "df-exit-167-"));
  const file = join(dir, "fixture.mjs");
  writeFileSync(file, source, "utf8");
  return new Promise<SpawnResult>((resolvePromise) => {
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "ignore", "pipe"] });
    let settled = false;
    const watchdog = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolvePromise({ exitCode: -1, timedOut: true });
    }, killAfterMs);
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(watchdog);
      rmSync(dir, { recursive: true, force: true });
      resolvePromise({ exitCode: code === null ? -1 : code, timedOut: false });
    });
  });
}

describe("finalizeExit — process-level #167 regression", () => {
  it("force-exits a wedged process (leaked handle) within the grace window", async () => {
    // The `setInterval` is the stand-in for the leaked SDK handle: without
    // the backstop, this process can NEVER drain its event loop and hangs
    // forever (exactly #167). With it, the unref'd backstop still fires —
    // because the leak keeps the loop alive — and force-exits with code 7.
    const fixture = [
      `import { finalizeExit } from ${JSON.stringify(DIST_EXIT_URL)};`,
      `setInterval(() => {}, 1 << 30);`,
      `finalizeExit(7, { graceMs: 150 });`,
    ].join("\n");
    const r = await runFixture(fixture, 8000);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(7);
  });

  it("does not delay a clean process — the unref'd backstop never holds it open", async () => {
    // No leaked handle. A correct (unref'd) backstop must let the process
    // exit immediately with code 0, NOT sit on the 60s grace timer. If the
    // timer were ref'd, this would hang and trip the 8s watchdog.
    const fixture = [
      `import { finalizeExit } from ${JSON.stringify(DIST_EXIT_URL)};`,
      `finalizeExit(0, { graceMs: 60000 });`,
    ].join("\n");
    const r = await runFixture(fixture, 8000);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
  });
});
