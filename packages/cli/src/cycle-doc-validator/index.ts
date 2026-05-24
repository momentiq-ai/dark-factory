// Service #5 — Cycle-Doc Trailer Validator
//
// Wraps the bundled Python script `validate_cycle_doc.py` (Phase C
// extraction from sage3c per cycle 331.1). The script is invoked as a
// subprocess; arguments are passed through verbatim and the child's
// stdout/stderr/exit-code propagate to the caller.
//
// Design choice — subprocess wrapping (Option A) vs pure-TS port (Option B):
// Phase C uses Option A to preserve the existing 39-test pytest corpus
// and keep behavior 1:1 with sage3c. Option B (pure-TS rewrite) is
// tracked as Phase C-PORT follow-up.
//
// REPO_ROOT detection: the wrapped script prefers the `DF_REPO_ROOT`
// env var (set here automatically when `repoRoot` is supplied), falls
// back to `git rev-parse --show-toplevel`, and finally to its own
// `__file__`-relative legacy path. This means the script always finds
// the CONSUMER repo (not dark-factory's own checkout) when invoked
// from a consumer cwd.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ValidateCycleDocOptions {
  /** Extra argv passed to the Python script after the script path. */
  readonly args?: ReadonlyArray<string>;
  /**
   * Working directory for the subprocess. Defaults to `process.cwd()`.
   * The script uses cwd to locate the consumer's git toplevel.
   */
  readonly cwd?: string;
  /**
   * Override env vars merged into `process.env` for the subprocess. The
   * wrapper always sets `DF_REPO_ROOT` if `repoRoot` is supplied.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Explicit repo root. Set as `DF_REPO_ROOT` so the script bypasses
   * `git rev-parse` resolution. Use when invoking outside a git
   * worktree (rare; mostly for tests).
   */
  readonly repoRoot?: string;
  /**
   * Inherit stdio (default `true`). When `false` the parent captures
   * stdout/stderr as strings on the result.
   */
  readonly inheritStdio?: boolean;
  /** Python interpreter name. Defaults to `python3`. */
  readonly python?: string;
}

export interface ValidateCycleDocResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Filesystem path to the bundled `validate_cycle_doc.py` script.
 *
 * In dev (running from `src/`) and published (running from `dist/`), the
 * script lives next to this module. The post-build copy step in
 * `packages/cli/scripts/copy-assets.mjs` mirrors `src/**\/*.py` to
 * `dist/**\/*.py` so the resolution is identical.
 */
export function getValidateCycleDocScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "validate_cycle_doc.py");
}

export function runValidateCycleDoc(
  options: ValidateCycleDocOptions = {},
): Promise<ValidateCycleDocResult> {
  const scriptPath = getValidateCycleDocScriptPath();
  const python = options.python ?? "python3";
  const args = [scriptPath, ...(options.args ?? [])];
  const cwd = options.cwd ?? process.cwd();
  const inherit = options.inheritStdio !== false;

  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
  if (options.repoRoot) env["DF_REPO_ROOT"] = options.repoRoot;

  return new Promise<ValidateCycleDocResult>((resolvePromise, rejectPromise) => {
    const child = spawn(python, args, {
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
