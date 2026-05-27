// df_adr_list + df_adr_read MCP tools — cycle5 Phase 1 step 3c.
//
// Both tools target the MCP server's cwd: ADRs live at
// `docs/ADR/*.md` relative to the consumer repo's root.
//
// Spec output shapes (from docs/roadmap/cycles/cycle5-mcp-server.md):
//
//   df_adr_list →
//     { adrs: [{ id, title, status, date }] }
//
//   df_adr_read →
//     { id, frontmatter, body, status, supersedes? }
//
// `frontmatter` here is the parsed bullet-metadata map (different
// from cycle docs, which use real YAML frontmatter). Keys are the
// bullet labels verbatim — "Status", "Date", "Deciders", "Scope",
// "Supersedes (in part)", etc. — so a client can render the same
// labels it sees in the markdown.
//
// `body` is the markdown after the metadata block (h2 + onward),
// preserved as-is. df_adr_read does NOT structure ADR sections the
// way df_cycle_read does — the cycle5 spec explicitly says cycle
// docs get a `sections` map and ADRs get a `body` blob. Different
// docs, different shapes.

import { resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  listAdrDocs,
  readAdrDoc,
  type AdrSummary,
  type ParsedAdrDoc,
} from "../adr/parser.js";

export interface RegisterAdrToolsOptions {
  cwd?: string;
}

function resolveRoot(opts?: RegisterAdrToolsOptions): string {
  return resolve(opts?.cwd ?? process.cwd());
}

function renderListMarkdown(adrs: readonly AdrSummary[]): string {
  if (adrs.length === 0) {
    return "**df_adr_list**: no ADRs under docs/ADR/.";
  }
  const lines = adrs.map((a) => `  - ${a.id} [${a.status}] ${a.title}${a.date ? ` (${a.date})` : ""}`);
  return [`**df_adr_list**: ${adrs.length} ADR(s)`, ...lines].join("\n");
}

function renderReadMarkdown(doc: ParsedAdrDoc | null, adrId: string): string {
  if (!doc) {
    return `**df_adr_read**: ADR "${adrId}" not found under docs/ADR/.`;
  }
  const title = doc.frontmatter.Title ?? doc.id;
  const tail = doc.supersedes ? ` · supersedes: ${doc.supersedes}` : "";
  return `**df_adr_read**: ${doc.id} [${doc.status}] ${title}${tail}`;
}

export function registerAdrTools(
  server: McpServer,
  opts: RegisterAdrToolsOptions = {},
): void {
  server.registerTool(
    "df_adr_list",
    {
      title: "List ADRs",
      description:
        "Enumerate Architecture Decision Records under `docs/ADR/` " +
        "for the current repo. Returns one summary per file: id " +
        "(filename basename), title (from h1, with 'ADR <prefix> — ' " +
        "stripped when present), status, date. Read-only.",
      inputSchema: {},
      outputSchema: {
        adrs: z.array(
          z.object({
            id: z
              .string()
              .describe(
                "Filename basename without `.md` — unique even when " +
                  "multiple ADRs share a date prefix.",
              ),
            title: z
              .string()
              .describe("Title from the h1, after the 'ADR <prefix> — ' separator."),
            status: z
              .string()
              .describe(
                "ADR status from the bullet metadata: typically " +
                  "'Accepted' | 'Proposed' | 'Superseded' | 'Deprecated'.",
              ),
            date: z
              .string()
              .describe("Date from the bullet metadata, YYYY-MM-DD."),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const root = resolveRoot(opts);
      const adrs = await listAdrDocs(root);
      return {
        structuredContent: { adrs } as unknown as Record<string, unknown>,
        content: [{ type: "text", text: renderListMarkdown(adrs) }],
      };
    },
  );

  server.registerTool(
    "df_adr_read",
    {
      title: "Read an ADR",
      description:
        "Read a single ADR by id. Returns the parsed bullet-metadata " +
        "(frontmatter), the body markdown (h2 + onward, unmodified), " +
        "the status, and the supersedes pointer when present. " +
        "Read-only.",
      inputSchema: {
        adr_id: z
          .string()
          .min(1)
          .describe(
            "ADR id — the filename basename without `.md`, e.g. " +
              "'2026-05-w1-w3-gate-migration'.",
          ),
      },
      outputSchema: {
        id: z.string().describe("Echoed ADR id."),
        frontmatter: z
          .record(z.string())
          .describe(
            "Bullet-metadata map. Keys are the bullet labels " +
              "verbatim — 'Status', 'Date', 'Deciders', 'Scope', etc.",
          ),
        body: z
          .string()
          .describe("Markdown body after the metadata block (h2 + onward)."),
        status: z
          .string()
          .describe("Convenience: pulled from frontmatter.Status."),
        supersedes: z
          .string()
          .optional()
          .describe(
            "Convenience: pulled from frontmatter.Supersedes or " +
              "frontmatter['Supersedes (in part)'] when either is " +
              "present. Omitted otherwise.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ adr_id }) => {
      const root = resolveRoot(opts);
      const doc = await readAdrDoc(root, adr_id);
      if (!doc) {
        return {
          isError: true,
          content: [
            { type: "text", text: renderReadMarkdown(null, adr_id) },
          ],
        };
      }
      const structured = {
        id: doc.id,
        frontmatter: doc.frontmatter,
        body: doc.body,
        status: doc.status,
        ...(doc.supersedes !== undefined ? { supersedes: doc.supersedes } : {}),
      };
      return {
        structuredContent: structured as unknown as Record<string, unknown>,
        content: [{ type: "text", text: renderReadMarkdown(doc, adr_id) }],
      };
    },
  );
}
