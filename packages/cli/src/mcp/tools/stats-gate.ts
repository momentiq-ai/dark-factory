// df_stats + df_gate_push MCP tools — cycle5 Phase 1 step 5.
//
// Spec output shapes (from docs/roadmap/cycles/cycle5-mcp-server.md):
//
//   df_stats →
//     { runs, bypasses, by_critic, by_verdict }
//
//   df_gate_push →
//     { verdict: 'block'|'allow'|'bypass-required', reasons: [...] }
//
// df_stats narrows the existing TelemetryStats (`@momentiq/dark-factory-
// schemas:TelemetryStats`) to the 4 fields the cycle5 spec names; the
// full stats (retry summary, per-critic finding breakdowns, etc.) are
// available via the resource surface (`df://repo/audit-log` for raw
// NDJSON; clients can recompute).
//
// df_gate_push wraps `runCommitGate` for each commit in the pushed
// range. The spec explicitly notes: "the stdio MCP server already
// owns stdin; pass the protocol data as a tool argument." So the
// `stdin_protocol` input string is what git's pre-push hook would
// write to stdin — newline-separated `<localRef> <localSha>
// <remoteRef> <remoteSha>` lines.
//
// The `'bypass-required'` verdict signals: the gate would block, AND
// the policy permits an emergency bypass (`policy.allowEmergencyBypass:
// true`). An agent client can use this signal to prompt the user
// before invoking `df_bypass` (lands in step 6). When
// `allowEmergencyBypass: false`, blocking gates return `'block'`
// instead — the policy doesn't allow override.

import { resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TelemetryEvent } from "@momentiq/dark-factory-schemas";

import {
  readTelemetryEvents,
  summarizeTelemetry,
} from "../../evidence/audit-trail.js";
import {
  commitsForPushUpdate,
  parsePrePushUpdates,
} from "../../git.js";
import { resolveArtifactDir, telemetryPath } from "../../paths.js";
import { loadAgentReviewConfig } from "../../policy/config.js";
import { resolveProfile } from "../../policy/profile.js";
import { runCommitGate } from "../../runner.js";

export interface RegisterStatsGateToolsOptions {
  cwd?: string;
}

// ---- df_stats ------------------------------------------------------

interface DfStatsByCritic {
  readonly starts: number;
  readonly finishes: number;
  readonly errors: number;
  readonly approved: number;
  readonly changes_requested: number;
  readonly total_findings: number;
  readonly total_blockers: number;
  readonly total_high: number;
}

interface DfStatsByVerdict {
  readonly approved: number;
  readonly changes_requested: number;
}

export interface DfStatsResult {
  readonly runs: number;
  readonly bypasses: number;
  readonly by_critic: Record<string, DfStatsByCritic>;
  readonly by_verdict: DfStatsByVerdict;
  readonly window: {
    readonly since?: string;
    readonly until?: string;
    readonly events_in_window: number;
    readonly events_total: number;
  };
}

function filterEventsByWindow(
  events: readonly TelemetryEvent[],
  since: string | undefined,
  until: string | undefined,
): TelemetryEvent[] {
  if (!since && !until) return events.slice();
  return events.filter((e) => {
    if (typeof e.ts !== "string") return false;
    if (since && e.ts < since) return false;
    if (until && e.ts > until) return false;
    return true;
  });
}

export function mapStatsForSpec(
  events: readonly TelemetryEvent[],
  since: string | undefined,
  until: string | undefined,
): DfStatsResult {
  const windowed = filterEventsByWindow(events, since, until);
  const stats = summarizeTelemetry(windowed);
  const by_critic: Record<string, DfStatsByCritic> = {};
  for (const [id, c] of Object.entries(stats.byCritic)) {
    by_critic[id] = {
      starts: c.starts,
      finishes: c.finishes,
      errors: c.errors,
      approved: c.approved,
      changes_requested: c.changesRequested,
      total_findings: c.totalFindings,
      total_blockers: c.totalBlockers,
      total_high: c.totalHigh,
    };
  }
  return {
    runs: stats.totalRuns,
    bypasses: stats.bypasses,
    by_critic,
    by_verdict: {
      approved: stats.approvedCount,
      changes_requested: stats.changesRequestedCount,
    },
    window: {
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      events_in_window: windowed.length,
      events_total: events.length,
    },
  };
}

