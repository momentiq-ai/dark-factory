// packages/cli/src/onboard/seeders/cycle1-bootstrap.ts
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoAnalysis } from "../schema.js";
import type { FilePlan, Seeder, SeederInput } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(HERE, "templates", "cycle1-bootstrap.md.tmpl");

function applyTemplate(template: string, bindings: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (full, k) => bindings[k] ?? full);
}

function repoName(analysis: RepoAnalysis): string {
  if (analysis.canonicalName.includes("/")) {
    return analysis.canonicalName.split("/")[1] ?? "unnamed-repo";
  }
  const b = basename(analysis.repoRoot);
  return b || "unnamed-repo";
}

function repoOwner(analysis: RepoAnalysis): string {
  if (analysis.canonicalName.includes("/")) {
    return analysis.canonicalName.split("/")[0] ?? "tbd";
  }
  return "tbd";
}

export const cycle1BootstrapSeeder: Seeder = {
  name: "cycle1-bootstrap",
  async seed(input: SeederInput): Promise<FilePlan[]> {
    const { analysis, now } = input;
    const template = await readFile(TEMPLATE_PATH, "utf8");
    const name = repoName(analysis);
    const owner = repoOwner(analysis);
    const date = now.toISOString().slice(0, 10);

    const stack_bullets = analysis.stacks.length > 0
      ? analysis.stacks
          .map((s) => `- **${s.language}** @ ${s.versionPin ?? "(unpinned)"} (\`${s.manifestPath}\`)`)
          .join("\n")
      : "- (no manifest-declared stacks detected — likely a docs-only or shell-script repo)";

    const services_bullets = analysis.services.length > 0
      ? analysis.services
          .map((s) => `- **${s.name}** at \`${s.path}\`${s.stack ? ` (${s.stack})` : ""}`)
          .join("\n")
      : "- (no services/ or apps/ directory — single-package repo)";

    const deploy_story_body = analysis.ci.deployStory
      ? `Deploys via **${analysis.ci.deployStory.target}** from \`${analysis.ci.deployStory.workflowPath}\`:\n\n` +
        "```\n" + analysis.ci.deployStory.command + "\n```\n\n" +
        "See the seeded runbook at `docs/runbooks/deploy.md` for the operational walk-through."
      : "(no deploy workflow detected — add one before standing up CD)";

    const present = (b: boolean): string => (b ? "present" : "missing");
    const df_presence_body = [
      `- \`.husky/\` hooks: **${present(analysis.dfPresence.hooks)}**`,
      `- \`.agent-review/config.json\`: **${present(analysis.dfPresence.configJson)}**`,
      `- \`dark-factory-pr.yml\` workflow: **${present(analysis.dfPresence.prWorkflow)}**`,
      `- \`@momentiq/dark-factory-cli\` pin: ${analysis.dfPresence.cliPin ? `**${analysis.dfPresence.cliPin}**` : "**unset**"}`,
    ].join("\n");

    const agent_context_body = analysis.docs.agentContextSetPresent
      ? "Already present — `df onboard` will only fill gaps, not overwrite existing files."
      : "**MISSING** — `df onboard` is producing the initial set as part of this cycle. " +
        "See the ADRs seeded under `docs/ADR/` for the per-decision context.";

    const body = applyTemplate(template, {
      repo_name: name,
      canonical_name: analysis.canonicalName || `(unknown)/${name}`,
      owner,
      date,
      stack_bullets,
      services_bullets,
      deploy_story_body,
      df_presence_body,
      agent_context_body,
    });

    return [{
      path: `docs/roadmap/cycles/cycle1-${name}-bootstrap.md`,
      action: "emit",
      rationale: "Seeded from RepoAnalysis (services + stacks + deploy story + DF posture)",
      tailored_content: body,
    }];
  },
};
