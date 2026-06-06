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
 * Build the argv that will be handed to the `copier copy` subprocess.
 *
 * `--trust` is unconditional and load-bearing: the bundled
 * sage-blueprint template uses Copier `_tasks` (e.g. `npm install`,
 * lockfile generation, formatter passes), and Copier 9+ refuses to
 * execute templates with `_tasks` unless `--trust` is explicitly
 * passed. The sage-cli wrapper IS the trust boundary for the bundled
 * template — by the time we're invoking copier, the bundle has
 * already been resolved via the build-time `bundle-template.mjs`
 * pipeline (LOCAL_PATH or a pinned ref from the trusted source repo),
 * so re-asking the customer to opt in to "trust" of our own template
 * adds no security value and breaks every spawn.
 *
 * See https://github.com/momentiq-ai/dark-factory/issues/153.
 */
export function buildCopyArgs(opts: CopierCopyOptions): string[] {
  const args = ["copy", opts.templatePath, opts.destination, "--trust"];
  if (opts.acceptDefaults) args.push("--defaults");
  if (opts.vcsRef) {
    args.push("--vcs-ref", opts.vcsRef);
  }
  for (const [key, value] of Object.entries(opts.data)) {
    args.push("--data", `${key}=${String(value)}`);
  }
  return args;
}

/**
 * Run `copier copy` against the bundled template. Streams stdout/stderr
 * to the parent so the customer sees Copier's normal progress output.
 * Returns the exit code; non-zero means Copier reported a failure and
 * the caller should surface a clear message.
 */
export function runCopierCopy(opts: CopierCopyOptions): Promise<number> {
  return runCopier(buildCopyArgs(opts));
}

export interface CopierUpdateOptions {
  /** Destination directory of an existing scaffolded product. */
  destination: string;
  /** If true, pass `--pretend` for a dry-run. */
  dryRun?: boolean;
}

/**
 * Build the argv that will be handed to the `copier update` subprocess.
 *
 * `--trust` is unconditional for the same reason as `buildCopyArgs`:
 * the bundled template uses `_tasks`. `copier update` re-runs those
 * tasks against an existing scaffolded product, so it inherits the
 * same trust requirement. See `buildCopyArgs` for the full rationale.
 */
export function buildUpdateArgs(opts: CopierUpdateOptions): string[] {
  const args = ["update", "--trust"];
  if (opts.dryRun) args.push("--pretend");
  return args;
}

/**
 * Run `copier update` in an existing scaffolded product directory.
 * Copier reads `.copier-answers.yml` to find the template; we pass the
 * destination as the working dir.
 */
export function runCopierUpdate(opts: CopierUpdateOptions): Promise<number> {
  return runCopier(buildUpdateArgs(opts), opts.destination);
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
