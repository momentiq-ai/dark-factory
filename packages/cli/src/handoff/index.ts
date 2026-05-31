// packages/cli/src/handoff/index.ts
//
// Public surface for the Cycle 12 handoff protocol. Re-exports the verb
// orchestrators + types for CLI (src/cli.ts) and MCP (src/mcp/tools/handoff.ts)
// consumption.
//
// Replaces the Cycle 8 v1 monolith (894 LOC) — which carried the runner-shaped
// `GhRunner`/`GitRunner` function seams, the PR-arg verbs, and the bash-port
// throw sites — with a thin shim over the modular pure-helpers + verbs in this
// directory. v2 uses the object-shaped `GhClient`/`GitClient` ports from
// ports.ts; the v1 function-runner types are intentionally NOT exported (any
// caller that still references them is a v1 holdover that needs porting).
//
// Single-class identity for `HandoffError` is preserved: it's defined in
// ports.ts (the lowest leaf) and re-exported here, so the verb modules that
// import from `./ports.js` and the consumers that import from `./index.js`
// both see the exact same class for `instanceof` checks.
//
// See docs/superpowers/specs/2026-05-30-agent-handoff-v2-issue-anchor-design.md
// for the design rationale.

export { HandoffError } from "./ports.js";
export type {
  GhClient,
  GitClient,
  Clock,
  IssueView,
  IssueViewSlim,
  IssueListItem,
  IssueCreated,
  PrView,
} from "./ports.js";

export { MARKER_OPEN, MARKER_CLOSE } from "./markers.js";

// HANDOFF_LABEL is currently a private const in links.ts (per Task 5's
// deliberate deviation — it sits next to the link-resolution helpers that
// reference it). Re-declared here as the permanent public home so CLI/MCP
// consumers can import the label without coupling to links.ts's internals.
export const HANDOFF_LABEL = "handoff";

export { runHandoff } from "./handoff-verb.js";
export type { RunHandoffOptions, RunHandoffResult } from "./handoff-verb.js";

export { runAccept } from "./accept-verb.js";
export type { RunAcceptOptions, RunAcceptResult } from "./accept-verb.js";

export { runRehydrate } from "./rehydrate-verb.js";
export type {
  RunRehydrateOptions,
  RunRehydrateResult,
} from "./rehydrate-verb.js";

export { runHandoffs } from "./handoffs-verb.js";
export type { RunHandoffsResult, HandoffStackRow } from "./handoffs-verb.js";

export type { RehydrateData, LinkedItemDerivation } from "./rehydrate-core.js";
export { renderRehydrateText } from "./rehydrate-render.js";

export {
  SpawnGhClient,
  SpawnGitClient,
  SystemClock,
} from "./real-clients.js";
