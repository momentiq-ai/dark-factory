import { spawn, spawnSync } from "node:child_process";

/**
 * Subprocess wrapper around the system `copier` binary. We do NOT
 * vendor Copier — customers `pip install copier` (or `pipx install
 * copier`) once, then we delegate every template operation to it.
 *
 * Why not vendor: Copier is a Python tool with non-trivial deps
 * (Jinja2, pydantic). Bundling a Python runtime + Copier into an npm
 * package crosses ecosystem lines for marginal benefit. The friction
 * of one `pip install` is small versus the wheel cost.
 */

export interface CopierEnsureResult {
  installed: boolean;
  version?: string;
  /** Friendly install instructions to print if not installed. */
  installHint: string;
}

const INSTALL_HINT =
  "Sage uses Copier to render the template. Install it with:\n" +
  "  pipx install copier         (recommended)\n" +
  "  pip install copier          (alternative)\n" +
  "After install, rerun the sage command.";

export function ensureCopierInstalled(): CopierEnsureResult {
  try {
    const result = spawnSync("copier", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      const version = result.stdout.trim().replace(/^copier\s+/i, "");
      return { installed: true, version, installHint: INSTALL_HINT };
    }
  } catch {
    // fall through to not-installed branch
  }
  return { installed: false, installHint: INSTALL_HINT };
}

export interface CopierCopyOptions {
  /** Absolute path to the bundled template root. */
  templatePath: string;
  /** Destination directory (relative or absolute). */
  destination: string;
  /** Pre-filled answers as a flat record. */
  data: Record<string, string | boolean | number>;
  /** Pass `--vcs-ref HEAD` so copier doesn't fight the bundled template's git state. */
  vcsRef?: string;
  /** If true, pass `--defaults` so copier accepts defaults for unset variables instead of prompting. */
  acceptDefaults?: boolean;
}

/**
 * Run `copier copy` against the bundled template. Streams stdout/stderr
 * to the parent so the customer sees Copier's normal progress output.
 * Returns the exit code; non-zero means Copier reported a failure and
 * the caller should surface a clear message.
 */
export function runCopierCopy(opts: CopierCopyOptions): Promise<number> {
  const args = ["copy", opts.templatePath, opts.destination];
  if (opts.acceptDefaults) args.push("--defaults");
  if (opts.vcsRef) {
    args.push("--vcs-ref", opts.vcsRef);
  }
  for (const [key, value] of Object.entries(opts.data)) {
    args.push("--data", `${key}=${String(value)}`);
  }
  return runCopier(args);
}

export interface CopierUpdateOptions {
  /** Destination directory of an existing scaffolded product. */
  destination: string;
  /** If true, pass `--pretend` for a dry-run. */
  dryRun?: boolean;
}

/**
 * Run `copier update` in an existing scaffolded product directory.
 * Copier reads `.copier-answers.yml` to find the template; we pass the
 * destination as the working dir.
 */
export function runCopierUpdate(opts: CopierUpdateOptions): Promise<number> {
  const args = ["update"];
  if (opts.dryRun) args.push("--pretend");
  return runCopier(args, opts.destination);
}

function runCopier(args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const opts: Parameters<typeof spawn>[2] = { stdio: "inherit" };
    if (cwd !== undefined) opts.cwd = cwd;
    const child = spawn("copier", args, opts);
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
