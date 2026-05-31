// packages/cli/src/mcp/tools/handoff.ts
//
// MCP tools for the Cycle 12 (Issue-anchor) handoff protocol. Wires the
// 4 verb orchestrators to the MCP server per spec §9.
//
// Signature change from Cycle 8 v1 (deleted at Task 22): `pr` → `issue`.
// Each tool's description carries an "Issue-anchored; PR-arg removed"
// deprecation note (stays for one alpha cycle per spec §9 OQ-12.5, then
// removed). The note deliberately omits a specific version number because
// release-please's `versioning-strategy: prerelease` computes the actual
// bumped version from the conventional-commit history on merge — it could
// land as 0.6.0-alpha.10 or 0.7.0-alpha.0 depending on its rules, and a
// hardcoded prediction would either be wrong or need a follow-up edit
// after the release PR computes the real number.
//
// Each tool returns BOTH:
//   - structuredContent: the typed RunXResult / RehydrateData shape so
//     MCP clients can render structured output (matches advisor finding #3
//     "do_rehydrate as data, with two renderers").
//   - content: [{ type: "text", text: ... }]: bash-compatible rendered text
//     for clients that don't process structuredContent.
//
// Test seam: registerHandoffTools accepts {_gh, _git, _clock} overrides so
// hermetic MCP-layer tests (Task 29) can substitute fakes without monkey-
// patching the spawn-based real clients.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  HandoffError,
  SpawnGhClient,
  SpawnGitClient,
  SystemClock,
  runHandoff,
  runAccept,
  runRehydrate,
  runHandoffs,
  renderRehydrateText,
  type GhClient,
  type GitClient,
  type Clock,
  type RehydrateData,
} from "../../handoff/index.js";
import { requireIssueNumber } from "../../handoff/args.js";

export interface RegisterHandoffToolsOptions {
  /**
   * Accepted for symmetry with the other register*Tool options shapes
   * (doctor, cycle, findings, etc.) so `src/mcp/server.ts` can pass its
   * `toolOpts` literal uniformly. The handoff verbs don't read filesystem
   * config (they take gh/git/clock by injection), so this field is not
   * threaded into any verb call — it's a no-op kept here to avoid an
   * exactOptionalPropertyTypes mismatch at the server-wire site.
   */
  readonly cwd?: string;
  /** Test seam — substitute a fake GhClient for hermetic tests (Task 29). */
  readonly _gh?: GhClient;
  /** Test seam — substitute a fake GitClient for hermetic tests (Task 29). */
  readonly _git?: GitClient;
  /** Test seam — substitute a deterministic Clock for hermetic tests. */
  readonly _clock?: Clock;
}

const DEPRECATION_NOTE = " Issue-anchored; PR-arg removed.";

