// df_handoff + df_accept + df_rehydrate + df_handoffs MCP tools —
// Cycle 12 (Issue-anchored).
//
// The MCP surface of the four handoff verbs. They wrap the same shared
// core (src/handoff/index.ts) that backs the `df handoff`/etc. CLI
// subcommands. The judgment (when to hand off, what to write, the
// security rule) lives in the `df.handoff` / `df.rehydrate` prompts;
// these tools are the mechanism.
//
// Input-shape note: the CLI's `df handoff` reads the note body on stdin
// (`< note.md`); MCP has no stdin, so `df_handoff` takes `note` as a
// string parameter (the agent composes it per the df.handoff prompt and
// passes it directly).
//
// Side-effect posture:
//   - df_handoff / df_accept WRITE issue state (body, label, assignee,
//     state) → readOnlyHint:false; not destructive (no data loss):
//     destructiveHint:false; not idempotent (each call re-writes the
//     body or closes the issue): idempotentHint:false.
//   - df_handoffs / df_rehydrate are read-only → readOnlyHint:true.
//   - ALL four hit the GitHub API → openWorldHint:true.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  HandoffError,
  defaultDeps,
  runAccept,
  runHandoff,
  runHandoffs,
  runRehydrate,
  type GhRunner,
  type GitRunner,
  type HandoffDeps,
  type HandoffInput,
} from "../../handoff/index.js";

export interface RegisterHandoffToolsOptions {
  /** Unused today (the verbs operate on the repo gh resolves from cwd),
   * accepted for symmetry with the other register* signatures. */
  cwd?: string;
  /** Test-only: substitute the `gh` runner so tests stay hermetic. */
  _internalGh?: GhRunner;
  /** Test-only: substitute the `git` runner so tests stay hermetic. */
  _internalGit?: GitRunner;
}

function buildDeps(
  opts: RegisterHandoffToolsOptions,
  notes: string[],
): HandoffDeps {
  // Collect the core's operator-facing log lines so they can be folded
  // into the tool's text content (the CLI sends them to stderr; the MCP
  // client gets them inline).
  const base = defaultDeps((line) => notes.push(line));
  return {
    gh: opts._internalGh ?? base.gh,
    git: opts._internalGit ?? base.git,
    log: base.log,
  };
}

