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

// Composite-action deploys: the workflow IS the deploy, but it's a single
// `uses:` step (not a `run:` line). We recognize these by their `uses:`
// reference so deploy-named workflows without a verb-matching run line still
// surface a DeployStory. Order = most specific first.
const COMPOSITE_ACTION_DEPLOYS: RegExp[] = [
  /^googleapis\/release-please-action(@|$)/,
  /^google-github-actions\/release-please-action(@|$)/,
  /^amondnet\/vercel-action(@|$)/,
  /^superfly\/flyctl-actions(@|$)/,
  /^aws-actions\/amazon-ecs-deploy-task-definition(@|$)/,
  /^helm\/chart-releaser-action(@|$)/,
  /^actions\/deploy-pages(@|$)/,
];

// Deploy-name regex shared with the runbook seeder. Workflows whose name
// matches are eligible as the "primary deploy" workflow when no DEPLOY_VERB
// run line is found — falls back to firstRunCommand or first composite-action
// `uses:` step on those workflows.
const DEPLOY_NAME_REGEX = /deploy|release|publish|promote/i;

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
    // Parsed YAML kept paired with the Workflow entry so the deploy-story
    // resolution pass can pick freely from all workflows, not just the first
    // one in directory-iteration order. Without this we'd lose the ability
    // to skip a verb-less deploy-named workflow in favor of one whose
    // first-line `run:` actually matches DEPLOY_VERBS.
    const parsedByPath = new Map<string, Record<string, unknown>>();

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
      const workflowPath = `.github/workflows/${name}`;
      workflows.push({
        name: typeof p.name === "string" ? p.name : name,
        path: workflowPath,
        triggers,
        jobs,
        matrixDimensions,
        // Specifically extracts a TRUE single-line `run:` from the raw YAML
        // (e.g. `run: poetry install --no-root`) rather than the first line
        // of a multi-line `run: |` block. This matters because Phase C's
        // metric 4 validator extracts candidates via the same single-line
        // regex; embedding a multi-line block's inner line would not match
        // any validator candidate. Returns null if the workflow has only
        // multi-line `run: |` blocks or composite-action `uses:` steps.
        firstRunCommand: extractFirstSingleLineRunFromText(raw),
      });
      parsedByPath.set(workflowPath, p);
    }

    const deployStory = resolveDeployStory(workflows, parsedByPath);
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

// Extracts the first TRUE single-line `run:` command from raw YAML text
// (`run: <cmd>`), not the first line of a multi-line `run: |` block. The
// raw-text path is intentional: this value is consumed by the runbook
// seeder, and the metric 4 validator's candidate-line extractor uses the
// same `^\s*-?\s*run:\s*(.+)$` shape — extracting via the YAML AST would
// silently lose the single-vs-multiline distinction (after parsing, both
// forms yield the same `run` string).
//
// Returns null when every `run:` is a block scalar (`run: |`, `run: >`,
// `run: |-`, etc.) or the workflow has no `run:` steps at all.
function extractFirstSingleLineRunFromText(rawYaml: string): string | null {
  // Match `run: <cmd>` where <cmd> is on the same line (NOT a block scalar
  // marker like `|`, `|-`, `>`, `>-` optionally followed by whitespace).
  // Two forms: `- run: …` (step-list head) and bare `run: …` (rare).
  for (const line of rawYaml.split(/\r?\n/)) {
    const m =
      /^\s*-\s*run:\s+(\S.*)$/.exec(line) ?? /^\s*run:\s+(\S.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[1]?.trim();
    if (!cmd) continue;
    if (cmd === "|" || cmd === "|-" || cmd === ">" || cmd === ">-") continue;
    if (cmd.length <= 10) continue;
    return cmd;
  }
  return null;
}

// Resolves the deploy story across all workflows in a deterministic priority
// order so verb-less deploy-named workflows no longer shadow workflows that
// do have a verb match (the old single-pass loop in `detect()` returned the
// first match in directory order regardless of strength).
//
// Priority (highest first):
//   1. Any workflow with a DEPLOY_VERB match (helm/kubectl/gcloud/etc.).
//   2. Deploy-named workflows with a composite-action `uses:` step matching
//      COMPOSITE_ACTION_DEPLOYS (release-please-action, vercel-action, …).
//   3. Deploy-named workflows with a multi-line `run: |` block whose first
//      non-trivial line is a gitops marker (`git push`, `cp …`) — captures
//      sage3c's promote-to-prod pattern.
//   4. Deploy-named workflows with any non-null firstRunCommand.
//   5. null.
function resolveDeployStory(
  workflows: Workflow[],
  parsedByPath: Map<string, Record<string, unknown>>,
): DeployStory | null {
  // Pass 1: scan every workflow for a DEPLOY_VERB match.
  for (const w of workflows) {
    const parsed = parsedByPath.get(w.path);
    if (!parsed) continue;
    const verbHit = findDeployVerb(parsed, w.path);
    if (verbHit) return verbHit;
  }

  // Pass 2-4: only deploy-named workflows are eligible.
  const deployNamed = workflows.filter((w) => DEPLOY_NAME_REGEX.test(w.name));

  // Pass 2: composite-action `uses:` step.
  for (const w of deployNamed) {
    const parsed = parsedByPath.get(w.path);
    if (!parsed) continue;
    const compHit = findCompositeActionDeploy(parsed, w.path);
    if (compHit) return compHit;
  }

  // Pass 3 + 4 are fused: scan the deploy-named workflow's first job/step run
  // body for either a gitops marker (preferred — yields "gitops" target) or
  // a generic firstRunCommand fallback (yields "other").
  for (const w of deployNamed) {
    const parsed = parsedByPath.get(w.path);
    if (!parsed) continue;
    const firstRun = extractFirstRunLineFromAnyBlock(parsed);
    if (!firstRun) continue;
    const isGitops = /^(git\s+push|gh\s+api\s+repos.*dispatches|cp\s+.*values)/.test(
      firstRun,
    );
    return {
      workflowPath: w.path,
      command: firstRun,
      target: isGitops ? "gitops" : "other",
    };
  }

  return null;
}

function findDeployVerb(
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

function findCompositeActionDeploy(
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
      const uses = (step as Record<string, unknown>).uses;
      if (typeof uses !== "string") continue;
      for (const re of COMPOSITE_ACTION_DEPLOYS) {
        if (re.test(uses)) {
          return {
            workflowPath,
            command: uses.trim(),
            target: "composite-action",
          };
        }
      }
    }
  }
  return null;
}

function extractFirstRunLineFromAnyBlock(
  parsed: Record<string, unknown>,
): string | null {
  const jobs = (parsed.jobs as Record<string, unknown> | undefined) ?? {};
  for (const job of Object.values(jobs)) {
    if (!job || typeof job !== "object") continue;
    const steps = (job as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!step || typeof step !== "object") continue;
      const run = (step as Record<string, unknown>).run;
      if (typeof run !== "string") continue;
      for (const raw of run.split(/\n/)) {
        const line = raw.trim();
        if (line.length <= 10) continue;
        if (line.startsWith("#")) continue;
        return line;
      }
    }
  }
  return null;
}
