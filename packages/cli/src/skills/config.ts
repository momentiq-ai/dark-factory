// `darkfactory.yaml` — unified consumer config loader.
//
// The single config surface for all `df`-installed assets (skills today;
// future hooks/agents tomorrow). Lives at the consumer repo root as a
// plain YAML file. Avoids fragmenting per-asset config across multiple
// files (e.g. `.dark-factory/skills.json`, `.agent-review/extras.json`).
//
// Shape (all keys optional — every consumer of the config supplies
// defaults):
//
//   repo:
//     displayName: "Dark Factory Platform"
//     slug: "dark-factory-platform"
//     ownerRepo: "momentiq-ai/dark-factory-platform"
//   docs:
//     manifesto: "docs/PRINCIPLES.md"
//     adrDir: "docs/ADR"
//     cycleDocsDir: "docs/roadmap/cycles"
//     rfcDir: "docs/rfcs"
//     prdDir: "docs/prds"
//   agents:
//     chiefEngineer: ".claude/agents/chief-engineer.md"
//   qualityGates:
//     - "make quality-gates"
//   qualityGatesExtras:
//     apiTypes: "make generate-api-types"
//   worktreeRoot: ".claude/worktrees"
//   agentCommitterOrg: "momentiq"
//   skills:
//     chief-engineer-review:
//       enabled: true
//     chief-engineer-blitz:
//       enabled: true
//
// Backed by the existing `yaml` workspace dep (already required by other
// CLI surfaces); zod validates the shape so a malformed config fails closed
// at load time with a useful error.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CONFIG_FILENAME = "darkfactory.yaml";

const repoSchema = z
  .object({
    displayName: z.string().optional(),
    slug: z.string().optional(),
    ownerRepo: z.string().optional(),
  })
  .partial()
  .optional();

const docsSchema = z
  .object({
    manifesto: z.string().optional(),
    adrDir: z.string().optional(),
    cycleDocsDir: z.string().optional(),
    rfcDir: z.string().optional(),
    prdDir: z.string().optional(),
  })
  .partial()
  .optional();

const agentsSchema = z
  .object({
    chiefEngineer: z.string().optional(),
  })
  .partial()
  .optional();

const skillEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .partial();

export const DarkFactoryConfigSchema = z
  .object({
    repo: repoSchema,
    docs: docsSchema,
    agents: agentsSchema,
    qualityGates: z.array(z.string()).optional(),
    qualityGatesExtras: z
      .object({
        apiTypes: z.string().optional(),
      })
      .partial()
      .optional(),
    worktreeRoot: z.string().optional(),
    agentCommitterOrg: z.string().optional(),
    skills: z.record(skillEntrySchema).optional(),
  })
  .strict();

export type DarkFactoryConfig = z.infer<typeof DarkFactoryConfigSchema>;

export interface LoadedDarkFactoryConfig {
  readonly config: DarkFactoryConfig;
  readonly configPath: string;
  /**
   * True when the consumer has no `darkfactory.yaml` at the repo root and
   * the renderer falls back to manifest defaults entirely. Callers may
   * surface a hint to create one.
   */
  readonly isDefault: boolean;
}

/**
 * Locate + parse `darkfactory.yaml` at `repoRoot`. Returns a defaulted
 * empty config when the file does not exist (so callers can render skills
 * against pure manifest defaults without special-casing the missing file).
 * Throws on parse / schema errors — those are explicit consumer mistakes
 * the install should fail closed on.
 */
export function loadDarkFactoryConfig(
  repoRoot: string,
): LoadedDarkFactoryConfig {
  const configPath = resolve(repoRoot, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return {
      config: DarkFactoryConfigSchema.parse({}),
      configPath,
      isDefault: true,
    };
  }
  const raw = readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `${CONFIG_FILENAME}: YAML parse error — ${(err as Error).message}`,
    );
  }
  // Empty file → empty object (yaml parser returns null for a file
  // containing only comments / whitespace; treat that as the empty config).
  const candidate = parsed === null || parsed === undefined ? {} : parsed;
  const result = DarkFactoryConfigSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `${CONFIG_FILENAME}: schema validation failed:\n${issues}`,
    );
  }
  return { config: result.data, configPath, isDefault: false };
}

/**
 * Parse a git remote URL into `<owner>/<repo>`. Handles both the SSH
 * shorthand (`git@github.com:owner/repo[.git]`) and the HTTPS form
 * (`https://github.com/owner/repo[.git]`). Returns null when neither
 * shape matches — we don't want to populate `OWNER_REPO` from a URL we
 * couldn't confidently parse.
 */
export function parseGitRemoteOwnerRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  // SSH: git@host:owner/repo[.git]
  const ssh = trimmed.match(/^[^@]+@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  // HTTPS/HTTP: https://host[:port]/owner/repo[.git]
  const https = trimmed.match(
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

/**
 * Best-effort inference of `<owner>/<repo>` from the consumer's
 * `origin` git remote. Returns null when the repo is not a git checkout,
 * has no origin, or origin has an unparseable URL. Never throws — the
 * caller treats null as "no inference available, fall back to manifest
 * default".
 */
export function inferGitOriginOwnerRepo(repoRoot: string): string | null {
  let url: string;
  try {
    url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  if (url.length === 0) return null;
  return parseGitRemoteOwnerRepo(url);
}

export interface ResolveSkillOverridesOptions {
  readonly config: DarkFactoryConfig;
  /**
   * Consumer repo root. When provided, `OWNER_REPO` / `REPO_SLUG` fall back
   * to git-remote inference when the yaml does not provide them. Omit in
   * unit tests that want pure-config behavior.
   */
  readonly repoRoot?: string;
}

/**
 * Resolve the install-time variable overrides for one skill, given the
 * loaded consumer config. The output is the `overrides` arg to
 * `renderTemplateBody` — a map from variable name to value (scalar string)
 * or values (string[] for kind:"list").
 *
 * Precedence for `OWNER_REPO` / `REPO_SLUG`:
 *   1. yaml `repo.ownerRepo` / `repo.slug` (explicit; wins)
 *   2. git remote inference from `repoRoot` (when supplied)
 *   3. manifest default (renderer falls back when this map omits the key)
 *
 * Variable→config-key mapping is hard-coded here because there is exactly
 * one consumer-config schema. A generic mapping system is not worth the
 * indirection at this size.
 */
export function resolveSkillOverrides(
  options: ResolveSkillOverridesOptions,
): Record<string, string | string[]> {
  const { config, repoRoot } = options;
  const overrides: Record<string, string | string[]> = {};
  if (config.repo?.displayName !== undefined) {
    overrides.REPO_NAME = config.repo.displayName;
  }
  if (config.repo?.slug !== undefined) {
    overrides.REPO_SLUG = config.repo.slug;
  }
  if (config.repo?.ownerRepo !== undefined) {
    overrides.OWNER_REPO = config.repo.ownerRepo;
  }
  if (
    (overrides.OWNER_REPO === undefined || overrides.REPO_SLUG === undefined) &&
    repoRoot !== undefined
  ) {
    const inferred = inferGitOriginOwnerRepo(repoRoot);
    if (inferred !== null) {
      const slashIndex = inferred.indexOf("/");
      if (overrides.OWNER_REPO === undefined) {
        overrides.OWNER_REPO = inferred;
      }
      if (overrides.REPO_SLUG === undefined && slashIndex > 0) {
        overrides.REPO_SLUG = inferred.slice(slashIndex + 1);
      }
    }
  }
  if (config.docs?.manifesto !== undefined) {
    overrides.MANIFESTO_PATH = config.docs.manifesto;
  }
  if (config.docs?.adrDir !== undefined) {
    overrides.ADR_DIR = config.docs.adrDir;
  }
  if (config.docs?.cycleDocsDir !== undefined) {
    overrides.CYCLE_DOCS_DIR = config.docs.cycleDocsDir;
  }
  if (config.docs?.rfcDir !== undefined) {
    overrides.RFC_DIR = config.docs.rfcDir;
  }
  if (config.docs?.prdDir !== undefined) {
    overrides.PRD_DIR = config.docs.prdDir;
  }
  if (config.agents?.chiefEngineer !== undefined) {
    overrides.CE_AGENT_PATH = config.agents.chiefEngineer;
  }
  if (config.qualityGates !== undefined && config.qualityGates.length > 0) {
    overrides.QUALITY_GATE_TARGETS = config.qualityGates;
  }
  if (config.qualityGatesExtras?.apiTypes !== undefined) {
    overrides.API_TYPES_TARGET = config.qualityGatesExtras.apiTypes;
  }
  if (config.worktreeRoot !== undefined) {
    overrides.WORKTREE_ROOT = config.worktreeRoot;
  }
  if (config.agentCommitterOrg !== undefined) {
    overrides.AGENT_COMMITTER_ORG = config.agentCommitterOrg;
  }
  return overrides;
}

/**
 * Returns the list of skills the consumer has marked `enabled: true` in
 * `darkfactory.yaml#skills`. Used by `df skills install --all`.
 */
export function enabledSkillNames(config: DarkFactoryConfig): string[] {
  if (!config.skills) return [];
  return Object.entries(config.skills)
    .filter(([, entry]) => entry.enabled === true)
    .map(([name]) => name);
}
