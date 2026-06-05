// packages/cli/src/onboard/writers/pr-writer.ts
//
// --pr mode: gh-auth precondition + branch + applyPlan + commit + gh pr create.
// Subprocess calls run through SubprocessRunner so unit tests stub them out.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { applyPlan } from "../apply-plan.js";
import type { ScaffoldPlan } from "../scaffold-schema.js";

const execFileAsync = promisify(execFile);

export type SubprocessRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export const defaultRunner: SubprocessRunner = async (cmd, args, opts) => {
  const result = await execFileAsync(cmd, args, opts?.cwd !== undefined ? { cwd: opts.cwd } : {});
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export interface PrModeOptions {
  run?: SubprocessRunner;
  canonicalName: string;
  /** Resolved default-branch name (e.g. "main"). Comes from
   *  `analysis.git.defaultBranch` — Phase A resolves it ONCE via
   *  `git symbolic-ref refs/remotes/origin/HEAD` with HEAD fallback. For
   *  repos where Phase A's heuristic misses (non-`origin` remote, shallow
   *  clone, local-only repo, missing remote HEAD) the empty-string value
   *  triggers runPrMode's defensive "main" fallback. Hardening tracked at
   *  DFP #262. */
  defaultBranch: string;
  force?: boolean;
}

export interface PrModeResult {
  branch: string;
  prUrl: string;
}

/** Preflight check #1 — `gh` CLI authenticated.
 *  Stream-portability note: `gh auth status` has historically split the
 *  "Logged in to github.com" banner between stdout and stderr across
 *  versions. We concatenate both streams before matching so the check is
 *  robust to either shape (cli/cli#7019 / #7619). */
export async function preflightGhAuth(
  run: SubprocessRunner,
  rootDir: string,
): Promise<void> {
  try {
    const { stdout, stderr } = await run("gh", ["auth", "status"], { cwd: rootDir });
    const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
    if (!/Logged in to github\.com/.test(combined)) {
      throw new Error("gh auth status did not show github.com login");
    }
  } catch (e) {
    throw new Error(
      `df onboard: --pr mode requires gh CLI authentication. ` +
        `Run \`gh auth login\` and re-try. (underlying: ${(e as Error).message})`,
    );
  }
}

/** Preflight check #2 — working tree is clean.
 *  Replaces the older default-branch-block check. A dirty worktree is the
 *  real footgun (the dirty changes flow into the new df/onboard-<sha8>
 *  branch silently); a clean main is harmless because the --pr writer
 *  creates a NEW branch regardless. */
export async function preflightCleanWorktree(
  run: SubprocessRunner,
  rootDir: string,
): Promise<void> {
  const { stdout } = await run("git", ["status", "--porcelain"], { cwd: rootDir });
  const dirty = stdout.split("\n").filter((l) => l.trim().length > 0);
  if (dirty.length > 0) {
    const sample = dirty.slice(0, 20).join("\n");
    const more = dirty.length > 20 ? `\n  ... ${dirty.length - 20} more` : "";
    throw new Error(
      `df onboard: refuses --pr with a dirty working tree (${dirty.length} ${
        dirty.length === 1 ? "path" : "paths"
      }). ` +
        `Commit or stash before re-running, or use --apply for an in-place write that doesn't open a PR.\n` +
        `Dirty paths:\n${sample}${more}`,
    );
  }
}

/** Single entry point for the two cheap, deterministic preflight checks.
 *  cmdOnboard MUST call this BEFORE generatePlan so operators don't pay an
 *  LLM round-trip just to discover gh isn't logged in or their worktree is
 *  dirty. */
export async function preflightPr(
  run: SubprocessRunner,
  rootDir: string,
): Promise<void> {
  await preflightGhAuth(run, rootDir);
  await preflightCleanWorktree(run, rootDir);
}

export async function runPrMode(
  rootDir: string,
  plan: ScaffoldPlan,
  analysisSha8: string,
  opts: PrModeOptions,
  stderr?: (s: string) => void,
): Promise<PrModeResult> {
  const run = opts.run ?? defaultRunner;
  await preflightPr(run, rootDir);
  // Defensive defaultBranch fallback (DFP #262). Phase B does NOT re-resolve;
  // we fall back to "main" so `--base ""` is impossible, and warn loudly so
  // the operator notices.
  let defaultBranch = opts.defaultBranch;
  if (!defaultBranch || defaultBranch.trim().length === 0) {
    (stderr ?? ((s: string) => process.stderr.write(s)))(
      "df onboard: WARNING — analysis.git.defaultBranch is empty; falling back to \"main\" for `gh pr create --base`. " +
        "Hardening tracked at https://github.com/momentiq-ai/dark-factory-platform/issues/262.\n",
    );
    defaultBranch = "main";
  }

  const branch = `df/onboard-${analysisSha8}`;
  const switchFlag = opts.force ? "-C" : "-c";
  await run("git", ["switch", switchFlag, branch], { cwd: rootDir });
  await applyPlan(rootDir, plan, opts.force !== undefined ? { mode: "apply", force: opts.force } : { mode: "apply" });

  const commitMsg =
    `feat: df onboard scaffold (${opts.canonicalName}) — cycle 15 Phase B\n\n` +
    `Tailored scaffold from template ${plan.templateRef}.\n` +
    `Plan summary: ${plan.summary}\n`;
  await run("git", ["add", "-A"], { cwd: rootDir });
  await run("git", ["commit", "-m", commitMsg], { cwd: rootDir });
  await run("git", ["push", "-u", "origin", branch], { cwd: rootDir });

  const title = `feat: df onboard scaffold for ${opts.canonicalName}`;
  const bodyLines: string[] = [];
  bodyLines.push("## Summary");
  bodyLines.push("");
  bodyLines.push(plan.summary);
  bodyLines.push("");
  bodyLines.push("## Per-file actions");
  bodyLines.push("");
  bodyLines.push("```json");
  bodyLines.push(JSON.stringify({
    templateRef: plan.templateRef,
    generatedAtIso: plan.generatedAtIso,
    files: plan.files.map((f) => ({ path: f.path, action: f.action, rationale: f.rationale })),
  }, null, 2));
  bodyLines.push("```");
  bodyLines.push("");
  bodyLines.push("Generated by `df onboard --pr` (Dark Factory CLI cycle 15 Phase B).");

  const { stdout } = await run("gh", [
    "pr", "create",
    "--title", title,
    "--body", bodyLines.join("\n"),
    "--base", defaultBranch,
    "--head", branch,
  ], { cwd: rootDir });
  const prUrl = stdout.trim().split(/\s+/).pop() ?? "";
  return { branch, prUrl };
}
