// df_skills_install + df_skills_list MCP tools — DFP #192.
//
// Parallel surface to the `df skills install / list` CLI subcommand.
// Same `installSkill` / `listBundledSkills` core powers both — the tool
// here only wraps the IO + adapts the result shape into MCP's structured
// content envelope.
//
// Tool shapes:
//
//   df_skills_install →
//     input  { skillName, all?, force?, targetDir? }
//     output { installed: [{ skillName, manifestVersion, configPath,
//                            configIsDefault, files: [...] , resolvedVariables: [...] }] }
//
//   df_skills_list →
//     input  {}
//     output { skills: [{ name, version, summary, originatingRepo? }] }
//
// Both tools default to the agent client's cwd (where `df mcp` was
// launched), matching every other tool in this catalog. Tests inject a
// fixture cwd via the cwd option.

import { resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  enabledSkillNames,
  loadDarkFactoryConfig,
} from "../../skills/config.js";
import {
  installSkill,
  KNOWN_SKILLS,
  listBundledSkills,
  type InstallResult,
} from "../../skills/install.js";

export interface RegisterSkillsToolsOptions {
  cwd?: string;
}

function renderInstallMarkdown(results: InstallResult[]): string {
  if (results.length === 0) {
    return `**df_skills_install**: no skills installed.`;
  }
  const lines: string[] = [];
  for (const r of results) {
    lines.push(
      `**df_skills_install**: ${r.skillName} v${r.manifestVersion} — ${r.files.length} file(s)`,
    );
    lines.push(
      `  config: ${r.configPath}${r.configIsDefault ? " (defaults — no darkfactory.yaml)" : ""}`,
    );
    for (const f of r.files) {
      if (f.action === "skipped") {
        lines.push(`  ! ${f.relTarget} — SKIPPED (${f.reason ?? "skipped"})`);
      } else {
        lines.push(`  - ${f.relTarget} — ${f.action}`);
      }
    }
  }
  return lines.join("\n");
}

