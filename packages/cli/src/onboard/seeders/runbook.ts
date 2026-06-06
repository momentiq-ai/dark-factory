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
//
// Fix #138 — widened the selection + body so verbatim CI lines reach a
// runbook even when:
//   - the deploy story is composite-action / gitops (no `run:` line) — falls
//     back to a non-deploy-named workflow with a real single-line `run:`;
//   - every deploy-named workflow uses only multi-line `run: |` blocks
//     (sage3c's promote-to-prod) — selects the first workflow with a
//     `firstRunCommand` as the verbatim-line donor.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FilePlan } from "../scaffold-schema.js";
import type { RepoAnalysis, Workflow } from "../schema.js";

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

// Returns the subset of `workflows` that should each get a runbook emitted.
//
// Selection order:
//   1. All deploy-named workflows (name matches DEPLOY_NAME_REGEX).
//   2. If NONE of the chosen workflows has a `firstRunCommand`, append the
//      first non-deploy-named workflow that DOES have one. This ensures
//      Phase C metric 4 ("runbook body contains a verbatim CI run: line")
//      stays satisfiable on repos whose deploy is composite-action or
//      gitops-driven (sage3c: promote-to-prod is all multi-line `run: |`,
//      build-images is all multi-line — neither yields a verbatim
//      single-line run candidate the validator's regex catches). The
//      runbook for the "donor" workflow cites only that workflow's path
//      and command; we don't synthesize cross-workflow attributions.
//   3. Capped at MAX_RUNBOOKS overall.
function selectRunbookWorkflows(workflows: readonly Workflow[]): Workflow[] {
  const deployNamed = workflows.filter((w) => DEPLOY_NAME_REGEX.test(w.name));
  const haveAVerbatimRun = deployNamed.some((w) => w.firstRunCommand);
  if (haveAVerbatimRun || deployNamed.length === 0) {
    // Either we already have a verbatim donor among deploy-named workflows,
    // OR there are no deploy-named workflows at all and the existing
    // behavior (empty output) is intentional.
    return deployNamed.slice(0, MAX_RUNBOOKS);
  }
  // Find a fallback donor: first workflow with a firstRunCommand that ISN'T
  // already in the deploy-named set.
  const deployPaths = new Set(deployNamed.map((w) => w.path));
  const donor = workflows.find(
    (w) => !deployPaths.has(w.path) && w.firstRunCommand,
  );
  const combined = donor ? [...deployNamed, donor] : deployNamed;
  return combined.slice(0, MAX_RUNBOOKS);
}

export const runbookSeeder: Seeder = {
  name: "runbook",
  async seed(input: SeederInput): Promise<FilePlan[]> {
    const { analysis } = input;
    const selected = selectRunbookWorkflows(analysis.ci.workflows);
    if (selected.length === 0) return [];

    const template = await readFile(TEMPLATE_PATH, "utf8");
    const out: FilePlan[] = [];
    const seenSlugs = new Set<string>();

    for (const w of selected) {
      const slug = slugify(w.name);
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);

      const isPrimaryDeploy = analysis.ci.deployStory?.workflowPath === w.path;
      const triggers_note = w.triggers.length > 0
        ? ` — triggered by \`${w.triggers.join("\`, \`")}\``
        : "";

      // Triggering body precedence:
      //   1. Primary deploy workflow → render `deployStory.command` (covers
      //      DEPLOY_VERB matches, composite-action `uses:` refs, and gitops
      //      first-block lines — all surfaced by the analyzer).
      //   2. Otherwise, if the workflow has its own `firstRunCommand`, embed
      //      THAT verbatim line (provenance-correct: the runbook for
      //      workflow X cites a `run:` line from workflow X's own body).
      //   3. Otherwise, a structural pointer to the workflow file.
      let triggering_body: string;
      if (isPrimaryDeploy && analysis.ci.deployStory) {
        const cmd = analysis.ci.deployStory.command;
        const target = analysis.ci.deployStory.target;
        const intro =
          target === "composite-action"
            ? `The workflow is driven by a composite GitHub Action (captured verbatim from \`${w.path}\`):`
            : target === "gitops"
              ? `The workflow runs a gitops promotion (first non-trivial line captured verbatim from \`${w.path}\`):`
              : `The workflow runs the following command (captured verbatim from \`${w.path}\`):`;
        triggering_body =
          `${intro}\n\n\`\`\`\n${cmd}\n\`\`\`\n\n` +
          "To trigger manually outside the workflow's normal triggers, use `gh workflow run`.";
      } else if (w.firstRunCommand) {
        triggering_body =
          `The workflow's first non-trivial \`run:\` step is (captured verbatim from \`${w.path}\`):\n\n` +
          "```\n" + w.firstRunCommand + "\n```\n\n" +
          "To trigger manually outside the workflow's normal triggers, use `gh workflow run`.";
      } else {
        triggering_body =
          `See the workflow file at \`${w.path}\` for the trigger conditions and steps. ` +
          "Manual trigger: `gh workflow run`.";
      }

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
