// df_critics_config MCP tool — cycle5 Phase 1 step 3d (closes step 3).
//
// Returns the parsed `.agent-review/config.json` narrowed to the three
// fields the cycle5 spec names: critics, aggregation, prompts.
//
// The cycle5 spec says: `df_critics_config | input {} | output
// { critics: [...], aggregation, prompts }`. "prompts" doesn't exist as
// a top-level field on the config schema (`AgentReviewConfig`); it's
// derived from `context.guidanceFiles` + `context.promptFragments` —
// the only fields that point at on-disk prompt material (paths
// relative to the repo root). We expose them as paths only, not as
// resolved file contents, to keep the tool's payload bounded; agents
// that need the contents can read the files separately or use the
// per-URI resource surface (step 4 of Phase 1).
//
// Side-effects: none. Read-only.

import { resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadAgentReviewConfig } from "../../policy/config.js";

export interface RegisterCriticsConfigToolOptions {
  cwd?: string;
}

export function registerCriticsConfigTool(
  server: McpServer,
  opts: RegisterCriticsConfigToolOptions = {},
): void {
  server.registerTool(
    "df_critics_config",
    {
      title: "Read critics config",
      description:
        "Read the parsed `.agent-review/config.json` for the current " +
        "repo. Returns the critic fleet, aggregation policy, and the " +
        "prompt-shaping context (guidance files + prompt fragments " +
        "paths). Read-only — does not modify any state.",
      inputSchema: {},
      outputSchema: {
        critics: z
          .array(z.record(z.unknown()))
          .describe(
            "Parsed critic entries from .agent-review/config.json.critics. " +
              "Each entry preserves the on-disk shape (id, name, adapter, " +
              "required, runtime, model, etc.); the typed shape lives in " +
              "@momentiq/dark-factory-schemas as CriticConfig.",
          ),
        aggregation: z
          .record(z.unknown())
          .describe(
            "Aggregation policy block (policy, blockingSeverities, " +
              "quorum). Typed shape: AggregationConfig.",
          ),
        prompts: z
          .object({
            guidanceFiles: z
              .array(z.string())
              .describe(
                "Paths (relative to repo root) of guidance files (e.g. " +
                  "CLAUDE.md) every critic loads as context.",
              ),
            promptFragments: z
              .array(z.string())
              .describe(
                "Paths of prompt-fragment files appended to each " +
                  "critic's system prompt. Conventionally under " +
                  "`.agent-review/prompts/`.",
              ),
          })
          .describe(
            "Curated subset of context.* — the prompt-shaping " +
              "configuration. (Cycle5 spec calls this 'prompts'; the " +
              "on-disk config groups it under context.)",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const cwd = resolve(opts.cwd ?? process.cwd());
      let loaded;
      try {
        loaded = await loadAgentReviewConfig({ cwd });
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `**df_critics_config**: failed to load .agent-review/config.json — ${
                  (err as Error).message
                } — fix: create .agent-review/config.json at repo root (see README).`,
            },
          ],
        };
      }
      const cfg = loaded.config;
      const structured = {
        critics: cfg.critics as unknown as Array<Record<string, unknown>>,
        aggregation: cfg.aggregation as unknown as Record<string, unknown>,
        prompts: {
          guidanceFiles: cfg.context.guidanceFiles,
          promptFragments: cfg.context.promptFragments,
        },
      };
      const summary = [
        `**df_critics_config**: ${cfg.critics.length} critic(s)`,
        `  aggregation: policy=${cfg.aggregation.policy}, quorum=${cfg.aggregation.quorum}, blocking=[${cfg.aggregation.blockingSeverities.join(", ")}]`,
        `  guidance files: ${cfg.context.guidanceFiles.length === 0 ? "(none)" : cfg.context.guidanceFiles.join(", ")}`,
        `  prompt fragments: ${cfg.context.promptFragments.length === 0 ? "(none)" : cfg.context.promptFragments.join(", ")}`,
      ].join("\n");
      return {
        structuredContent: structured as unknown as Record<string, unknown>,
        content: [{ type: "text", text: summary }],
      };
    },
  );
}
