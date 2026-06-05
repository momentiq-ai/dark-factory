// packages/cli/src/onboard/writers/dry-run-renderer.ts
//
// Render a human-readable preview of a ScaffoldPlan against a target dir.
// Shows per-file actions: emit (new or overwrite-diff), merge (additive
// append preview), skip (no-op). Colorized by default; honors NO_COLOR.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createPatch } from "diff";

import type { ScaffoldPlan, FilePlan } from "../scaffold-schema.js";

export interface DryRunOptions {
  color?: boolean; // default: !process.env.NO_COLOR
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

function colored(s: string, code: string, on: boolean): string {
  return on ? `${code}${s}${C.reset}` : s;
}

async function readIfExists(p: string): Promise<string | null> {
  try { return await readFile(p, "utf8"); } catch { return null; }
}

function diffBlock(path: string, existing: string, proposed: string, color: boolean): string {
  const patch = createPatch(path, existing, proposed, "existing", "proposed");
  if (!color) return patch;
  // Colorize +/- lines.
  return patch.split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return colored(line, C.bold, true);
    if (line.startsWith("+")) return colored(line, C.green, true);
    if (line.startsWith("-")) return colored(line, C.red, true);
    if (line.startsWith("@@")) return colored(line, C.cyan, true);
    return line;
  }).join("\n");
}

async function renderFile(rootDir: string, file: FilePlan, color: boolean): Promise<string> {
  const path = file.path;
  if (file.action === "skip") {
    return colored(`skip   ${path}`, C.yellow, color) +
      colored(`  — ${file.rationale}`, C.dim, color) + "\n";
  }
  if (file.action === "emit") {
    const existing = await readIfExists(join(rootDir, path));
    if (existing === null) {
      const header = colored(`emit   ${path}  (new file)`, C.green, color) + "\n";
      const body = file.tailored_content.split("\n").map((l) => `+ ${l}`).join("\n");
      return header + (color ? colored(body, C.green, true) : body) + "\n";
    }
    const header = colored(`emit   ${path}  (overwrite — diff below)`, C.bold, color) + "\n";
    return header + diffBlock(path, existing, file.tailored_content, color) + "\n";
  }
  // merge
  const existing = await readIfExists(join(rootDir, path));
  if (existing === null) {
    const header = colored(`merge  ${path}  (target absent — falling back to emit)`, C.yellow, color) + "\n";
    return header + (color ? colored(file.tailored_content, C.green, true) : file.tailored_content) + "\n";
  }
  const header = colored(`merge  ${path}  (additive append)`, C.bold, color) + "\n";
  const body = file.tailored_content.split("\n").map((l) => `+ ${l}`).join("\n");
  return header + (color ? colored(body, C.green, true) : body) + "\n";
}

export async function renderDryRun(
  rootDir: string,
  plan: ScaffoldPlan,
  opts: DryRunOptions = {},
): Promise<string> {
  const color = opts.color ?? (process.env["NO_COLOR"] === undefined || process.env["NO_COLOR"] === "");
  const lines: string[] = [];
  lines.push(colored(`# df onboard — dry-run preview`, C.bold, color));
  lines.push(`# template: ${plan.templateRef}`);
  lines.push(`# generated: ${plan.generatedAtIso}`);
  lines.push(`# files: ${plan.files.length}`);
  lines.push("");
  for (const file of plan.files) {
    lines.push(await renderFile(rootDir, file, color));
  }
  lines.push("");
  lines.push(colored("Summary: ", C.bold, color) + plan.summary);
  lines.push(colored(
    "Dry-run only — pass --apply to write, --pr to open a PR.",
    C.dim, color,
  ));
  return lines.join("\n") + "\n";
}
