// packages/cli/src/onboard/seeders/adr.ts
//
// ADR seeder — cycle 15 Phase C Task 1.
//
// Per-decision deterministic ADR renderer. Consumes the Phase A `RepoAnalysis`
// `decisions[]` array and emits one ADR markdown file per entry. Filename:
// `docs/ADR/YYYY-NN-<slug>.md` (per cycle 15 Phase C plan Decision #2):
//   - YYYY: current year (from injected `now`).
//   - NN: auto-incremented from the highest existing ADR with the same year
//     prefix under `docs/ADR/`. Empty target → 01.
//   - <slug>: kebab-cased decision title.
//
// Slug collision (same year, same slug already present) → skip entry with
// `adr_already_exists` rationale (no overwrite). Per-surface rationale +
// consequences are interpolated from typed bindings.
//
// NO LLM here — pure string templating against the Stage A facts. The maintainer
// expands each rendered ADR by hand after Phase C apply.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { Decision, RepoAnalysis } from "../schema.js";
import type { FilePlan, Seeder, SeederInput } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Template lives flat alongside the seeder (per Phase C plan deliverable list);
// `templates/` subdirectory referenced in the plan's verbatim code block is a
// plan-internal drift — the deliverable inventory wins.
const TEMPLATE_PATH = resolve(HERE, "adr.md.tmpl");

const RATIONALE_TEMPLATES: Record<Decision["surface"], string> = {
  "test-framework":
    "This repo uses {test_runner_name} (pinned at {test_runner_version} per {evidence_path}) as the test framework. " +
    "New tests should be written against {test_runner_name}'s API; integration tests follow the same harness convention.",
  "deploy-target":
    "This repo deploys via {target_name} ({command}, configured in {workflow_path}). " +
    "New deploy-affecting changes update the {target_name} configuration; agents should NOT introduce parallel deploy mechanisms.",
  "auth-model":
    "This repo authenticates users via {auth_provider_name} (per direct dependency surfaced in {evidence_path}). " +
    "New auth-touching code defers to the provider's SDK; do not roll custom auth.",
  stack:
    "This repo's stack includes {framework_name} (surfaced in {evidence_path}). " +
    "New code follows {framework_name}'s conventions; framework-mismatched code is rejected by the critic.",
  "ci-platform":
    "CI runs on GitHub Actions ({workflow_count} workflows under .github/workflows/). " +
    "Changes to CI behavior land in the same workflow set; do not introduce a parallel CI substrate.",
  other:
    "This decision was surfaced from the deterministic repo analysis. See the cited evidence file for the original signal; " +
    "the ADR's prose is a starting point for the maintainer to expand.",
};

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function highestExistingNN(year: number, existingAdrs: readonly string[]): number {
  const prefix = `${year}-`;
  let max = 0;
  for (const name of existingAdrs) {
    if (!name.startsWith(prefix)) continue;
    const nn = parseInt(name.slice(prefix.length, prefix.length + 2), 10);
    if (Number.isInteger(nn) && nn > max) max = nn;
  }
  return max;
}

function existingSlugs(year: number, existingAdrs: readonly string[]): Set<string> {
  const prefix = `${year}-`;
  const slugs = new Set<string>();
  for (const name of existingAdrs) {
    if (!name.startsWith(prefix)) continue;
    // Strip "YYYY-NN-" (8 chars) and the trailing ".md" if present.
    const rest = name.slice(prefix.length + 3);
    const slug = rest.endsWith(".md") ? rest.slice(0, -3) : rest;
    if (slug.length > 0) slugs.add(slug);
  }
  return slugs;
}

function applyTemplate(template: string, bindings: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (full, k: string) =>
    Object.prototype.hasOwnProperty.call(bindings, k) ? bindings[k]! : full,
  );
}

function bindRationale(d: Decision, analysis: RepoAnalysis): Record<string, string> {
  const evidence_path = d.evidence[0] ?? "(unknown)";
  switch (d.surface) {
    case "test-framework": {
      // Find the matching dep entry — first dep whose name appears in the title.
      const dep = analysis.dependencies.find((dep) =>
        d.title.toLowerCase().includes(dep.name.toLowerCase()),
      );
      const test_runner_name = dep?.name ?? d.title.split(" ")[0] ?? "the test framework";
      const test_runner_version = dep?.version ?? "(unpinned)";
      return { test_runner_name, test_runner_version, evidence_path };
    }
    case "deploy-target": {
      const ds = analysis.ci.deployStory;
      return {
        target_name: ds?.target ?? "the deploy target",
        command: ds?.command ?? "(see workflow)",
        workflow_path: ds?.workflowPath ?? evidence_path,
      };
    }
    case "auth-model": {
      const dep = analysis.dependencies.find((dep) =>
        d.title.toLowerCase().includes(dep.name.toLowerCase()),
      );
      return { auth_provider_name: dep?.name ?? "the auth provider", evidence_path };
    }
    case "stack": {
      const dep = analysis.dependencies.find((dep) =>
        d.title.toLowerCase().includes(dep.name.toLowerCase()),
      );
      return { framework_name: dep?.name ?? d.title, evidence_path };
    }
    case "ci-platform":
      return {
        workflow_count: String(analysis.ci.workflows.length),
        evidence_path,
      };
    case "other":
      return { evidence_path };
  }
}

