// `df onboard` — cycles 15 Phase A (analysis) + Phase B (LLM tailoring) +
// Phase C (deterministic seeders, merged via `cmdOnboard`).
//
// Two exported entry points:
//
// - **`cmdOnboard(opts)`** — the orchestrator. Runs the pipeline
//   `analyze → generatePlan (Phase B) → runSeeders (Phase C) → mergeScaffoldPlan`
//   and returns a typed result. The MCP `df_onboard` tool (Task 6) and the
//   sage3c reproduction harness (Task 5) call this directly.
// - **`cmdOnboardCli(rest, io)`** — the CLI shim. Parses argv, validates
//   credentials at the surface, delegates to `cmdOnboard`, then formats the
//   structured result for stdout/stderr per --json / --analysis-only / etc.
//
// Phase A surface (preserved): `df onboard --analysis-only [--json] [target]`.
// Phase B/C surface: `df onboard [--dry-run | --apply | --pr]
//   [--template <ref>] [--api-key <k>] [--model <id>] [--profile local|cloud]
//   [--include-runtime-infra] [--force] [--json] [target]`.
//
// Mode flags are mutually exclusive; default is --dry-run when none set.
// --include-runtime-infra is a loud rejection (deferred to v2).

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { analyze } from "../onboard/analyze.js";
import { loadTemplate } from "../onboard/template-loader.js";
import { generatePlan } from "../onboard/generate-plan.js";
import { applyPlan, ScaffoldApplyError } from "../onboard/apply-plan.js";
import { runPrMode, preflightPr, defaultRunner } from "../onboard/writers/pr-writer.js";
import { autoProfile } from "../onboard/auto-profile.js";
import { ALL_SEEDERS_DEFAULT, runSeeders } from "../onboard/seeders/index.js";
import {
  ScaffoldPlanSchema,
  type FilePlan,
  type ScaffoldPlan,
} from "../onboard/scaffold-schema.js";
import type { RepoAnalysis } from "../onboard/schema.js";

export interface OnboardIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

type Mode = "analysis-only" | "dry-run" | "apply" | "pr";

interface OnboardCliOptions {
  mode: Mode;
  template: string;
  apiKey?: string;
  modelId: string;
  profile?: "local" | "cloud";
  force: boolean;
  json: boolean;
  targetDir: string;
}

/**
 * Options for the `cmdOnboard` orchestrator. The MCP tool, the sage3c
 * harness, and the CLI shim all pass through this shape — the orchestrator
 * is the single boundary between argv-handling and pipeline execution.
 */
export interface CmdOnboardOptions {
  target: string;
  mode: Mode;
  json?: boolean;
  /** Template ref override; defaults to the sage-blueprint @latest pin. */
  templateRef?: string;
  /** Anthropic API key for Phase B. Falls through to ANTHROPIC_API_KEY env. */
  apiKey?: string;
  /** LLM model id. Defaults to {@link DEFAULT_MODEL}. */
  modelId?: string;
  /**
   * Explicit critic profile override. When unset, `cmdOnboard` calls Phase B's
   * `autoProfile(analysis)` to derive it. Plumbs through to the agent-review
   * config seeder (Task 3.6) so the emitted `.agent-review/config.json`
   * matches the resolved profile.
   */
  profile?: "local" | "cloud";
  /**
   * Force overwrite of existing scaffolded files (apply mode) AND force-
   * recreate the PR branch (`git switch -C` vs `-c`, pr mode). Surfaced as
   * the `--force` CLI flag at the command-parser boundary.
   */
  force?: boolean;
}

export interface CmdOnboardAnalysisResult {
  analysis: RepoAnalysis;
}

export interface CmdOnboardPlanResult {
  analysis: RepoAnalysis;
  plan: ScaffoldPlan;
  /** Present when mode is "pr"; null otherwise. */
  branchName: string | null;
  /** True when mode is "apply" or "pr" (the working tree was written). */
  applied: boolean;
}

