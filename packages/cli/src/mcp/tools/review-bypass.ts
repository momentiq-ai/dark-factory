// df_review + df_review_status + df_bypass MCP tools — cycle5 Phase 1 step 6.
//
// The first non-readonly tools in the catalog. df_review is async by
// design — the cycle5 spec explicitly notes that critic runs have
// unbounded latency, so the tool returns a job_id immediately and the
// agent polls df_review_status. df_bypass appends an audit entry to
// the same _runs.ndjson the husky hook writes to (uniform stats
// surface across CLI + MCP).
//
// Spec output shapes (from docs/roadmap/cycles/cycle5-mcp-server.md):
//
//   df_review →
//     { job_id, started_at, expected_completion_seconds }
//
//   df_review_status →
//     { status: 'running'|'completed'|'errored', verdict?, findings? }
//
//   df_bypass →
//     { audit_entry_id, recorded_at }
//
// Job-state lifecycle: per-MCP-server-process Map. A job is created
// on df_review, transitions to 'completed' or 'errored' when the
// underlying `runReview` promise settles, and stays in the map until
// the process exits. We don't garbage-collect — the count is bounded
// by the number of df_review invocations in a single MCP session,
// which is in the dozens at most. If memory ever becomes a concern,
// add an LRU cap (out of scope for step 6).

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type {
  ReviewVerdict,
  TelemetryEvent,
} from "@momentiq/dark-factory-schemas";

import { AdapterRegistry } from "../../adapters/critic.js";
import type { CriticAdapter } from "../../adapters/critic.js";
import {
  FileTelemetrySink,
  type TelemetrySink,
} from "../../evidence/audit-trail.js";
import { resolveArtifactDir, telemetryPath } from "../../paths.js";
import { loadAgentReviewConfig } from "../../policy/config.js";
import { resolveProfile } from "../../policy/profile.js";
import { runReview, type ReviewRunOptions, type ReviewRunOutcome } from "../../runner.js";
import {
  mapArtifactForFindings,
  type DfFindingsResult,
} from "../../lib/show-status-core.js";

const EXPECTED_REVIEW_SECONDS = 60;

interface JobState {
  jobId: string;
  commit: string;
  profile?: string;
  startedAt: string;
  status: "running" | "completed" | "errored";
  verdict?: ReviewVerdict;
  findings?: DfFindingsResult;
  error?: string;
  finishedAt?: string;
}

export interface RegisterReviewBypassToolsOptions {
  cwd?: string;
  /**
   * Test-only escape hatch — substitute `runReview` with a stub so
   * unit tests don't have to instantiate the vendor adapter fleet.
   * Production code leaves this undefined; the real `runReview` ships.
   */
  _internalRunReview?: (options: ReviewRunOptions) => Promise<ReviewRunOutcome>;
}

function generateJobId(): string {
  // 16 hex chars = 64 bits of entropy. Plenty for in-process uniqueness
  // even at high call volumes.
  return `job_${randomBytes(8).toString("hex")}`;
}

// step 10 — tee telemetry events into MCP logging/message
// notifications so clients can render in-flight progress while
// df_review's runReview is running. Wraps an inner TelemetrySink
// (the FileTelemetrySink that writes _runs.ndjson) and ALSO calls
// the supplied notify() callback with a human-readable line.
// notify() is best-effort: failures are swallowed so a flaky
// transport never corrupts the audit trail.
class LoggingTeeSink implements TelemetrySink {
  constructor(
    private readonly inner: TelemetrySink,
    private readonly notify: (level: "info" | "warning" | "error", text: string) => void,
  ) {}
  emit(event: TelemetryEvent): void {
    this.inner.emit(event);
    const line = formatEventForLog(event);
    if (line) {
      const level: "info" | "warning" | "error" =
        event.event === "review_error" ||
        event.event === "critic_run_error" ||
        event.event === "gate_blocked"
          ? "error"
          : event.event === "gate_bypassed" ||
              event.event === "rubric_strip" ||
              event.event === "cache_invalidated_reason"
            ? "warning"
            : "info";
      this.notify(level, line);
    }
  }
}