function bindConsequences(d: Decision, analysis: RepoAnalysis): string {
  switch (d.surface) {
    case "test-framework": {
      const dep = analysis.dependencies.find((dep) =>
        d.title.toLowerCase().includes(dep.name.toLowerCase()),
      );
      if (!dep) return "Future changes to the test-framework choice require a new ADR superseding this one.";
      return (
        `Repo is pinned to \`${dep.name}@${dep.version}\`; future ${dep.name} upgrades change test-runner semantics ` +
        `(verify CI green on a representative PR before bumping). Cross-stack repos should add per-stack ADRs.`
      );
    }
    case "deploy-target":
      return (
        "Deploys are constrained to this target. Switching to a different deploy target (e.g. moving from Helm to Cloud Run) " +
        "requires a new ADR superseding this one, plus a CI workflow migration."
      );
    case "auth-model":
      return (
        "Auth-touching code is constrained to this provider's SDK. Changing providers requires a new ADR, a migration plan, " +
        "and a security review."
      );
    case "stack":
      return (
        "Stack choice constrains the framework conventions new code follows. The critic enforces stack-consistent patterns; " +
        "introducing a parallel stack requires an ADR and a clear boundary."
      );
    case "ci-platform":
      return (
        "CI substrate is fixed. New automation lands in the existing workflow set; introducing a parallel CI " +
        "(e.g. Buildkite alongside Actions) requires an ADR."
      );
    case "other":
      return "The maintainer should expand this section with the concrete trade-offs and follow-up work this decision implies.";
  }
}

function surfaceToScope(surface: Decision["surface"]): string {
  switch (surface) {
    case "test-framework":
      return "Test framework choice";
    case "deploy-target":
      return "Deploy target";
    case "auth-model":
      return "Auth model";
    case "stack":
      return "Stack choice";
    case "ci-platform":
      return "CI platform";
    case "other":
      return "Repo-specific decision";
  }
}

export const adrSeeder: Seeder = {
  name: "adr",
  async seed(input: SeederInput): Promise<FilePlan[]> {
    const { analysis, existingAdrs, now } = input;
    if (analysis.decisions.length === 0) return [];

    const year = now.getUTCFullYear();
    const date = now.toISOString().slice(0, 10);
    const template = await readFile(TEMPLATE_PATH, "utf8");
    let nn = highestExistingNN(year, existingAdrs);
    const slugsTaken = existingSlugs(year, existingAdrs);

    const deciders = analysis.canonicalName.includes("/")
      ? `@${analysis.canonicalName.split("/")[0]}-maintainers (TBD)`
      : "TBD";

    const out: FilePlan[] = [];
    for (const decision of analysis.decisions) {
      const slug = slugify(decision.title);
      if (slugsTaken.has(slug)) {
        // SkipFilePlan is .strict() in scaffold-schema and rejects tailored_content
        // (Phase B plan Decision: emit/merge require it, skip rejects it).
        out.push({
          path: `docs/ADR/${year}-${String(nn + 1).padStart(2, "0")}-${slug}.md`,
          action: "skip",
          rationale: `adr_already_exists: docs/ADR/<NN>-${slug}.md already present for ${year}; not overwriting.`,
        });
        continue;
      }
      nn += 1;
      slugsTaken.add(slug);
      const filename = `${year}-${String(nn).padStart(2, "0")}-${slug}.md`;

      const rationaleTemplate = RATIONALE_TEMPLATES[decision.surface];
      const rationaleBindings = bindRationale(decision, analysis);
      const rationale = applyTemplate(rationaleTemplate, rationaleBindings);

      const evidence_bullets =
        decision.evidence.length > 0
          ? decision.evidence.map((p) => `- \`${p}\``).join("\n")
          : "- (no evidence files recorded — see the maintainer note below)";

      const scope = surfaceToScope(decision.surface);

      const body = applyTemplate(template, {
        year: String(year),
        nn: String(nn).padStart(2, "0"),
        title: decision.title,
        date,
        deciders,
        scope,
        repo_root: analysis.repoRoot,
        evidence_bullets,
        rationale,
        consequences: bindConsequences(decision, analysis),
      });

      out.push({
        path: `docs/ADR/${filename}`,
        action: "emit",
        rationale: `Seeded from RepoAnalysis.decisions[] surface=${decision.surface}`,
        tailored_content: body,
      });
    }
    return out;
  },
};
