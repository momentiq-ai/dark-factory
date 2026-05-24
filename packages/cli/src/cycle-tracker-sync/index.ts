// Service #9 — Cycle Tracker Sync + PR Attribution
//
// Wraps two bundled Python scripts (Phase C extraction from sage3c per
// cycle 331.1):
//
//   - `sync_cycle_trackers.py`  — discovers cycle docs by glob and
//     reconciles GitHub-tracker-issue state on every run. Used by the
//     `cycle-tracker-sync` reusable workflow (push on cycle-doc paths +
//     daily cron + manual dispatch).
//   - `attribute_pr_cycle_ref.py` — parses the `Cycle: <N>` trailer from
//     PR body + commit messages and writes the cycle ID into the PR's
//     project item via `updateProjectV2ItemFieldValue` with a TEXT input
//     (the `Cycle Ref` custom field). Used by the `cycle-board.yml`
//     workflow on every PR event.
//
// Both scripts shell out to `gh` for GitHub API calls; require `gh`
// available on `PATH` + an authenticated session (PROJECT_TOKEN env var
// in CI, or a logged-in `gh auth status` locally).
//
// Design choice: subprocess wrap (Option A). Phase C-PORT follow-up
// tracks the pure-TS rewrite.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SyncCycleTrackersOptions {
  /** Extra argv passed to the Python script. */
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly inheritStdio?: boolean;
  readonly python?: string;
}

export interface AttributePrCycleRefOptions extends SyncCycleTrackersOptions {}

export interface PythonScriptResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function getSyncCycleTrackersScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "sync_cycle_trackers.py");
}

export function getAttributePrCycleRefScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "attribute_pr_cycle_ref.py");
}

function spawnPython(
  scriptPath: string,
  options: SyncCycleTrackersOptions,
): Promise<PythonScriptResult> {
  const python = options.python ?? "python3";
  const argv = [scriptPath, ...(options.args ?? [])];
  const cwd = options.cwd ?? process.cwd();
  const inherit = options.inheritStdio !== false;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };

  return new Promise<PythonScriptResult>((resolvePromise, rejectPromise) => {
    const child = spawn(python, argv, {
      cwd,
      env,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
    }
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code) => {
      resolvePromise({
        exitCode: code === null ? -1 : code,
        stdout,
        stderr,
      });
    });
  });
}

export function runSyncCycleTrackers(
  options: SyncCycleTrackersOptions = {},
): Promise<PythonScriptResult> {
  return spawnPython(getSyncCycleTrackersScriptPath(), options);
}

export function runAttributePrCycleRef(
  options: AttributePrCycleRefOptions = {},
): Promise<PythonScriptResult> {
  return spawnPython(getAttributePrCycleRefScriptPath(), options);
}
