// packages/cli/src/onboard/seeders/runbook.ts
//
// Runbook seeder — cycle 15 Phase C Task 3.
//
// Deterministic emitter that produces `docs/runbooks/RUNBOOK-<workflow>.md`
// files per deploy-pattern CI workflow detected in `analysis.ci.workflows[]`,
// capped at MAX_RUNBOOKS total. The workflow that produced
// `analysis.ci.deployStory` gets the verbatim deploy command rendered into
// its Triggering section (Phase C exit criterion 3 — at least one runbook
// body contains a verbatim line from a CI workflow's `run:`).
//
// `Seeder` / `SeederInput` are declared inline here for Task 3 self-
// containment; Task 3.5 (seeder orchestrator) will surface them from
// `./index.ts` and the seeders will import them from there.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FilePlan } from "../scaffold-schema.js";
import type { RepoAnalysis } from "../schema.js";

export interface SeederInput {
  analysis: RepoAnalysis;
  existingAdrs: string[];
  now: Date;
}

export interface Seeder {
  name: string;
  seed(input: SeederInput): Promise<FilePlan[]>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
// Templates live under `templates/` (plan-aligned, shared with adr + cycle1-bootstrap).
const TEMPLATE_PATH = resolve(HERE, "templates", "runbook.md.tmpl");

const DEPLOY_NAME_REGEX = /deploy|release|publish|promote/i;
const MAX_RUNBOOKS = 5;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function applyTemplate(template: string, bindings: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (full, k) => bindings[k] ?? full);
}

export const runbookSeeder: Seeder = {
  name: "runbook",
  async seed(input: SeederInput): Promise<FilePlan[]> {
    const { analysis } = input;
    const matching = analysis.ci.workflows.filter((w) => DEPLOY_NAME_REGEX.test(w.name));
    if (matching.length === 0) return [];

    const template = await readFile(TEMPLATE_PATH, "utf8");
    const capped = matching.slice(0, MAX_RUNBOOKS);
    const out: FilePlan[] = [];
    const seenSlugs = new Set<string>();

    for (const w of capped) {
      const slug = slugify(w.name);
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);

      const isPrimaryDeploy = analysis.ci.deployStory?.workflowPath === w.path;
      const triggers_note = w.triggers.length > 0
        ? ` — triggered by \`${w.triggers.join("\`, \`")}\``
        : "";

      const triggering_body = isPrimaryDeploy && analysis.ci.deployStory
        ? `The workflow runs the following command (captured verbatim from \`${w.path}\`):\n\n` +
          "```\n" + analysis.ci.deployStory.command + "\n```\n\n" +
          "To trigger manually outside the workflow's normal triggers, use `gh workflow run`."
        : `See the workflow file at \`${w.path}\` for the trigger conditions and steps. ` +
          "Manual trigger: `gh workflow run`.";

      const verifying_body =
        "After the workflow completes, verify:\n\n" +
        "- Workflow run status is success (`gh run list --workflow=" + w.path + " --limit=1`).\n" +
        "- The deployed surface responds (smoke-test the user-facing endpoint).\n" +
        "- No alert sources have fired (link the dashboard here once it exists).";

      const rollback_body =
        "Rollback path (TODO: confirm this with the on-call rotation):\n\n" +
        "1. Identify the previous successful run's SHA: `gh run list --workflow=" + w.path + " --status=success --limit=2`.\n" +
        "2. Trigger this workflow against that SHA via `gh workflow run " + w.path + " --ref <sha>` (or the equivalent ref).\n" +
        "3. Confirm the rollback via the Verifying section above.";

      const body = applyTemplate(template, {
        workflow_name: w.name,
        workflow_path: w.path,
        workflow_triggers_note: triggers_note,
        triggering_body,
        verifying_body,
        rollback_body,
      });

      out.push({
        path: `docs/runbooks/RUNBOOK-${slug}.md`,
        action: "emit",
        rationale: `Seeded from CI workflow ${w.path} (matches deploy-pattern heuristic)`,
        tailored_content: body,
      });
    }

    return out;
  },
};
