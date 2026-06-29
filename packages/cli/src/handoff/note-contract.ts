// packages/cli/src/handoff/note-contract.ts
//
// Single source of truth for the AUTHORING contract of a handoff rehydration
// note — the marker-bounded skeleton + the hard security rule. Two surfaces
// consume it, and they MUST NOT drift:
//
//   - the df.handoff MCP PROMPT (src/mcp/prompts.ts) — the long-form judgment,
//     surfaced by clients that support MCP prompts (e.g. Claude Code); and
//   - the df_handoff MCP TOOL (src/mcp/tools/handoff.ts) — the same skeleton
//     embedded in the `note` input-schema description, so tool-only MCP
//     clients (OpenCode, Codex, Cursor — which do NOT surface MCP prompts)
//     receive the identical format from the tool metadata alone.
//
// Keeping ONE source here is what lets an outside-family agent (the
// creator-model-autonomy thesis: the gate judges output, not author) compose a
// well-formed note without the Claude-Code-only prompt. PORT-PARITY NOTE: the
// markers are re-used from markers.ts (the load-bearing parse invariant); the
// section prose is advisory (nothing parses it) but is pinned here so the
// prompt and the tool can never diverge.

import { MARKER_CLOSE, MARKER_OPEN } from "./markers.js";

const DATE_PLACEHOLDER = "<YYYY-MM-DD>";
const TITLE_PLACEHOLDER = "<title>";

/**
 * The marker-bounded rehydration-note skeleton. The `agent-context:v1` markers
 * are load-bearing — the df_handoff upsert finds the block by them. Pass
 * `date` / `title` to pre-fill them (the prompt does, with `today()` + the
 * work-stream title); omit for the placeholder form (the static tool-schema
 * description).
 */
export function noteSkeleton(
  opts: { date?: string; title?: string } = {},
): string {
  const date = opts.date ?? DATE_PLACEHOLDER;
  const title = opts.title ?? TITLE_PLACEHOLDER;
  return [
    MARKER_OPEN,
    "> 🤖 **Agent rehydration context** — transient working memory, NOT a source of truth.",
    "> State is whatever `gh`/the linked work items say now; this is the *reasoning*. Stale by nature.",
    `> _Updated: ${date} by <your model/session>_`,
    "",
    `**Work-stream:** \`${title}\` · the dedicated handoff Issue's title.`,
    "",
    "**Why this approach (and what I rejected):**",
    "- <the decision + the alternative you did NOT take, and why>",
    "",
    "**Traps I hit:**   ← setup-shaped only; see the Security rule below",
    "- <the gotcha + the setup step that avoids it>",
    "",
    "**Where I was mid-thought:**",
    "- <the thing you'd tell yourself if you walked back in 10 minutes later>",
    "",
    "**Derive current state (don't trust the above as current):**",
    "    Run df_rehydrate on this Issue — it derives live state safely",
    "    (Issue + each linked work item). Or, generically: gh issue view",
    "    <N> for the Issue body + timeline; gh pr view / gh pr checks",
    "    for any linked PR.",
    MARKER_CLOSE,
  ].join("\n");
}

/**
 * The hard security rule, compact form. The df.handoff PROMPT expands this with
 * ✅/❌ examples; the df_handoff TOOL description carries this one-liner. Both
 * say the same thing: setup steps yes, secrets never.
 */
export const NOTE_SECURITY_RULE_COMPACT =
  "Security rule (HARD): this note becomes a GitHub Issue body — readable by " +
  "anyone with repo access and cached even after deletion. Write SETUP STEPS, " +
  "never SECRETS (no tokens, API keys, credential-file paths, or connection " +
  "strings). df_handoff scrubs as a backstop and REFUSES on a secret-shaped " +
  "match — you are the primary control.";
