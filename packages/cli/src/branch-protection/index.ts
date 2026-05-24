// Service #7 — Branch-Protection Drift Detector
//
// Wraps the bundled Python script `audit_branch_protection.py` (Phase C
// extraction from sage3c per cycle 331.1). The script compares a
// declarative `spec.yaml` (consumer-supplied or fall back to the bundled
// `spec-default.yaml`) against the live GitHub branch-protection ruleset
// for the target repo. It shells out to `gh api` for the live state.
//
// The bundled `spec-default.yaml` is shipped as a fallback for first-run
// audits — consumers SHOULD author their own `spec.yaml` describing their
// desired branch-protection posture. See `spec-default.yaml` for shape.
//
// Design choice: subprocess wrap (Option A). The pure-TS rewrite is
// tracked as Phase C-PORT follow-up.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface AuditBranchProtectionOptions {
  /** Path to consumer's `spec.yaml`. Falls back to bundled default if missing AND `useBundledDefaultSpec` is true. */
  readonly specPath?: string;
  /** GitHub `owner/repo` slug. Defaults to `$REPO` or `$GITHUB_REPOSITORY`. */
  readonly repo?: string;
  /** Pass `--use-bundled-default-spec` to fall back to the bundled spec. */
  readonly useBundledDefaultSpec?: boolean;
  /** Extra argv after the resolved spec path / repo. */
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly repoRoot?: string;
  readonly inheritStdio?: boolean;
  readonly python?: string;
}

export interface AuditBranchProtectionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function getAuditBranchProtectionScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "audit_branch_protection.py");
}

/** Path to the bundled fallback `spec-default.yaml`. */
export function getBundledDefaultSpecPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "spec-default.yaml");
}

export function runAuditBranchProtection(
  options: AuditBranchProtectionOptions = {},
): Promise<AuditBranchProtectionResult> {
  const scriptPath = getAuditBranchProtectionScriptPath();
  const python = options.python ?? "python3";

  const argv: string[] = [scriptPath];
  if (options.specPath) argv.push(options.specPath);
  if (options.repo) argv.push("--repo", options.repo);
  if (options.useBundledDefaultSpec) argv.push("--use-bundled-default-spec");
  if (options.args && options.args.length > 0) argv.push(...options.args);

  const cwd = options.cwd ?? process.cwd();
  const inherit = options.inheritStdio !== false;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
  if (options.repoRoot) env["DF_REPO_ROOT"] = options.repoRoot;

  return new Promise<AuditBranchProtectionResult>((resolvePromise, rejectPromise) => {
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
