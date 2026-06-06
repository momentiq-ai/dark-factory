import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { parse as parseYaml } from "yaml";

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
  /**
   * Absolute path to the trusted bundled template root. When set,
   * `runCopierUpdate` verifies that the destination's
   * `.copier-answers.yml` `_src_path` resolves to this same path before
   * spawning `copier update --trust`. This is the defense-in-depth
   * guard against a hostile `_src_path` redirecting `--trust` to an
   * attacker-controlled template's `_tasks` (RCE). When omitted, the
   * verification is skipped — pass it from `update.ts` via
   * `getBundledTemplatePath()`.
   */
  trustedTemplatePath?: string;
}

/**
 * Verify that the destination's recorded `_src_path` resolves to the
 * trusted bundled template path. Throws on:
 *
 *   - missing `.copier-answers.yml` (destination isn't a scaffolded product)
 *   - missing `_src_path` (answers file is malformed or hand-edited)
 *   - resolved `_src_path` does not equal the trusted bundled path
 *     (e.g. it's a URL, an unrelated local path, or a tampered value
 *     pointing at a hostile template)
 *
 * Pure function (no I/O beyond the destination file + path math) so the
 * call site at `runCopierUpdate` can inject a temp dir from tests
 * without depending on a real bundled template being present. See
 * https://github.com/momentiq-ai/dark-factory/issues/156 for the
 * critic finding that motivated this guard.
 */
export function verifyDestinationIsBundledTemplate(
  destination: string,
  trustedTemplatePath: string,
): void {
  const answersPath = resolvePath(destination, ".copier-answers.yml");
  if (!existsSync(answersPath)) {
    throw new Error(
      `Refusing to run 'copier update --trust': ${destination} has no ` +
        `.copier-answers.yml. Run 'sage update' inside a scaffolded product directory.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(answersPath, "utf-8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Refusing to run 'copier update --trust': failed to parse ${answersPath} (${message}).`,
    );
  }
  const answers =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { _src_path?: unknown })
      : {};
  const srcPath = typeof answers._src_path === "string" ? answers._src_path : undefined;
  if (!srcPath) {
    throw new Error(
      `Refusing to run 'copier update --trust': ${answersPath} has no _src_path. ` +
        `Cannot verify the template is the one this CLI bundled.`,
    );
  }

  const trustedAbs = resolvePath(trustedTemplatePath);
  const recordedAbs = resolvePath(destination, srcPath);
  if (recordedAbs !== trustedAbs) {
    throw new Error(
      `Refusing to run 'copier update --trust': destination's _src_path ` +
        `(${srcPath}) does not match this CLI's bundled sage-blueprint template ` +
        `(${trustedAbs}). --trust grants the template's _tasks shell-exec privileges, ` +
        `so we only allow it against the template this CLI shipped. If you intentionally ` +
        `rendered against a different template (or your CLI was reinstalled to a new path), ` +
        `run 'copier update --trust' directly in that directory.`,
    );
  }
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
 *
 * If `opts.trustedTemplatePath` is set, we first verify the
 * destination's recorded `_src_path` matches that trusted path —
 * `--trust` is unconditional on the argv so the bundled template's
 * `_tasks` can run, which means an unverified `_src_path` would let a
 * malicious actor redirect `copier update --trust` to a hostile
 * template's `_tasks` (RCE). The verification fails closed: any
 * mismatch throws before `copier` is spawned.
 */
export function runCopierUpdate(opts: CopierUpdateOptions): Promise<number> {
  if (opts.trustedTemplatePath !== undefined) {
    verifyDestinationIsBundledTemplate(opts.destination, opts.trustedTemplatePath);
  }
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
