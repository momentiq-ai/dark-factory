// `df onboard` — cycle 15 Phase A.
//
// Phase A surface: `df onboard --analysis-only [--json] [target-dir]`.
// Runs the deterministic Stage A scanner (no LLM) over the target directory
// and emits a bounded RepoAnalysis. With `--json`, writes the schema-validated
// JSON to stdout; without, writes a human summary. The non-analysis-only path
// is intentionally a hard error in Phase A — later phases add `--apply`,
// `--pr`, etc.

import { analyze } from "../onboard/analyze.js";
import type { RepoAnalysis } from "../onboard/schema.js";

export interface OnboardIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

interface OnboardOptions {
  analysisOnly: boolean;
  json: boolean;
  targetDir: string;
}

const HELP = [
  "df onboard — Phase A: deterministic repo analysis (no LLM).",
  "",
  "Usage:",
  "  df onboard --analysis-only [--json] [target-dir]",
  "",
  "Flags:",
  "  --analysis-only   Required in Phase A. Runs the Stage A scanner only.",
  "  --json            Write the schema-validated RepoAnalysis JSON to stdout.",
  "                    Without --json, writes a human summary.",
  "  --help, -h        Show this message.",
  "",
  "Positional:",
  "  target-dir        Directory to analyze (default: cwd).",
  "",
  "Exit codes:",
  "  0  success",
  "  1  analyzer failure (e.g. 16 KB budget exceeded)",
  "  2  usage error",
  "",
  "Cycle 15 Phase B will add --apply (LLM-tailored scaffold) and --pr",
  "(emit-and-open-PR). Phase A's surface is intentionally narrow.",
  "",
].join("\n");

function parseOnboardArgs(rest: string[]): OnboardOptions | { error: string } {
  let analysisOnly = false;
  let json = false;
  let targetDir: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--analysis-only") {
      analysisOnly = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a.startsWith("--")) {
      return { error: `unknown flag: ${a}` };
    }
    if (targetDir !== null) {
      return { error: `unexpected positional arg: ${a}` };
    }
    targetDir = a;
  }
  return {
    analysisOnly,
    json,
    targetDir: targetDir ?? process.cwd(),
  };
}

function renderHumanSummary(a: RepoAnalysis): string {
  const lines: string[] = [];
  lines.push(`Repo: ${a.canonicalName || "(unknown)"} at ${a.repoRoot}`);
  lines.push(
    `Stacks: ${
      a.stacks.map((s) => `${s.language}@${s.versionPin ?? "?"}`).join(", ") ||
      "(none detected)"
    }`,
  );
  lines.push(`Services: ${a.services.length}`);
  lines.push(
    `Workflows: ${a.ci.workflows.length}; deploy: ${
      a.ci.deployStory?.target ?? "(none)"
    }`,
  );
  const hooks = a.dfPresence.hooks ? "v" : "x";
  const config = a.dfPresence.configJson ? "v" : "x";
  const workflow = a.dfPresence.prWorkflow ? "v" : "x";
  lines.push(
    `DF gate: ${hooks}husky ${config}config ${workflow}workflow${
      a.dfPresence.cliPin ? ` (cli pin: ${a.dfPresence.cliPin})` : ""
    }`,
  );
  lines.push(
    `Agent context set: ${
      a.docs.agentContextSetPresent ? "present" : "MISSING (df onboard target)"
    }`,
  );
  if (a.analyzerErrors.length > 0) {
    lines.push(`Analyzer errors: ${a.analyzerErrors.length}`);
    for (const e of a.analyzerErrors) {
      lines.push(`  - ${e.name}: ${e.error}`);
    }
  }
  return lines.join("\n") + "\n";
}

export async function cmdOnboard(
  rest: string[],
  io: OnboardIo,
): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(HELP);
    return 0;
  }
  const parsed = parseOnboardArgs(rest);
  if ("error" in parsed) {
    io.stderr(`df onboard: ${parsed.error}\nRun \`df onboard --help\` for usage.\n`);
    return 2;
  }
  if (!parsed.analysisOnly) {
    io.stderr(
      "df onboard: Phase A only — pass --analysis-only (cycle 15 Phase B ships --apply/--pr).\n",
    );
    return 1;
  }
  try {
    const analysis = await analyze(parsed.targetDir);
    if (parsed.json) {
      io.stdout(JSON.stringify(analysis) + "\n");
    } else {
      io.stdout(renderHumanSummary(analysis));
    }
    return 0;
  } catch (e) {
    io.stderr(
      `df onboard: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }
}
