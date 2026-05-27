// Cycle 5 Phase 1 — Dark Factory MCP server.
//
// `df mcp` exposes the CLI's surface as a Model Context Protocol server
// over stdio so any MCP-speaking agent (Claude Code, Cursor, Codex,
// Gemini) gets a structured tool + resource + prompt catalog instead of
// having to shell out to `df` and parse stdout.
//
// Cycle5 Phase 1 ships individual catalog entries one step at a time
// (docs/roadmap/cycles/cycle5-mcp-server.md, "Phase 1 — local stdio").
// Step 1 shipped the empty-catalog skeleton + initialize handshake.
// Step 2 (THIS) registers the first tool, `df_doctor`. Resources and
// prompts stay empty until later Phase 1 steps populate them.
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
} from "@modelcontextprotocol/sdk/types.js";

import { registerDoctorTool } from "./tools/doctor.js";

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

  // Resources and prompts are still empty in step 2 — wire explicit
  // empty list handlers so /list returns [] instead of "Method not
  // found". The tool registration below activates the SDK's automatic
  // tools/list + tools/call handlers (the SDK guards against double-
  // registration of the tools handler — that's why we no longer set
  // an explicit empty tools/list handler here).
  server.server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [],
  }));
  server.server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [],
  }));

  // Phase 1 step 2 — first tool. Each subsequent step adds one more
  // registerXxx call alongside this one and replaces the catalog-pin
  // assertion in tests/mcp/server.test.ts.
  registerDoctorTool(server);

  return server;
}