function errorResult(message: string): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function registerHandoffTools(
  server: McpServer,
  opts: RegisterHandoffToolsOptions = {},
): void {
  // ----- df_handoff -------------------------------------------------
  server.registerTool(
    "df_handoff",
    {
      title: "Hand off a work-stream",
      description:
        "Put a work-stream on the handoff stack: upsert the " +
        "marker-bounded rehydration `note` you compose (per the " +
        "`df.handoff` prompt) as the dedicated handoff issue's body, " +
        "add the `handoff` label, and leave the issue unassigned (open " +
        "on the stack). Auto-creates a new issue if none is supplied " +
        "or none is owned by @me. Scrubs the note for secret-shaped " +
        "content first and REFUSES on a match (setup steps yes, " +
        "secrets never). Issue-anchored as of Cycle 12; the v1 PR-arg " +
        "was removed.",
      inputSchema: {
        note: z
          .string()
          .min(1)
          .describe(
            "The composed rehydration note body, bounded by the v1 markers " +
              "(<!-- agent-context:v1 --> … <!-- /agent-context:v1 -->).",
          ),
        issue: z
          .string()
          .optional()
          .describe(
            "Explicit handoff issue number (positive integer). Omit to " +
              "update @me's open handoff or create a new one. Must already " +
              "be a handoff issue (`handoff` label or empty body) — does " +
              "not re-label arbitrary tracker issues.",
          ),
        link: z
          .array(z.string())
          .optional()
          .describe(
            "Work items to link (PR/issue ref: N, owner/repo#N, or URL).",
          ),
        unlink: z.array(z.string()).optional(),
        new: z
          .boolean()
          .optional()
          .describe(
            "Force-create a new issue even if @me already has an open handoff.",
          ),
      },
      outputSchema: {
        issue: z.string().describe("The issue the note landed on."),
        note_url: z.string().describe("html_url of the upserted handoff issue."),
        created: z.boolean().describe("True iff this call created the issue."),
        warnings: z
          .array(z.string())
          .describe("Operator-facing warnings (empty when none)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const notes: string[] = [];
      try {
        const input: HandoffInput = {
          note: params.note,
          ...(params.issue !== undefined ? { issue: params.issue } : {}),
          ...(params.link !== undefined ? { link: params.link } : {}),
          ...(params.unlink !== undefined ? { unlink: params.unlink } : {}),
          ...(params.new !== undefined ? { new: params.new } : {}),
        };
        const result = await runHandoff(input, buildDeps(opts, notes));
        const structured: Record<string, unknown> = {
          issue: result.issue,
          note_url: result.noteUrl,
          created: result.created,
          warnings: result.warnings,
        };
        const text = [
          `**df_handoff**: #${result.issue} ${result.created ? "created" : "updated"} — ${result.noteUrl}`,
          ...result.warnings.map((w) => `  ! ${w}`),
        ].join("\n");
        return {
          structuredContent: structured,
          content: [{ type: "text", text }],
        };
      } catch (e) {
        if (e instanceof HandoffError) {
          return errorResult(
            `**df_handoff**: ${e.message}${notes.length ? `\n${notes.join("\n")}` : ""}`,
          );
        }
        return errorResult(`**df_handoff**: ${(e as Error).message}`);
      }
    },
  );

  // ----- df_handoffs ------------------------------------------------
  server.registerTool(
    "df_handoffs",
    {
      title: "List the handoff stack",
      description:
        "List the stack of handed-off issues (open, labeled `handoff`, " +
        "unassigned) for the current repo, oldest → newest. Each entry " +
        "carries the issue number, title, age, and linked-work-items " +
        "count. Read-only.",
      inputSchema: {},
      outputSchema: {
        rows: z
          .array(
            z.object({
              number: z.number().describe("Issue number."),
              title: z.string(),
              age: z.string().describe("Coarse relative age (e.g. '2h ago')."),
              linked_count: z
                .number()
                .describe("Count of linked work items in the body."),
            }),
          )
          .describe("Stack rows, oldest → newest."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const notes: string[] = [];
      try {
        const r = await runHandoffs(buildDeps(opts, notes));
        const structured = {
          rows: r.rows.map((row) => ({
            number: row.number,
            title: row.title,
            age: row.ageStr,
            linked_count: row.linkedCount,
          })),
        };
        return {
          structuredContent: structured as Record<string, unknown>,
          content: [{ type: "text", text: r.text }],
        };
      } catch (e) {
        if (e instanceof HandoffError) {
          return errorResult(`**df_handoffs**: ${e.message}`);
        }
        return errorResult(`**df_handoffs**: ${(e as Error).message}`);
      }
    },
  );

  // ----- df_rehydrate -----------------------------------------------
  server.registerTool(
    "df_rehydrate",
    {
      title: "Rehydrate a handoff issue (read-only)",
      description:
        "Read-only catch-up on a handoff issue's reasoning note — NO " +
        "ownership change (for resuming your OWN in-flight work). " +
        "Derives LIVE state ITSELF for the issue and every linked work " +
        "item (script-controlled gh ... --json calls), then prints the " +
        "reasoning. The body is operator-editable text: control/ESC " +
        "bytes are stripped, and NOTHING transcribed from it is " +
        "executed. To take over someone else's handoff, use df_accept.",
      inputSchema: {
        issue: z
          .string()
          .optional()
          .describe(
            "Handoff issue number (positive integer). Omit for the two-tier " +
              "no-arg resolution (most recent open assigned-to-@me, then most " +
              "recent closed-accepted-by-@me within 7d).",
          ),
      },
      outputSchema: {
        issue: z.string().describe("The resolved issue number."),
        text: z
          .string()
          .describe(
            "Pre-rendered text: live state header, linked items, then reasoning.",
          ),
        has_unreachable: z
          .boolean()
          .describe("True iff at least one linked work item was unreachable."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const notes: string[] = [];
      try {
        const r = await runRehydrate(
          params.issue !== undefined ? { issue: params.issue } : {},
          buildDeps(opts, notes),
        );
        const structured: Record<string, unknown> = {
          issue: r.issue,
          text: r.text,
          has_unreachable: r.hasUnreachable,
        };
        return {
          structuredContent: structured,
          content: [{ type: "text", text: r.text }],
        };
      } catch (e) {
        if (e instanceof HandoffError) {
          return errorResult(`**df_rehydrate**: ${e.message}`);
        }
        return errorResult(`**df_rehydrate**: ${(e as Error).message}`);
      }
    },
  );

  // ----- df_accept --------------------------------------------------
  server.registerTool(
    "df_accept",
    {
      title: "Accept a handoff (claim + close)",
      description:
        "Take the baton on a handoff issue. Atomic chain: validate → " +
        "refuse on other-assignee → rehydrate STRICT (live state for " +
        "issue + every linked work item) → pre-assign drift check → " +
        "assign @me → post-assign verify → close (Commitment 10 — the " +
        "handoff event is complete; the closed issue with the `handoff` " +
        "label is the audit). Use df_rehydrate instead when no transfer " +
        "is happening (you already own the work).",
      inputSchema: {
        issue: z
          .string()
          .describe("Issue number to accept (positive integer; required)."),
      },
      outputSchema: {
        issue: z.string().describe("The accepted issue number."),
        rehydrate: z
          .object({
            issue: z.string(),
            text: z.string(),
            has_unreachable: z.boolean(),
          })
          .describe("The contained rehydrate (accept CONTAINS rehydrate)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const notes: string[] = [];
      try {
        const result = await runAccept(
          { issue: params.issue },
          buildDeps(opts, notes),
        );
        const r = result.rehydrate;
        const structured: Record<string, unknown> = {
          issue: result.issue,
          rehydrate: {
            issue: r.issue,
            text: r.text,
            has_unreachable: r.hasUnreachable,
          },
        };
        const text = [
          `**df_accept**: accepted #${result.issue} — assigned + closed.`,
          "",
          r.text,
        ].join("\n");
        return {
          structuredContent: structured,
          content: [{ type: "text", text }],
        };
      } catch (e) {
        if (e instanceof HandoffError) {
          return errorResult(
            `**df_accept**: ${e.message}${notes.length ? `\n${notes.join("\n")}` : ""}`,
          );
        }
        return errorResult(`**df_accept**: ${(e as Error).message}`);
      }
    },
  );
}
