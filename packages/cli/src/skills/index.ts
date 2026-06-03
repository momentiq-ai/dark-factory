// Public exports for the `skills` module — consumed by:
//   - `src/cli.ts` (the `df skills install/list` CLI surface)
//   - `src/mcp/tools/skills-install.ts` (the parallel MCP tool surface)
//   - `src/index.ts` (the library export for downstream consumers)

export {
  installSkill,
  listBundledSkills,
  resolveSkillsRoot,
  KNOWN_SKILLS,
  type InstallOptions,
  type InstallResult,
  type InstalledFile,
  type ListedSkill,
} from "./install.js";

export {
  loadDarkFactoryConfig,
  resolveSkillOverrides,
  enabledSkillNames,
  inferGitOriginOwnerRepo,
  parseGitRemoteOwnerRepo,
  DarkFactoryConfigSchema,
  CONFIG_FILENAME,
  type DarkFactoryConfig,
  type LoadedDarkFactoryConfig,
  type ResolveSkillOverridesOptions,
} from "./config.js";

export {
  renderTemplateBody,
  extractReferencedVariables,
  type SkillManifest,
  type SkillVariableDef,
  type RenderResult,
  type RenderTemplateOptions,
  type VariableOverride,
} from "./template.js";