function formatEventForLog(event: TelemetryEvent): string | null {
  // Map the canonical event types to a one-line operator-friendly
  // status the client can render inline. Returns null for events
  // we don't care to surface to the client — those still hit the
  // FileTelemetrySink so the audit trail stays complete.
  const sha = event.commit ? ` ${event.commit.slice(0, 12)}` : "";
  const critic = event.criticId ? ` (${event.criticId})` : "";
  switch (event.event) {
    case "review_started":
      return `[df] review started${sha}`;
    case "critic_run_started":
      return `[df] running critic${critic}${sha}`;
    case "critic_run_finished": {
      const verdict = event.verdict ? `: ${event.verdict}` : "";
      const dur =
        event.durationMs !== undefined ? ` in ${event.durationMs}ms` : "";
      return `[df] critic finished${critic}${verdict}${dur}`;
    }
    case "critic_run_error":
      return `[df] critic errored${critic}: ${event.error ?? "(no message)"}`;
    case "review_finished":
      return `[df] review finished${sha}${
        event.verdict ? `: ${event.verdict}` : ""
      }`;
    case "review_error":
      return `[df] review errored${sha}: ${event.error ?? "(no message)"}`;
    case "gate_passed":
      return `[df] gate passed${sha}`;
    case "gate_blocked":
      return `[df] gate BLOCKED${sha}`;
    case "gate_bypassed":
      return `[df] gate bypassed${sha}: ${event.bypassReason ?? "(no reason)"}`;
    default:
      return null;
  }
}

type ElicitedIssueOutcome =
  | { kind: "url"; url: string }
  | { kind: "no-issue" }
  | { kind: "declined" }
  | { kind: "cancelled" }
  | { kind: "skipped" };

async function tryElicitIssueUrl(server: McpServer): Promise<ElicitedIssueOutcome> {
  // Cycle5 step 9 — wire elicitation/create for df_bypass's
  // missing-issue case. The MCP spec's elicitation primitive lets
  // the server prompt the user mid-tool-call for clarification.
  // We ask for one of:
  //   - issue_url (URL string)
  //   - no_issue_needed (boolean checkbox)
  // The user submits the form; we observe their answer.
  //
  // Clients that don't support elicitation throw (the underlying
  // Server.elicitInput asserts the client capability). We catch
  // and return 'skipped' so the caller falls back to the
  // soft-warning behavior — backward-compatible for older clients.
  let result;
  try {
    result = await server.server.elicitInput({
      message:
        "This bypass should cite a tracking issue. Paste the issue URL " +
        "(GitHub, Linear, etc.), OR check 'no_issue_needed' to confirm " +
        "the bypass is intentional without a tracking artifact.",
      requestedSchema: {
        type: "object" as const,
        properties: {
          issue_url: {
            type: "string" as const,
            title: "Issue URL",
            description:
              "Link to the tracking issue (https:// URL). Leave empty " +
              "if you're explicitly choosing not to cite one.",
          },
          no_issue_needed: {
            type: "boolean" as const,
            title: "No issue needed",
            description:
              "Check this to confirm an intentional bypass without " +
              "a tracking issue. The audit log records the explicit " +
              "waiver.",
          },
        },
        required: [],
      },
    });
  } catch {
    return { kind: "skipped" };
  }

  if (result.action === "decline") return { kind: "declined" };
  if (result.action === "cancel") return { kind: "cancelled" };
  // action === 'accept'
  const content = result.content as
    | { issue_url?: string; no_issue_needed?: boolean }
    | undefined;
  const url = content?.issue_url?.trim();
  if (url && /^https?:\/\//.test(url)) {
    return { kind: "url", url };
  }
  if (content?.no_issue_needed === true) {
    return { kind: "no-issue" };
  }
  // Accepted but neither URL nor checkbox — treat as soft-skip so the
  // user sees a warning. Same shape as a client without elicitation.
  return { kind: "skipped" };
}

