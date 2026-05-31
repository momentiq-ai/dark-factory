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
// Steps 2 + 3a/b/c/d shipped the 8-tool read-only catalog. Step 4
// added the URI-addressable resource surface. Step 5 added
// df_stats + df_gate_push. Step 6 added df_review (async) +
// df_review_status + df_bypass. Step 7 added the 5 pure-template
// prompts. Step 8 added df_cycle_doc_generate + df_adr_generate.
// Step 9 wired elicitation for df_bypass. Step 10 (THIS) wires
// logging/message notifications so long-running tools (df_review,
// the generate tools) emit progress that the client can render
// inline.
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
import { registerPrompts } from "./prompts.js";

import { registerResources } from "./resources.js";
import { registerAdrTools } from "./tools/adr.js";
import { registerCriticsConfigTool } from "./tools/critics-config.js";
import { registerCycleTools } from "./tools/cycle.js";
import { registerDoctorTool } from "./tools/doctor.js";
import { registerFindingsTools } from "./tools/findings.js";
import { registerGenerateTools } from "./tools/generate.js";
import { registerHandoffTools } from "./tools/handoff.js";
import { registerReviewBypassTools } from "./tools/review-bypass.js";
import { registerStatsGateTools } from "./tools/stats-gate.js";

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

export interface CreateMcpServerOptions {
  /**
   * Override for the per-tool root used to discover cycle docs,
   * `.agent-review/config.json`, etc. Production code lets it default
   * to `process.cwd()` (the agent client's cwd at `df mcp` launch);
   * tests pass a fixture directory.
   */
  readonly cwd?: string;
  /**
   * Test-only escape hatch — substitute the runReview function used
   * by df_review with a stub so unit tests don't have to instantiate
   * the vendor adapter fleet. Production code leaves this undefined;
   * the real runReview ships. The underscore prefix marks it as
   * non-public surface.
   */
  readonly _testRunReview?: (
    options: import("../runner.js").ReviewRunOptions,
  ) => Promise<import("../runner.js").ReviewRunOutcome>;
  // Note: the v1 (Cycle 8) `_testHandoffGh` / `_testHandoffGit` runner
  // injectors were removed in Cycle 12.2 — v2 uses the object-shaped
  // GhClient/GitClient ports from src/handoff/ports.ts (one method per gh
  // verb pattern), not function runners. v2 test seams live on
  // registerHandoffTools' RegisterHandoffToolsOptions (`_gh` / `_git` /
  // `_clock`); see src/mcp/tools/handoff.ts.
}

export function createMcpServer(opts: CreateMcpServerOptions = {}): McpServer {
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
        // step 10 — server emits logging/message notifications for
        // long-running tool progress (df_review, the generate tools).
        // Clients that subscribe via `logging/setLevel` see in-flight
        // status; clients that don't subscribe see nothing
        // (notifications are best-effort).
        logging: {},
      },
      instructions:
        "Dark Factory MCP server (cycle5 Phase 1). Tools, resources, " +
        "and prompts will populate across the Phase 1 implementation " +
        "steps. See docs/roadmap/cycles/cycle5-mcp-server.md.",
    },
  );

  // Step 7 — populate prompts via registerPrompts (below), which
  // activates the SDK's automatic prompts/list + prompts/get
  // handlers. Tools have been auto-wired since step 2; resources
  // since step 4. There are no remaining explicit empty-list
  // handlers on the underlying Server.

  // Catalog. Each step in the cycle5 Phase 1 plan adds one
  // registerXxx call here and replaces the catalog-pin assertion in
  // tests/mcp/server.test.ts so every step's PR diff is reviewable.
  const toolOpts = opts.cwd !== undefined ? { cwd: opts.cwd } : {};
  registerDoctorTool(server, toolOpts);         // step 2
  registerCycleTools(server, toolOpts);         // step 3a — df_cycle_list + df_cycle_read
  registerFindingsTools(server, toolOpts);      // step 3b — df_findings + df_show_run
  registerAdrTools(server, toolOpts);           // step 3c — df_adr_list + df_adr_read
  registerCriticsConfigTool(server, toolOpts);  // step 3d — df_critics_config (closes step 3)
  registerStatsGateTools(server, toolOpts);     // step 5 — df_stats + df_gate_push
  registerReviewBypassTools(server, {
    ...toolOpts,
    ...(opts._testRunReview !== undefined
      ? { _internalRunReview: opts._testRunReview }
      : {}),
  });                                            // step 6 — df_review + df_review_status + df_bypass
  registerGenerateTools(server, toolOpts);      // step 8 — df_cycle_doc_generate + df_adr_generate (sampling)
  registerHandoffTools(server, toolOpts);        // cycle12.2 — df_handoff + df_accept + df_rehydrate + df_handoffs (v2 Issue-anchor)

  // step 4 — URI-addressable resources (df://repo/...). Single call
  // registers all 9 resources at once; see src/mcp/resources.ts.
  registerResources(server, toolOpts);

  // step 7 — 5 prompts as pure templates (no LLM calls server-side).
  // See src/mcp/prompts.ts.
  registerPrompts(server, toolOpts);

  return server;
}
