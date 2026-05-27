// Cycle 5 Phase 1 — Dark Factory MCP server skeleton.
//
// `df mcp` exposes the CLI's surface as a Model Context Protocol server
// over stdio so any MCP-speaking agent (Claude Code, Cursor, Codex,
// Gemini) gets a structured tool + resource + prompt catalog instead of
// having to shell out to `df` and parse stdout.
//
// This module ships the EMPTY catalog only — the next steps in the
// Phase 1 implementation plan (docs/roadmap/cycles/cycle5-mcp-server.md,
// "Phase 1 — local stdio") wire individual tools, resources, and
// prompts on top of this skeleton, one per PR.
//
// The MCP protocol version pinned by cycle5 is `2025-06-18`. The SDK we
// depend on (`@modelcontextprotocol/sdk@^1.29.0`) supports a set of
// versions including 2025-06-18; clients drive the negotiation. The
// conformance test (`tests/mcp/server.test.ts`) pins both of these
// invariants so a future SDK bump that drops 2025-06-18 fails closed
// and forces an ADR — see the cycle5 doc's "Versioning strategy"
// section.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface PackageMeta {
  readonly name: string;
  readonly version: string;
}

function readPackageMeta(): PackageMeta {
  // dist/mcp/server.js → ../../package.json (two levels up from compiled
  // location); src/mcp/server.ts → ../../package.json (same shape pre-
  // compile because tests import the .ts directly). The two-up resolve
  // works for both because the directory depth matches.
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, "..", "..", "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const parsed = JSON.parse(raw) as { name?: string; version?: string };
  return {
    name: parsed.name ?? "@momentiq/dark-factory-cli",
    version: parsed.version ?? "0.0.0",
  };
}

export function createMcpServer(): McpServer {
  const meta = readPackageMeta();
  // serverInfo.name is what clients render in their UI; the suffix marks
  // this as the MCP surface of the CLI rather than the CLI itself.
  const server = new McpServer(
    { name: `${meta.name}/mcp`, version: meta.version },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions:
        "Dark Factory MCP server (cycle5 Phase 1). Tools, resources, " +
        "and prompts will populate across the Phase 1 implementation " +
        "steps. See docs/roadmap/cycles/cycle5-mcp-server.md.",
    },
  );

  // Wire the three primitive list-handlers explicitly so the empty
  // catalog still responds correctly. The McpServer wrapper would
  // synthesize these once any tool/resource/prompt is registered via
  // its registerX helpers; with zero registrations we register raw
  // handlers on the underlying Server to keep the contract honest.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  server.server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [],
  }));
  server.server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [],
  }));

  return server;
}