const DEFAULT_TEMPLATE = "gh:momentiq-ai/sage-blueprint@latest";
const DEFAULT_MODEL = "claude-3-7-sonnet-latest";

const HELP = [
  "df onboard — Cycle 15: deterministic analyzer (Phase A) + LLM-tailored scaffolding (Phase B) + deterministic seeders (Phase C).",
  "",
  "Usage:",
  "  df onboard [--analysis-only | --dry-run | --apply | --pr] [target-dir]",
  "             [--template <ref>] [--api-key <k>] [--model <id>]",
  "             [--profile local|cloud] [--force] [--json]",
  "",
  "Modes (mutually exclusive; default --dry-run):",
  "  --analysis-only   Phase A only — runs the Stage A scanner, emits RepoAnalysis.",
  "  --dry-run         Render the tailored ScaffoldPlan as a diff preview (no writes).",
  "  --apply           Write the tailored scaffold to the target directory.",
  "  --pr              Branch + commit + open a PR via gh CLI.",
  "",
  "Stage B/C flags (apply / pr / dry-run):",
  "  --template <ref>          Template source. Default: " + DEFAULT_TEMPLATE,
  "                            Ref shape: gh:<owner>/<repo>@<sha|tag|branch|latest>",
  "                                       file:///<abs-path>@<ref>",
  "  --api-key <key>           Anthropic API key. Defaults to ANTHROPIC_API_KEY env.",
  "  --model <id>              LLM model id. Default: " + DEFAULT_MODEL,
  "  --profile local|cloud     Critic profile for the generated .agent-review/config.json.",
  "                            Default: auto-detect (cloud if DF gate already present).",
  "  --force                   On --apply, overwrite existing emit-targets without prompting;",
  "                            on --pr, recreate the df/onboard-<sha8> branch (-C vs -c).",
  "  --json                    JSON output. With --analysis-only: RepoAnalysis.",
  "                            With --dry-run: merged ScaffoldPlan (Phase B + Phase C seeders).",
  "",
  "Rejected:",
  "  --include-runtime-infra   Deferred to v2 (Cycle 15 D5: outside the agent-context-set bar).",
  "",
  "Exit codes:",
  "  0  success",
  "  1  runtime failure (missing API key, write error, gh-auth missing, etc.)",
  "  2  usage error",
  "",
].join("\n");

function parseOnboardArgs(rest: string[]): OnboardCliOptions | { error: string } {
  let analysisOnly = false, dryRun = false, apply = false, pr = false;
  let json = false, force = false, includeRuntimeInfra = false;
  let template = DEFAULT_TEMPLATE;
  let apiKey: string | undefined;
  let modelId = DEFAULT_MODEL;
  let profile: "local" | "cloud" | undefined;
  let targetDir: string | null = null;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--analysis-only") { analysisOnly = true; continue; }
    if (a === "--dry-run") { dryRun = true; continue; }
    if (a === "--apply") { apply = true; continue; }
    if (a === "--pr") { pr = true; continue; }
    if (a === "--json") { json = true; continue; }
    if (a === "--force") { force = true; continue; }
    if (a === "--include-runtime-infra") { includeRuntimeInfra = true; continue; }
    if (a === "--template") { template = rest[++i] ?? ""; continue; }
    if (a === "--api-key") { apiKey = rest[++i]; continue; }
    if (a === "--model") { modelId = rest[++i] ?? DEFAULT_MODEL; continue; }
    if (a === "--profile") {
      const v = rest[++i];
      if (v !== "local" && v !== "cloud") return { error: `--profile must be local|cloud, got "${v}"` };
      profile = v;
      continue;
    }
    if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
    if (targetDir !== null) return { error: `unexpected positional arg: ${a}` };
    targetDir = a;
  }

  if (includeRuntimeInfra) {
    return {
      error: "--include-runtime-infra is deferred to v2 (Cycle 15 D5: " +
        "Generating runtime infrastructure (Terraform, Helm) is outside the agent-context-set bar).",
    };
  }

  const modes = [analysisOnly, dryRun, apply, pr].filter(Boolean).length;
  if (modes > 1) {
    return { error: "mode flags are mutually exclusive (pass one of --analysis-only / --dry-run / --apply / --pr)" };
  }
  const mode: Mode =
    analysisOnly ? "analysis-only" :
    apply ? "apply" :
    pr ? "pr" :
    "dry-run";

  const resolvedApiKey = apiKey ?? process.env["ANTHROPIC_API_KEY"];
  return {
    mode,
    template,
    ...(resolvedApiKey !== undefined ? { apiKey: resolvedApiKey } : {}),
    modelId,
    ...(profile !== undefined ? { profile } : {}),
    force,
    json,
    targetDir: targetDir ?? process.cwd(),
  };
}