const ADAPTER_LOADERS: ReadonlyArray<{
  readonly id: string;
  readonly modulePath: string;
  readonly className: string;
}> = [
  { id: "cursor-sdk", modulePath: "../../adapters/cursor-sdk.js", className: "CursorSdkAdapter" },
  { id: "codex-sdk", modulePath: "../../adapters/codex-sdk.js", className: "CodexSdkAdapter" },
  { id: "gemini-sdk", modulePath: "../../adapters/gemini-sdk.js", className: "GeminiSdkAdapter" },
  { id: "grok-direct-sdk", modulePath: "../../adapters/grok-direct-sdk.js", className: "GrokDirectSdkAdapter" },
];

async function buildAdapterRegistry(): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  for (const loader of ADAPTER_LOADERS) {
    try {
      const mod = (await import(loader.modulePath)) as Record<string, unknown>;
      const Ctor = mod[loader.className] as (new () => CriticAdapter) | undefined;
      if (typeof Ctor === "function") {
        registry.register(new Ctor());
      }
    } catch {
      // adapter unloadable — runReview will degrade per its
      // min-complete-quorum semantics.
    }
  }
  return registry;
}

export function registerReviewBypassTools(
  server: McpServer,
  opts: RegisterReviewBypassToolsOptions = {},
): void {
  // Per-server job registry. Each createMcpServer() call gets its
  // own Map (created on registration), so tests don't leak job state
  // across `createMcpServer({ cwd: fixtureA })` /
  // `createMcpServer({ cwd: fixtureB })` invocations.
  const jobs = new Map<string, JobState>();
  const runReviewFn = opts._internalRunReview ?? runReview;

  // df_review --------------------------------------------------------
  server.registerTool(
    "df_review",
    {
      title: "Run a critic review (async)",
      description:
        "Kick off the multi-vendor adversarial critic against a " +
        "commit. Returns a `job_id` immediately; the review runs in " +
        "the background. Poll `df_review_status` with the same " +
        "job_id to retrieve the verdict + findings once complete. " +
        "Honors `AGENT_REVIEW_PROFILE` for subscription-auth pinning.",
      inputSchema: {
        commit: z
          .string()
          .min(1)
          .describe("Git ref to review — anything `git rev-parse` accepts."),
        profile: z
          .string()
          .optional()
          .describe(
            "Profile name (default: env AGENT_REVIEW_PROFILE or 'local'). " +
              "Pins per-critic `auth` so subscription-auth flows are " +
              "honored — see profile docs in @momentiq/dark-factory-cli.",
          ),
      },
      outputSchema: {
        job_id: z
          .string()
          .describe("Opaque identifier — pass back to df_review_status."),
        started_at: z
          .string()
          .describe("ISO8601 timestamp of when the job started running."),
        expected_completion_seconds: z
          .number()
          .describe(
            "Approximate seconds until completion based on the cycle's " +
              "default profile budget. Real time may exceed this.",
          ),
      },
      annotations: {
        // The cycle5 spec lists df_review as "not-readOnly, idempotent".
        // It writes a per-SHA artifact and a telemetry entry, so
        // readOnlyHint=false. It IS idempotent in the sense that
        // repeat invocations for the same commit produce the same
        // artifact (modulo non-determinism of the LLM fleet) — but
        // we conservatively report `idempotentHint: false` because the
        // artifact gets re-written each call, which is a real
        // side-effect that callers should be aware of.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ commit, profile }) => {
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
              text: `**df_review**: failed to load .agent-review/config.json — ${
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

      const registry = await buildAdapterRegistry();
      const artifactDir = await resolveArtifactDir(loaded);
      const fileSink = new FileTelemetrySink(telemetryPath(artifactDir));
      // Tee into MCP logging/message so the client sees in-flight
      // progress. Notifications are best-effort — sendLoggingMessage
      // rejections never abort the underlying review.
      const sink = new LoggingTeeSink(fileSink, (level, text) => {
        server.server
          .sendLoggingMessage({ level, logger: "df_review", data: text })
          .catch(() => {
            // swallow — client may not have subscribed.
          });
      });

      const jobId = generateJobId();
      const startedAt = new Date().toISOString();
      const job: JobState = {
        jobId,
        commit,
        ...(profile !== undefined ? { profile } : {}),
        startedAt,
        status: "running",
      };
      jobs.set(jobId, job);

      // Fire and forget. The agent polls df_review_status to retrieve
      // the outcome. Errors are captured into job.error so they're
      // recoverable by the agent (not silently swallowed).
      runReviewFn({
        loaded,
        registry,
        ref: commit,
        telemetry: sink,
        profileName,
      })
        .then((outcome) => {
          job.status = "completed";
          if (outcome.artifact.gateVerdict !== undefined) {
            job.verdict = outcome.artifact.gateVerdict;
          }
          job.findings = mapArtifactForFindings(outcome.artifact);
          job.finishedAt = new Date().toISOString();
        })
        .catch((err: unknown) => {
          job.status = "errored";
          job.error = err instanceof Error ? err.message : String(err);
          job.finishedAt = new Date().toISOString();
        });

      return {
        structuredContent: {
          job_id: jobId,
          started_at: startedAt,
          expected_completion_seconds: EXPECTED_REVIEW_SECONDS,
        } as Record<string, unknown>,
        content: [
          {
            type: "text",
            text:
              `**df_review**: kicked off review of ${commit} (job ${jobId.slice(
                0,
                12,
              )}…). Poll df_review_status for the verdict.`,
          },
        ],
      };
    },
  );

  // df_review_status -------------------------------------------------
  server.registerTool(
    "df_review_status",
    {
      title: "Poll a running review",
      description:
        "Look up the status of a review started via df_review. " +
        "Returns 'running' while the review is in flight, " +
        "'completed' with verdict + findings once done, or 'errored' " +
        "with the failure reason.",
      inputSchema: {
        job_id: z.string().min(1).describe("Job id returned by df_review."),
      },
      outputSchema: {
        status: z
          .enum(["running", "completed", "errored"])
          .describe("Lifecycle phase."),
        verdict: z
          .enum(["APPROVED", "CHANGES_REQUESTED"])
          .optional()
          .describe("Set when status='completed'."),
        findings: z
          .object({
            commit: z.string(),
            critics: z.array(
              z.object({
                id: z.string(),
                status: z.string(),
                verdict: z.string().optional(),
                findings: z.array(
                  z.object({
                    severity: z.string(),
                    file: z.string().optional(),
                    line: z.number().optional(),
                    rule: z.string(),
                    message: z.string(),
                  }),
                ),
              }),
            ),
          })
          .optional()
          .describe(
            "Narrowed findings (same shape as df_findings) — set when " +
              "status='completed'.",
          ),
        error: z
          .string()
          .optional()
          .describe("Set when status='errored'."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      const job = jobs.get(job_id);
      if (!job) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `**df_review_status**: job "${job_id}" not found. (Job state lives only in the current MCP server process.)`,
            },
          ],
        };
      }
      const structured: Record<string, unknown> = { status: job.status };
      if (job.verdict !== undefined) structured.verdict = job.verdict;
      if (job.findings !== undefined) structured.findings = job.findings;
      if (job.error !== undefined) structured.error = job.error;

      const tail =
        job.status === "completed" && job.verdict
          ? ` verdict=${job.verdict}`
          : job.status === "errored"
            ? ` error="${job.error ?? "(unknown)"}"`
            : "";
      return {
        structuredContent: structured,
        content: [
          {
            type: "text",
            text: `**df_review_status**: ${job.status}${tail}`,
          },
        ],
      };
    },
  );

  // df_bypass --------------------------------------------------------
  server.registerTool(
    "df_bypass",
    {
      title: "Record an emergency bypass",
      description:
        "Record a structured emergency-bypass audit entry into " +
        "`.git/agent-reviews/_runs.ndjson` (the same file the husky " +
        "hook writes to, so `df stats` aggregates uniformly). " +
        "Requires a structured `reason`; an `issue_url` is " +
        "RECOMMENDED — tools that omit it get a soft warning today " +
        "and may be rejected in a future cycle once the policy " +
        "tightens.",
      inputSchema: {
        reason: z
          .string()
          .min(1)
          .describe(
            "Free-form bypass reason. Should explain WHY the bypass " +
              "is necessary and reference any tracking artifact.",
          ),
        sha: z
          .string()
          .min(1)
          .describe(
            "Commit SHA the bypass applies to. The audit entry binds " +
              "the bypass to this specific SHA so `df show` and the " +
              "dashboard can surface it correctly.",
          ),
        issue_url: z
          .string()
          .optional()
          .describe(
            "RECOMMENDED. Link to the tracking issue (GitHub URL, " +
              "Linear ticket, etc.). Bypasses without this get a " +
              "structured-warning string on the response.",
          ),
      },
      outputSchema: {
        audit_entry_id: z
          .string()
          .describe(
            "Stable opaque id for the audit entry — surfaces in the " +
              "telemetry NDJSON's `bypassId` field.",
          ),
        recorded_at: z
          .string()
          .describe("ISO8601 timestamp the entry was appended."),
        warnings: z
          .array(z.string())
          .describe(
            "Soft-warning strings (empty when the bypass meets all " +
              "recommendations).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ reason, sha, issue_url }) => {
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
              text: `**df_bypass**: failed to load .agent-review/config.json — ${
                (err as Error).message
              }`,
            },
          ],
        };
      }
      const artifactDir = await resolveArtifactDir(loaded);
      const sink = new FileTelemetrySink(telemetryPath(artifactDir));

      // Cycle5 step 9 — elicit a missing issue_url. When the caller
      // didn't pass issue_url AND the client declares the elicitation
      // capability, ask the user to either paste a URL or confirm
      // "no issue needed". The result is captured in the audit
      // entry's bypassReason metadata prefix:
      //   - URL provided  → `issue:<url>` (same shape as the
      //                     argument-supplied case)
      //   - No issue      → `no-issue:elicited` (records that the
      //                     user explicitly waived the issue link)
      //   - Decline/cancel → original soft-warning behavior (record
      //                     without metadata) — equivalent to the
      //                     pre-step-9 path
      // Clients that don't support elicitation skip this branch and
      // fall through to the soft warning, preserving backward compat.
      const warnings: string[] = [];
      let elicitedIssueUrl: string | undefined;
      let elicitedNoIssue = false;
      if (!issue_url) {
        const elicited = await tryElicitIssueUrl(server);
        if (elicited.kind === "url") {
          elicitedIssueUrl = elicited.url;
        } else if (elicited.kind === "no-issue") {
          elicitedNoIssue = true;
        } else if (elicited.kind === "skipped") {
          // Client doesn't support elicitation OR elicitation threw.
          // Same soft-warning as before — preserves backward compat.
          warnings.push(
            "issue_url missing — bypasses should cite a tracking issue. " +
              "This is a soft warning today; future cycles may enforce.",
          );
        }
        // 'declined' / 'cancelled' → no warning + no metadata; the
        // user explicitly chose not to engage with the prompt.
      }

      const auditEntryId = `bypass_${randomBytes(8).toString("hex")}`;
      const recordedAt = new Date().toISOString();
      // TelemetryEvent's schema doesn't carry custom fields like
      // bypassId / bypassIssueUrl / bypassSource — extending it would
      // be a separate cycle. So we encode the structured metadata
      // (audit_entry_id, issue_url, source, elicited-no-issue) as a
      // prefix on bypassReason. `df stats` reads the raw reason
      // verbatim, so this is human-readable AND machine-parseable.
      // The audit_entry_id stays in the response as a transient
      // correlation handle clients can log internally.
      const metaParts: string[] = [`mcp:${auditEntryId}`];
      const finalIssueUrl = issue_url ?? elicitedIssueUrl;
      if (finalIssueUrl) metaParts.push(`issue:${finalIssueUrl}`);
      if (elicitedNoIssue) metaParts.push("no-issue:elicited");
      const reasonWithMeta = `[${metaParts.join(" ")}] ${reason}`;
      const event: TelemetryEvent = {
        ts: recordedAt,
        event: "gate_bypassed",
        commit: sha,
        bypassReason: reasonWithMeta,
      };
      sink.emit(event);

      const structured: Record<string, unknown> = {
        audit_entry_id: auditEntryId,
        recorded_at: recordedAt,
        warnings,
      };
      return {
        structuredContent: structured,
        content: [
          {
            type: "text",
            text: [
              `**df_bypass**: recorded ${auditEntryId} for ${sha.slice(0, 12)} at ${recordedAt}`,
              warnings.length > 0 ? `  warnings: ${warnings.join("; ")}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    },
  );
}