// ---- df_gate_push --------------------------------------------------

export type DfGatePushVerdict = "block" | "allow" | "bypass-required";

interface DfGatePushReason {
  readonly commit: string;
  readonly criticId?: string;
  readonly reason: string;
  readonly detail?: string;
}

export interface DfGatePushResult {
  readonly verdict: DfGatePushVerdict;
  readonly reasons: readonly DfGatePushReason[];
  readonly commits_evaluated: number;
  readonly bypass_allowed: boolean;
}

// ---- Registration --------------------------------------------------

export function registerStatsGateTools(
  server: McpServer,
  opts: RegisterStatsGateToolsOptions = {},
): void {
  server.registerTool(
    "df_stats",
    {
      title: "Audit-trail stats",
      description:
        "Summarize the .git/agent-reviews/_runs.ndjson audit trail. " +
        "Optional ISO8601 `since` / `until` to constrain the window. " +
        "Returns the narrowed spec view: { runs, bypasses, by_critic, " +
        "by_verdict }. Read-only.",
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe(
            "ISO8601 timestamp — drop events with ts < since (lexicographic " +
              "comparison; works correctly for UTC ISO timestamps).",
          ),
        until: z
          .string()
          .optional()
          .describe(
            "ISO8601 timestamp — drop events with ts > until.",
          ),
      },
      outputSchema: {
        runs: z.number().describe("Count of review_started or review_finished events."),
        bypasses: z.number().describe("Count of gate_bypassed events."),
        by_critic: z
          .record(
            z.object({
              starts: z.number(),
              finishes: z.number(),
              errors: z.number(),
              approved: z.number(),
              changes_requested: z.number(),
              total_findings: z.number(),
              total_blockers: z.number(),
              total_high: z.number(),
            }),
          )
          .describe("Per-critic-id stats over the window."),
        by_verdict: z
          .object({
            approved: z.number(),
            changes_requested: z.number(),
          })
          .describe("Aggregate verdict counts."),
        window: z
          .object({
            since: z.string().optional(),
            until: z.string().optional(),
            events_in_window: z.number(),
            events_total: z.number(),
          })
          .describe(
            "Window metadata so callers can sanity-check the filter.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ since, until }) => {
      const cwd = resolve(opts.cwd ?? process.cwd());
      let loaded;
      try {
        loaded = await loadAgentReviewConfig({ cwd });
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `**df_stats**: failed to load .agent-review/config.json — ${
                  (err as Error).message
                }`,
            },
          ],
        };
      }
      const artifactDir = await resolveArtifactDir(loaded);
      const path = telemetryPath(artifactDir);
      const events = readTelemetryEvents(path);
      const result = mapStatsForSpec(events, since, until);
      const summary = [
        `**df_stats**: ${result.runs} run(s), ${result.bypasses} bypass(es)`,
        `  window: ${since ?? "(unbounded)"} → ${until ?? "(unbounded)"} (${result.window.events_in_window}/${result.window.events_total} events)`,
        `  verdicts: approved=${result.by_verdict.approved}, changes_requested=${result.by_verdict.changes_requested}`,
        `  critics: ${Object.keys(result.by_critic).join(", ") || "(none)"}`,
      ].join("\n");
      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: [{ type: "text", text: summary }],
      };
    },
  );

  server.registerTool(
    "df_gate_push",
    {
      title: "Evaluate the pre-push gate for a pushed range",
      description:
        "Evaluate `df gate-push`'s gate against each commit in a " +
        "git pre-push protocol range. The `stdin_protocol` input is " +
        "what git would write to the husky pre-push hook's stdin — " +
        "newline-separated `<localRef> <localSha> <remoteRef> " +
        "<remoteSha>` lines. Returns the aggregate verdict + " +
        "per-commit blocking reasons. Read-only (does not push, " +
        "does not write artifacts).",
      inputSchema: {
        stdin_protocol: z
          .string()
          .describe(
            "Git pre-push protocol content (the same text git writes " +
              "to a husky pre-push hook's stdin). Format: one line per " +
              "ref update, `<localRef> <localSha> <remoteRef> " +
              "<remoteSha>`, separated by newlines.",
          ),
        profile: z
          .string()
          .optional()
          .describe(
            "Profile name (overrides AGENT_REVIEW_PROFILE env). " +
              "Defaults to `local`.",
          ),
      },
      outputSchema: {
        verdict: z
          .enum(["block", "allow", "bypass-required"])
          .describe(
            "'allow' — all commits pass. 'block' — at least one " +
              "commit blocked AND policy.allowEmergencyBypass is false " +
              "(no override path). 'bypass-required' — at least one " +
              "commit blocked but policy permits emergency bypass; an " +
              "agent client can prompt the user for a reason and call " +
              "df_bypass.",
          ),
        reasons: z
          .array(
            z.object({
              commit: z.string(),
              criticId: z.string().optional(),
              reason: z.string(),
              detail: z.string().optional(),
            }),
          )
          .describe(
            "Per-commit blocking reasons (empty when verdict=allow).",
          ),
        commits_evaluated: z
          .number()
          .describe("How many commits the input range contained."),
        bypass_allowed: z
          .boolean()
          .describe(
            "Mirror of loaded config policy.allowEmergencyBypass — set " +
              "regardless of verdict for client UX.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ stdin_protocol, profile }) => {
      const cwd = resolve(opts.cwd ?? process.cwd());
      let loaded;
      try {
        loaded = await loadAgentReviewConfig({ cwd });
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `**df_gate_push**: failed to load .agent-review/config.json — ${
                  (err as Error).message
                }`,
            },
          ],
        };
      }

      const profileName = resolveProfile(
        { profile },
        process.env as { AGENT_REVIEW_PROFILE?: string | undefined },
      );

      const updates = parsePrePushUpdates(stdin_protocol);
      const reasons: DfGatePushReason[] = [];
      let blocked = false;
      let commitsEvaluated = 0;

      for (const update of updates) {
        if (update.isDelete) continue;
        const commits = await commitsForPushUpdate(update, cwd);
        for (const sha of commits) {
          commitsEvaluated += 1;
          const gateRes = await runCommitGate({
            loaded,
            commit: sha,
            cwd,
            profileName,
          });
          if (gateRes.blocked) {
            blocked = true;
            for (const block of gateRes.blocks) {
              reasons.push({
                commit: sha,
                ...(block.criticId !== undefined ? { criticId: block.criticId } : {}),
                reason: block.reason,
                ...(block.detail !== undefined ? { detail: block.detail } : {}),
              });
            }
          }
        }
      }

      const allowBypass = loaded.config.policy.allowEmergencyBypass;
      const verdict: DfGatePushVerdict = !blocked
        ? "allow"
        : allowBypass
          ? "bypass-required"
          : "block";

      const result: DfGatePushResult = {
        verdict,
        reasons,
        commits_evaluated: commitsEvaluated,
        bypass_allowed: allowBypass,
      };

      const summary =
        `**df_gate_push**: ${verdict} — ${commitsEvaluated} commit(s) evaluated, ` +
        `${reasons.length} blocking reason(s)${
          verdict === "bypass-required"
            ? " (policy permits emergency bypass)"
            : verdict === "block"
              ? " (no bypass path — policy.allowEmergencyBypass=false)"
              : ""
        }`;
      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: [{ type: "text", text: summary }],
      };
    },
  );
}