function sha8(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

async function listExistingAdrs(target: string): Promise<string[]> {
  try {
    return (await readdir(join(target, "docs", "ADR"))).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
}

/**
 * Merge Phase B's LLM-emitted `ScaffoldPlan` with Phase C's seeder-emitted
 * `FilePlan[]`. Phase B wins on path collision — the LLM tailoring is
 * authoritative for any file the LLM chose to emit. The result is re-parsed
 * through `ScaffoldPlanSchema` as the structural canary (per-file 16KB cap,
 * 100-file cap, discriminated-union constraints) so caps applied to the
 * Phase B half don't silently leak.
 */
export function mergeScaffoldPlan(
  phaseBPlan: ScaffoldPlan,
  seederFiles: readonly FilePlan[],
): ScaffoldPlan {
  const phaseBPaths = new Set(phaseBPlan.files.map((f) => f.path));
  const nonColliding = seederFiles.filter((s) => !phaseBPaths.has(s.path));
  const merged: ScaffoldPlan = {
    ...phaseBPlan,
    files: [...phaseBPlan.files, ...nonColliding],
  };
  return ScaffoldPlanSchema.parse(merged);
}

/**
 * The orchestrator. Runs analyze → generatePlan → runSeeders →
 * mergeScaffoldPlan, then optionally writes to the working tree (apply) or
 * opens a PR (pr). Returns a structured result the CLI shim and MCP tool
 * both consume.
 *
 * Analysis-only mode skips Phase B + Phase C; it returns `{ analysis }`
 * alone for the no-LLM preview path.
 */
export async function cmdOnboard(
  opts: CmdOnboardOptions,
): Promise<CmdOnboardAnalysisResult | CmdOnboardPlanResult> {
  const analysis = await analyze(opts.target);

  if (opts.mode === "analysis-only") {
    return { analysis };
  }

  const profile = opts.profile ?? autoProfile(analysis);
  const template = await loadTemplate(opts.templateRef ?? DEFAULT_TEMPLATE);
  const phaseBPlan = await generatePlan(analysis, template, {
    modelId: opts.modelId ?? DEFAULT_MODEL,
    profile,
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });

  const existingAdrs = await listExistingAdrs(opts.target);
  const seederFiles = await runSeeders(
    { analysis, existingAdrs, now: new Date(), profile },
    ALL_SEEDERS_DEFAULT,
  );

  const plan = mergeScaffoldPlan(phaseBPlan, seederFiles);

  let branchName: string | null = null;
  let applied = false;
  const force = opts.force ?? false;

  if (opts.mode === "apply") {
    await applyPlan(opts.target, plan, { mode: "apply", force });
    applied = true;
  } else if (opts.mode === "pr") {
    const analysisSha8 = sha8(JSON.stringify(analysis));
    const r = await runPrMode(opts.target, plan, analysisSha8, {
      canonicalName: analysis.canonicalName || "unknown/unknown",
      defaultBranch: analysis.git.defaultBranch,
      force,
    });
    branchName = r.branch;
    applied = true;
  }
  // dry-run: orchestrator returns the merged plan; the CLI shim renders it.

  return { analysis, plan, branchName, applied };
}

export async function cmdOnboardCli(rest: string[], io: OnboardIo): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(HELP);
    return 0;
  }
  const parsed = parseOnboardArgs(rest);
  if ("error" in parsed) {
    io.stderr(`df onboard: ${parsed.error}\nRun \`df onboard --help\` for usage.\n`);
    return 2;
  }

  if (parsed.mode === "analysis-only") {
    try {
      const out = await cmdOnboard({ target: parsed.targetDir, mode: "analysis-only" });
      const analysisResult = out as CmdOnboardAnalysisResult;
      io.stdout(
        parsed.json
          ? JSON.stringify(analysisResult.analysis) + "\n"
          : renderAnalysisSummary(analysisResult.analysis),
      );
      return 0;
    } catch (e) {
      io.stderr(`df onboard: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  if (!parsed.apiKey || !parsed.apiKey.trim()) {
    io.stderr(
      "df onboard: ANTHROPIC_API_KEY is required for Phase B (--dry-run, --apply, --pr). " +
        "Set the env var (or pass --api-key) and re-run. Use --analysis-only for a no-LLM preview.\n",
    );
    return 1;
  }

  try {
    if (parsed.mode === "pr") {
      await preflightPr(defaultRunner, parsed.targetDir);
    }
    const out = await cmdOnboard({
      target: parsed.targetDir,
      mode: parsed.mode,
      templateRef: parsed.template,
      apiKey: parsed.apiKey,
      modelId: parsed.modelId,
      ...(parsed.profile !== undefined ? { profile: parsed.profile } : {}),
      force: parsed.force,
    });
    const planResult = out as CmdOnboardPlanResult;
    const plan = planResult.plan;

    if (parsed.mode === "dry-run") {
      if (parsed.json) {
        io.stdout(JSON.stringify(plan) + "\n");
      } else {
        const r = await applyPlan(parsed.targetDir, plan, { mode: "dry-run" });
        if (r.rendered) io.stdout(r.rendered);
      }
      return 0;
    }
    if (parsed.mode === "apply") {
      const profile = parsed.profile ?? autoProfile(planResult.analysis);
      io.stdout(`df onboard: applied ${plan.files.length} files (profile=${profile}).\n`);
      return 0;
    }
    // pr mode
    io.stdout(`df onboard: opened PR on branch ${planResult.branchName ?? "(unknown)"}\n`);
    return 0;
  } catch (e) {
    if (e instanceof ScaffoldApplyError) {
      io.stderr(`df onboard: ${e.message}\n`);
      return 1;
    }
    io.stderr(`df onboard: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

function renderAnalysisSummary(a: RepoAnalysis): string {
  const lines: string[] = [];
  lines.push(`Repo: ${a.canonicalName || "(unknown)"} at ${a.repoRoot}`);
  lines.push(
    `Stacks: ${a.stacks.map((s) => `${s.language}@${s.versionPin ?? "?"}`).join(", ") || "(none detected)"}`,
  );
  lines.push(`Services: ${a.services.length}`);
  lines.push(`Workflows: ${a.ci.workflows.length}; deploy: ${a.ci.deployStory?.target ?? "(none)"}`);
  const hooks = a.dfPresence.hooks ? "v" : "x";
  const config = a.dfPresence.configJson ? "v" : "x";
  const workflow = a.dfPresence.prWorkflow ? "v" : "x";
  lines.push(`DF gate: ${hooks}husky ${config}config ${workflow}workflow` +
    (a.dfPresence.cliPin ? ` (cli pin: ${a.dfPresence.cliPin})` : ""));
  lines.push(`Agent context set: ${a.docs.agentContextSetPresent ? "present" : "MISSING (df onboard target)"}`);
  if (a.analyzerErrors.length > 0) {
    lines.push(`Analyzer errors: ${a.analyzerErrors.length}`);
    for (const e of a.analyzerErrors) lines.push(`  - ${e.name}: ${e.error}`);
  }
  return lines.join("\n") + "\n";
}
