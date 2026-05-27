// df_cycle_list + df_cycle_read MCP tools — cycle5 Phase 1 step 3a.
//
// Both tools target the MCP server's cwd: the agent client launches
// `df mcp` from the consumer repo's root, and we look up cycle docs
// relative to that root at `docs/roadmap/cycles/`.
//
// Spec output shapes (from docs/roadmap/cycles/cycle5-mcp-server.md):
//
//   df_cycle_list →
//     { cycles: [{ id, title, status, owner?, target? }] }
//
//   df_cycle_read →
//     { id, frontmatter, sections: { scope, exit_criteria, … } }
//
// The cycle doc says "df_cycle_read returns structured sections, not
// raw markdown." We honor that — frontmatter is parsed YAML, sections
// is a snake_case-keyed map of section body markdown. Nested headings
// (### / ####) stay inline inside their parent section.

import { resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  listCycleDocs,
  readCycleDoc,
  type CycleSummary,
  type ParsedCycleDoc,
} from "../cycle-doc/parser.js";

interface RegisterCycleToolsOptions {
  /**
   * Optional cwd override — used by tests to point at a fixture repo
   * root. Production code lets it default to `process.cwd()` so the
   * cycle docs come from wherever the MCP server was launched.
   */
  cwd?: string;
}

function resolveRoot(opts?: RegisterCycleToolsOptions): string {
  return resolve(opts?.cwd ?? process.cwd());
}

function renderListMarkdown(cycles: readonly CycleSummary[]): string {
  if (cycles.length === 0) {
    return "**df_cycle_list**: no cycle docs found under docs/roadmap/cycles/.";
  }
  const lines = cycles.map((c) => {
    const tail = [c.owner, c.target].filter(Boolean).join(" · ");
    return `  - ${c.id} [${c.status}] ${c.title}${tail ? ` — ${tail}` : ""}`;
  });
  return [`**df_cycle_list**: ${cycles.length} cycle doc(s)`, ...lines].join("\n");
}

function renderReadMarkdown(doc: ParsedCycleDoc | null, cycleId: string): string {
  if (!doc) {
    return `**df_cycle_read**: cycle "${cycleId}" not found under docs/roadmap/cycles/.`;
  }
  const sectionNames = Object.keys(doc.sections);
  const fm = doc.frontmatter as { title?: unknown; status?: unknown };
  const title = typeof fm.title === "string" ? fm.title : doc.id;
  const status = typeof fm.status === "string" ? fm.status : "unknown";
  return [
    `**df_cycle_read**: ${doc.id} [${status}] ${title}`,
    `  sections: ${sectionNames.length === 0 ? "(none)" : sectionNames.join(", ")}`,
  ].join("\n");
}

export function registerCycleTools(
  server: McpServer,
  opts: RegisterCycleToolsOptions = {},
): void {
  server.registerTool(
    "df_cycle_list",
    {
      title: "List cycle docs",
      description:
        "Enumerate cycle docs under `docs/roadmap/cycles/` for the " +
        "current repo. Returns one summary per file: id (e.g. " +
        "'cycle5'), title, status, owner (optional), target " +
        "(optional). Read-only — no filesystem writes.",
      inputSchema: {},
      outputSchema: {
        cycles: z
          .array(
            z.object({
              id: z
                .string()
                .describe("Stable cycle id (e.g. 'cycle5' or 'cycle331.6')."),
              title: z.string().describe("Cycle title from frontmatter."),
              status: z
                .string()
                .describe("Lifecycle state — typically 'draft' | 'active' | 'done' | 'abandoned'."),
              owner: z
                .string()
                .optional()
                .describe("Owner handle from frontmatter, when set."),
              target: z
                .string()
                .optional()
                .describe("Target date from frontmatter, when set."),
            }),
          )
          .describe("Sorted by cycle id (lexicographic on the filename)."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const root = resolveRoot(opts);
      const cycles = await listCycleDocs(root);
      return {
        structuredContent: { cycles } as unknown as Record<string, unknown>,
        content: [{ type: "text", text: renderListMarkdown(cycles) }],
      };
    },
  );

  server.registerTool(
    "df_cycle_read",
    {
      title: "Read a cycle doc",
      description:
        "Read a single cycle doc by id (e.g. 'cycle5'). Returns the " +
        "parsed YAML frontmatter and a map of h2 section names (lower " +
        "snake_case) → section body markdown. Nested headings (###+) " +
        "stay inline inside their parent section. Read-only.",
      inputSchema: {
        cycle_id: z
          .string()
          .min(1)
          .describe(
            "Cycle id as derived from the filename `cycleN[.M]-slug.md`. " +
              "Examples: 'cycle5', 'cycle331.6'.",
          ),
      },
      outputSchema: {
        id: z.string().describe("Echoed cycle id."),
        frontmatter: z
          .record(z.unknown())
          .describe(
            "Raw parsed YAML frontmatter — caller pulls out fields it cares about.",
          ),
        sections: z
          .record(z.string())
          .describe(
            "Map of section name (snake_case) → section body markdown. " +
              "Empty object when the cycle doc has no h2 sections.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ cycle_id }) => {
      const root = resolveRoot(opts);
      const doc = await readCycleDoc(root, cycle_id);
      if (!doc) {
        // Degenerate path — return isError=true so the client treats
        // it as a failed call rather than a malformed result.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: renderReadMarkdown(null, cycle_id),
            },
          ],
        };
      }
      const structured = {
        id: doc.id,
        frontmatter: doc.frontmatter,
        sections: doc.sections,
      };
      return {
        structuredContent: structured as unknown as Record<string, unknown>,
        content: [
          { type: "text", text: renderReadMarkdown(doc, cycle_id) },
        ],
      };
    },
  );
}
