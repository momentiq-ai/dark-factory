// packages/cli/src/onboard/analyzers/ci.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Analyzer } from "../analyzer.js";
import type { Workflow, DeployStory } from "../schema.js";

const DEPLOY_VERBS: Array<{ re: RegExp; target: DeployStory["target"] }> = [
  { re: /\bhelm\s+(upgrade|install)\b/, target: "helm" },
  { re: /\bgh\s+release\s+create\b/, target: "gh-release" },
  { re: /\bgcloud\s+run\s+deploy\b/, target: "gcloud-run" },
  { re: /\bgcloud\s+builds\s+submit\b/, target: "gcloud-run" },
  { re: /\baws\s+ecs\s+update-service\b/, target: "ecs" },
  { re: /\bvercel\s+deploy\b/, target: "vercel" },
  { re: /\bflyctl\s+deploy\b/, target: "fly" },
  { re: /\bkubectl\s+apply\b/, target: "kubernetes" },
];

export const ciAnalyzer: Analyzer = {
  name: "ci",
  async detect(rootDir) {
    const wfDir = join(rootDir, ".github", "workflows");
    let entries: string[];
    try {
      entries = (await readdir(wfDir)).filter(
        (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
      );
    } catch {
      return null;
    }
    if (entries.length === 0) return null;

    const workflows: Workflow[] = [];
    let deployStory: DeployStory | null = null;

    for (const name of entries) {
      const path = join(wfDir, name);
      const raw = await readFile(path, "utf8");
      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const p = parsed as Record<string, unknown>;
      const triggers = normalizeTriggers(p.on);
      const jobs = Object.keys(
        (p.jobs as Record<string, unknown> | undefined) ?? {},
      );
      const matrixDimensions = collectMatrixDims(p);
      workflows.push({
        name: typeof p.name === "string" ? p.name : name,
        path: `.github/workflows/${name}`,
        triggers,
        jobs,
        matrixDimensions,
      });
      if (!deployStory) {
        deployStory = findDeployCommand(p, `.github/workflows/${name}`);
      }
    }
    return { ci: { workflows, deployStory } };
  },
};

function normalizeTriggers(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on))
    return on.filter((x): x is string => typeof x === "string");
  if (on && typeof on === "object")
    return Object.keys(on as Record<string, unknown>);
  return [];
}

function collectMatrixDims(parsed: Record<string, unknown>): string[] {
  const dims = new Set<string>();
  const jobs = (parsed.jobs as Record<string, unknown> | undefined) ?? {};
  for (const job of Object.values(jobs)) {
    if (!job || typeof job !== "object") continue;
    const strategy = (job as Record<string, unknown>).strategy;
    if (!strategy || typeof strategy !== "object") continue;
    const matrix = (strategy as Record<string, unknown>).matrix;
    if (!matrix || typeof matrix !== "object") continue;
    for (const k of Object.keys(matrix as Record<string, unknown>)) {
      if (k !== "include" && k !== "exclude") dims.add(k);
    }
  }
  return [...dims];
}

function findDeployCommand(
  parsed: Record<string, unknown>,
  workflowPath: string,
): DeployStory | null {
  const jobs = (parsed.jobs as Record<string, unknown> | undefined) ?? {};
  for (const job of Object.values(jobs)) {
    if (!job || typeof job !== "object") continue;
    const steps = (job as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const run = (step as Record<string, unknown>).run;
      if (typeof run !== "string") continue;
      for (const line of run.split(/\n/)) {
        for (const { re, target } of DEPLOY_VERBS) {
          if (re.test(line))
            return { workflowPath, command: line.trim(), target };
        }
      }
    }
  }
  return null;
}