export function registerHandoffTools(
  server: McpServer,
  opts: RegisterHandoffToolsOptions = {},
): void {
  // Build a fresh client triple per tool invocation. The Spawn* clients are
  // cheap to construct (no I/O until a method is called) and per-call
  // construction avoids cross-invocation state leakage. Test overrides
  // (opts._gh / _git / _clock) are honored, falling back to the real
  // spawn-based implementations otherwise.
  const makeClients = (): { gh: GhClient; git: GitClient; clock: Clock } => ({
    gh: opts._gh ?? new SpawnGhClient(),
    git: opts._git ?? new SpawnGitClient(),
    clock: opts._clock ?? new SystemClock(),
  });

  // --- df_handoff -----------------------------------------------------------
  server.registerTool(
    "df_handoff",
    {
      title: "Hand off a work-stream",
      description:
        "Put a work-stream on the handoff stack: upsert the marker-bounded " +
        "rehydration `note` you compose as the dedicated handoff issue's " +
        "body, add the `handoff` label, and leave the issue unassigned " +
        "(open on the stack). Auto-creates a new issue if none is supplied " +
        "or none is owned by @me. Scrubs the note for secret-shaped " +
        "content first and REFUSES on a match (setup steps yes, secrets " +
        "never)." +
        DEPRECATION_NOTE,
      annotations: {
        // Writes the issue body + label + (optionally) creates a new
        // issue. Reaches the GitHub API (openWorldHint:true). Not
        // destructive (no irreversible deletes) and not idempotent (a
        // second call with the same note re-upserts; new+forceNew may
        // create another issue).
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        note: z
          .string()
          .min(1)
          .describe(
            "The composed rehydration note body, bounded by the v1 " +
              "markers (<!-- agent-context:v1 --> … <!-- /agent-context:v1 -->).",
          ),
        issue: z
          .string()
          .optional()
          .describe(
            "Explicit handoff issue number (positive integer). Omit to " +
              "update @me's open handoff or create a new one.",
          ),
        link: z
          .array(z.string())
          .optional()
          .describe(
            "Work items to link (PR/issue ref: number, owner/repo#N, or URL).",
          ),
        unlink: z
          .array(z.string())
          .optional()
          .describe("Work items to unlink (same ref forms as `link`)."),
        new: z
          .boolean()
          .optional()
          .describe(
            "Force-create a new issue even if @me already has an open " +
              "handoff.",
          ),
      },
      outputSchema: {
        issue: z.string().describe("The issue the note landed on."),
        note_url: z
          .string()
          .describe("html_url of the upserted handoff issue."),
        created: z
          .boolean()
          .describe("True iff this call created the issue."),
      },
    },
    async (input) => {
      const clients = makeClients();
      // Validate the optional issue arg up front so a malformed string
      // surfaces as a HandoffError before any gh I/O happens. Spread the
      // result so exactOptionalPropertyTypes accepts `issue?: number`
      // without an explicit `| undefined`.
      const issue =
        input.issue !== undefined ? requireIssueNumber(input.issue) : undefined;
      const result = await runHandoff({
        noteStdin: input.note,
        ...(issue !== undefined ? { issue } : {}),
        link: input.link ?? [],
        unlink: input.unlink ?? [],
        forceNew: input.new ?? false,
        ...clients,
      });
      return {
        structuredContent: {
          issue: String(result.issueNumber),
          note_url: result.noteUrl,
          created: result.created,
        },
        content: [
          {
            type: "text",
            text: `${result.created ? "created" : "updated"} handoff issue #${result.issueNumber}${result.noteUrl ? `: ${result.noteUrl}` : ""}`,
          },
        ],
      };
    },
  );

  // --- df_accept ------------------------------------------------------------
  server.registerTool(
    "df_accept",
    {
      title: "Accept a handoff",
      description:
        "Take the baton on a handoff issue: validate, strict-rehydrate, " +
        "assign @me, verify, then close (Commitment 10). Atomic ordering — " +
        "read-only work precedes all mutations; any failure leaves the " +
        "issue open + unassigned on the stack." +
        DEPRECATION_NOTE,
      annotations: {
        // Writes the assignee + closes the issue (Commitment 10) via
        // the GitHub API. Not destructive (the issue can be reopened
        // and re-claimed) and not idempotent (a second call on the
        // same closed issue is a no-op / error path).
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        issue: z
          .string()
          .describe("Handoff issue number to accept (positive integer)."),
      },
      outputSchema: rehydrateOutputShape(),
    },
    async (input) => {
      const clients = makeClients();
      const issue = requireIssueNumber(input.issue);
      if (issue === undefined) {
        throw new HandoffError("issue is required for df_accept");
      }
      const result = await runAccept({ issue, gh: clients.gh });
      return rehydrateMcpResponse(result.issueNumber, result.rehydrate);
    },
  );

  // --- df_rehydrate ---------------------------------------------------------
  server.registerTool(
    "df_rehydrate",
    {
      title: "Rehydrate a handoff issue (read-only)",
      description:
        "Read-only catch-up on a handoff issue: derives live state + each " +
        "linked work item's status + prints the rehydration note. No " +
        "ownership change. No-arg resolves via 2-tier (open+@me first, " +
        "then closed+@me within 7d). Works on open AND closed issues " +
        "(closed = forensic catch-up)." +
        DEPRECATION_NOTE,
      annotations: {
        // Pure read of the GitHub API — no mutations to issue/PR
        // state. openWorldHint:true because it hits the GitHub API.
        readOnlyHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        issue: z
          .string()
          .optional()
          .describe(
            "Optional issue number. Omit to resolve via 2-tier lookup.",
          ),
      },
      outputSchema: rehydrateOutputShape(),
    },
    async (input) => {
      const clients = makeClients();
      const issue =
        input.issue !== undefined ? requireIssueNumber(input.issue) : undefined;
      const result = await runRehydrate({
        ...(issue !== undefined ? { issue } : {}),
        gh: clients.gh,
        clock: clients.clock,
      });
      return rehydrateMcpResponse(result.issueNumber, result.rehydrate);
    },
  );

  // --- df_handoffs ----------------------------------------------------------
  server.registerTool(
    "df_handoffs",
    {
      title: "List the handoff stack",
      description:
        "List the handoff stack (open + handoff-labeled + unassigned). " +
        "Per-repo (gh issue list is repo-scoped; cross-repo aggregation " +
        "is deferred to OQ-12.3)." +
        DEPRECATION_NOTE,
      annotations: {
        // Pure list query (open + handoff-labeled + unassigned) over
        // the GitHub API. No mutations.
        readOnlyHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
      outputSchema: {
        rows: z.array(
          z.object({
            issue_number: z.number(),
            title: z.string(),
            age: z.string(),
            linked_count: z.number(),
            linked_display: z.string(),
          }),
        ),
      },
    },
    async () => {
      const clients = makeClients();
      const result = await runHandoffs({
        gh: clients.gh,
        clock: clients.clock,
      });
      return {
        structuredContent: {
          rows: result.rows.map((r) => ({
            issue_number: r.issueNumber,
            title: r.title,
            age: r.age,
            linked_count: r.linkedCount,
            linked_display: r.linkedDisplay,
          })),
        },
        content: [{ type: "text", text: result.text }],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers — shared between df_accept and df_rehydrate (both return the
// RehydrateData shape).
// ---------------------------------------------------------------------------

/**
 * Shared output schema for df_accept + df_rehydrate. The shape mirrors
 * RehydrateData exactly (snake_case'd for the MCP wire), so the two
 * tools' clients can render the structured response uniformly. `note` is
 * `nullable()` (not `optional()`) because RehydrateData declares it as
 * `string | null` — the marker block is either present and extracted or
 * structurally absent.
 */
function rehydrateOutputShape() {
  return {
    issue: z.string(),
    state: z.string(),
    title: z.string(),
    linked_items: z.array(
      z.object({
        kind: z.enum(["pr", "issue", "?"]),
        display: z.string(),
        title: z.string(),
        state: z.enum(["OPEN", "CLOSED", "MERGED", "UNREACHABLE"]),
        annotation: z.string(),
        checkout_hint: z.string().optional(),
      }),
    ),
    note: z.string().nullable(),
  };
}

/**
 * Build the MCP response from an issue number + RehydrateData. Used by
 * both df_accept and df_rehydrate. `checkoutHint` is conditionally
 * spread to honor exactOptionalPropertyTypes (the source field is
 * `checkoutHint?: string` — undefined must NOT appear as a literal).
 *
 * The `content` literal uses `as const` so TS preserves `type: "text"`
 * as the literal type that the MCP SDK's CallToolResult union requires
 * (otherwise inference widens it to `string` and the registered handler
 * fails to satisfy the SDK's handler signature).
 */
function rehydrateMcpResponse(issueNumber: number, data: RehydrateData) {
  return {
    structuredContent: {
      issue: String(issueNumber),
      state: data.stateLine,
      title: data.title,
      linked_items: data.linkedItems.map((item) => ({
        kind: item.kind,
        display: item.display,
        title: item.title,
        state: item.state,
        annotation: item.annotation,
        ...(item.checkoutHint !== undefined
          ? { checkout_hint: item.checkoutHint }
          : {}),
      })),
      note: data.note,
    },
    content: [
      { type: "text" as const, text: renderRehydrateText(data) },
    ],
  };
}