export function registerSkillsTools(
  server: McpServer,
  opts: RegisterSkillsToolsOptions = {},
): void {
  server.registerTool(
    "df_skills_install",
    {
      title: "Install a bundled Dark Factory skill",
      description:
        "Render + install one (or all) bundled skill(s) into the consumer " +
        "repo's .claude/skills/<name>/ directory. The skill body templates " +
        "are rendered against the consumer's darkfactory.yaml (with sensible " +
        "defaults when keys are absent). The rendered files carry a GENERATED " +
        "header — a re-install with the same inputs is a no-op; a re-install " +
        "with different inputs overwrites; a re-install where the rendered " +
        "file has been hand-edited is SKIPPED unless force=true. " +
        `Bundled skills: ${KNOWN_SKILLS.join(", ")}.`,
      inputSchema: {
        skillName: z
          .string()
          .min(1)
          .optional()
          .describe(
            `Skill name to install. Required unless 'all' is true. One of: ${KNOWN_SKILLS.join(", ")}.`,
          ),
        all: z
          .boolean()
          .optional()
          .describe(
            "If true, install every skill declared `enabled: true` in darkfactory.yaml#skills. " +
              "Mutually exclusive with skillName.",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Overwrite hand-edited rendered files. Off by default — re-install " +
              "of a hand-edited file returns action=skipped instead.",
          ),
        targetDir: z
          .string()
          .optional()
          .describe(
            "Override the install location (default: <cwd>/.claude/skills/<name>/). " +
              "Tests pass a fixture dir; production callers omit this.",
          ),
      },
      outputSchema: {
        installed: z
          .array(
            z.object({
              skillName: z.string(),
              manifestVersion: z.string(),
              configPath: z.string(),
              configIsDefault: z.boolean(),
              resolvedVariables: z.array(
                z.object({ name: z.string(), value: z.string() }),
              ),
              files: z.array(
                z.object({
                  relTarget: z.string(),
                  absoluteTarget: z.string(),
                  action: z.enum(["created", "updated", "unchanged", "skipped"]),
                  reason: z.string().optional(),
                }),
              ),
            }),
          )
          .describe(
            "One result per installed skill. action='skipped' means the file " +
              "exists without the GENERATED marker and force was not set.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ skillName, all, force, targetDir }) => {
      const cwd = resolve(opts.cwd ?? process.cwd());
      if (all === true && skillName !== undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `**df_skills_install**: cannot pass both skillName and all=true.`,
            },
          ],
        };
      }
      if (all !== true && skillName === undefined) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `**df_skills_install**: skillName is required (or pass all=true).`,
            },
          ],
        };
      }
      let targetSkills: string[];
      if (all === true) {
        if (targetDir !== undefined) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `**df_skills_install**: all=true is incompatible with targetDir (bundled skills share target filenames like SKILL.md, so a single dir would overwrite). Install each skill separately, or omit targetDir to use the default <cwd>/.claude/skills/<name>/.`,
              },
            ],
          };
        }
        try {
          const loaded = loadDarkFactoryConfig(cwd);
          const enabled = enabledSkillNames(loaded.config);
          if (enabled.length === 0) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    `**df_skills_install**: all=true but no skills marked enabled: true in ${loaded.configPath}` +
                    `${loaded.isDefault ? " (no darkfactory.yaml present)" : ""}.`,
                },
              ],
            };
          }
          const unknown = enabled.filter((name) => !KNOWN_SKILLS.includes(name));
          if (unknown.length > 0) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `**df_skills_install**: all=true rejected — unknown skill name(s) in ${loaded.configPath}: ${unknown.join(", ")}. Known skills: ${KNOWN_SKILLS.join(", ")}.`,
                },
              ],
            };
          }
          targetSkills = enabled;
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `**df_skills_install**: failed to load darkfactory.yaml — ${(err as Error).message}`,
              },
            ],
          };
        }
      } else {
        targetSkills = [skillName as string];
      }

      const results: InstallResult[] = [];
      for (const name of targetSkills) {
        try {
          const installOpts: Parameters<typeof installSkill>[0] = {
            cwd,
            skillName: name,
            ...(force === true ? { force: true } : {}),
            ...(targetDir !== undefined ? { targetDir } : {}),
          };
          results.push(installSkill(installOpts));
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `**df_skills_install**: ${(err as Error).message}`,
              },
            ],
          };
        }
      }

      // Mirror the CLI's exit-code 3 contract: when ANY rendered file was
      // skipped (hand-edited, body-mismatch, or pre-template detection),
      // surface that as an MCP-level error so the agent caller does not
      // silently accept a partial install. The structuredContent still
      // carries the full per-file detail so the caller can decide whether
      // to retry with force=true.
      const hasSkipped = results.some((r) =>
        r.files.some((f) => f.action === "skipped"),
      );
      const summary = renderInstallMarkdown(results);
      const text = hasSkipped
        ? `${summary}\n\nOne or more files were skipped. Re-call with force=true to overwrite.`
        : summary;
      return {
        ...(hasSkipped ? { isError: true } : {}),
        structuredContent: { installed: results },
        content: [{ type: "text", text }],
      };
    },
  );

  server.registerTool(
    "df_skills_list",
    {
      title: "List bundled Dark Factory skills",
      description:
        "List every skill bundled with @momentiq/dark-factory-cli: name, " +
        "manifest version, summary, originating repo (when known). The " +
        "complementary action is df_skills_install.",
      inputSchema: {},
      outputSchema: {
        skills: z
          .array(
            z.object({
              name: z.string(),
              version: z.string(),
              summary: z.string(),
              originatingRepo: z.string().optional(),
            }),
          )
          .describe(
            "Sorted alphabetically by name. Empty when no skills are bundled.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const items = listBundledSkills();
      const lines: string[] = [
        `**df_skills_list**: ${items.length} bundled skill(s)`,
      ];
      for (const item of items) {
        lines.push(
          `  - ${item.name} v${item.version}${item.originatingRepo ? ` (origin: ${item.originatingRepo})` : ""}`,
        );
        lines.push(`    ${item.summary}`);
      }
      return {
        structuredContent: { skills: items },
        content: [
          { type: "text", text: lines.join("\n") },
        ],
      };
    },
  );
}
