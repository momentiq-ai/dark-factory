// df_handoff + df_accept + df_rehydrate + df_handoffs MCP tools —
// Cycle 12 Phase 12.2 (STUB — Task 22).
//
// This file is a deliberately-minimal placeholder while the v2 wiring is
// landed across Tasks 22-26 of the Cycle 12.2 plan:
//
//   Task 22 (this commit) deletes the v1 (PR-arg, function-runner) impl and
//   leaves this no-op stub so `src/mcp/server.ts`'s import resolves and the
//   CLI continues to type-check + build.
//
//   Task 24 replaces this file with the real v2 tools (Issue-arg, GhClient-
//   port, structured I/O matching the new RunHandoff*Result shapes).
//
// Until Task 24 lands, `df mcp` exposes no handoff tools (calling df_handoff
// etc. returns a "method not found"). The CLI subcommands (`df handoff`/
// etc.) are similarly stubbed in Task 25; the full surface returns in one
// PR at Task 34.
//
// See docs/superpowers/specs/2026-05-30-agent-handoff-v2-issue-anchor-design.md.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface RegisterHandoffToolsOptions {
  /** Unused today — accepted for symmetry with the other register* signatures. */
  cwd?: string;
}

/**
 * No-op stub. The real Cycle 12 implementation (4 v2 tools wired against
 * the GhClient port + the verb orchestrators) lands in Task 24. This stub
 * exists so `src/mcp/server.ts`'s import and call site continue to compile
 * across the Tasks 22-26 commits without dragging the (now-deleted) v1
 * surface forward.
 */
export function registerHandoffTools(
  _server: McpServer,
  _opts: RegisterHandoffToolsOptions = {},
): void {
  // intentionally empty — Task 24 fills this in.
}
