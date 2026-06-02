// df_findings + df_show_run MCP tools — cycle5 Phase 1 step 3b.
//
// Both tools read the per-commit `.git/agent-reviews/<sha>.json`
// artifact written by `df review`. The agent client is expected to
// pass a commit SHA (resolved via git rev-parse outside the tool);
// callers that want HEAD can do `df_findings({commit: "HEAD"})` and we
// resolve here.
//
// Spec output shapes (from docs/roadmap/cycles/cycle5-mcp-server.md):
//
//   df_findings →
//     { commit, critics: [{ id, status, verdict?, findings: [
//         { severity, file?, line?, rule, message } ]}] }
//
//   df_show_run →
//     { artifact: <full review artifact JSON> }
//
// All shape construction lives in `src/lib/show-status-core.ts` so the
// MCP tools and their CLI mirrors (`df status`, `df show`) stay byte-
// equivalent — see that module for the field-mapping rationale and the
// layering contract (lib does not depend on commands/ or mcp/).

import { resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ReviewArtifact } from "@momentiq/dark-factory-schemas";

import {
  loadForCommit,
  mapArtifactForFindings,
  type DfFindingsResult,
} from "../../lib/show-status-core.js";

export interface RegisterFindingsToolsOptions {
  /**
   * Optional cwd override — tests pass a fixture repo root. Production
   * code lets it default to `process.cwd()` (where the agent client
   * launched `df mcp`).
   */
  cwd?: string;
}

function renderFindingsMarkdown(
  result: DfFindingsResult | null,
  commitInput: string,
  resolvedSha: string | null,
  errorMessage: string | undefined,
): string {
  if (errorMessage) {
    return `**df_findings**: error for "${commitInput}"${resolvedSha ? ` (resolved ${resolvedSha.slice(0, 12)})` : ""} — ${errorMessage}`;
  }
  if (!result) {
    return `**df_findings**: no result for "${commitInput}".`;
  }
  const totalFindings = result.critics.reduce((n, c) => n + c.findings.length, 0);
  const lines = [
    `**df_findings**: ${result.commit.slice(0, 12)} — ${result.critics.length} critic(s), ${totalFindings} finding(s)`,
  ];
  for (const c of result.critics) {
    const head = `  - ${c.id} [${c.status}${c.verdict ? `, ${c.verdict}` : ""}] — ${c.findings.length} finding(s)`;
    lines.push(head);
    for (const f of c.findings) {
      const loc = f.file
        ? `${f.file}${typeof f.line === "number" ? `:${f.line}` : ""}`
        : "(no file)";
      lines.push(`    • [${f.severity}] ${f.rule}: ${loc} — ${f.message}`);
    }
  }
  return lines.join("\n");
}

function renderShowRunMarkdown(
  artifact: ReviewArtifact | null,
  commitInput: string,
  resolvedSha: string | null,
  errorMessage: string | undefined,
): string {
  if (errorMessage) {
    return `**df_show_run**: error for "${commitInput}"${resolvedSha ? ` (resolved ${resolvedSha.slice(0, 12)})` : ""} — ${errorMessage}`;
  }
  if (!artifact) {
    return `**df_show_run**: no artifact for "${commitInput}".`;
  }
  return [
    `**df_show_run**: ${artifact.commit.slice(0, 12)} (${artifact.status})`,
    `  verdict: ${artifact.gateVerdict ?? "(pending)"}`,
    `  critics: ${artifact.criticResults.length}`,
    `  diffHash: ${artifact.diffHash}`,
    `  createdAt: ${artifact.createdAt}${artifact.updatedAt ? ` · updatedAt: ${artifact.updatedAt}` : ""}`,
  ].join("\n");
}

const findingZ = z.object({
  severity: z
    .string()
    .describe("Severity tag from the source ReviewFinding ('blocker' | 'high' | 'medium' | 'low' | 'note')."),
  file: z
    .string()
    .optional()
    .describe("File path the critic cites, when present."),
  line: z
    .number()
    .optional()
    .describe("Line number the critic cites, when present."),
  rule: z
    .string()
    .describe(
      "Rule-like classifier — maps to the source ReviewFinding.category. " +
        "Critic-supplied; format depends on the critic.",
    ),
  message: z
    .string()
    .describe(
      "Concrete evidence text from the critic. For full impact + " +
        "remediation context call df_show_run on the same commit.",
    ),
});

const criticZ = z.object({
  id: z.string().describe("Critic id (e.g. 'cursor-local-chief-engineer')."),
  status: z
    .string()
    .describe("'pending' | 'running' | 'complete' | 'error'."),
  verdict: z
    .string()
    .optional()
    .describe("'APPROVED' | 'CHANGES_REQUESTED', when set."),
  findings: z.array(findingZ),
});

export function registerFindingsTools(
  server: McpServer,
  opts: RegisterFindingsToolsOptions = {},
): void {
  server.registerTool(
    "df_findings",
    {
      title: "Read review findings for a commit",
      description:
        "Read the per-critic findings recorded for a commit by " +
        "`df review`. Returns the narrowed view: severity, file, line, " +
        "rule, message. For full artifact context (verdict reasoning, " +
        "quality-gate evidence, retry counts) call df_show_run.",
      inputSchema: {
        commit: z
          .string()
          .min(1)
          .describe(
            "Commit reference — anything `git rev-parse` accepts " +
              "(SHA, 'HEAD', branch name, ref). Resolved server-side.",
          ),
      },
      outputSchema: {
        commit: z
          .string()
          .describe("Resolved commit SHA the artifact records."),
        critics: z.array(criticZ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ commit }) => {
      const cwd = resolve(opts.cwd ?? process.cwd());
      const outcome = await loadForCommit(cwd, commit);
      if (!outcome.artifact) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: renderFindingsMarkdown(
                null,
                commit,
                outcome.resolvedSha,
                outcome.error,
              ),
            },
          ],
        };
      }
      const result = mapArtifactForFindings(outcome.artifact);
      return {
        structuredContent: result as unknown as Record<string, unknown>,
        content: [
          {
            type: "text",
            text: renderFindingsMarkdown(
              result,
              commit,
              outcome.resolvedSha,
              undefined,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "df_show_run",
    {
      title: "Read the full review artifact for a commit",
      description:
        "Read the unmodified ReviewArtifact JSON for a commit — verdict, " +
        "per-critic results (status, findings with full evidence + " +
        "impact + requiredFix), validation evidence, range, diff hash, " +
        "bypass record (if any). For the narrowed-findings view see " +
        "df_findings.",
      inputSchema: {
        commit: z
          .string()
          .min(1)
          .describe(
            "Commit reference accepted by `git rev-parse` (SHA, " +
              "'HEAD', branch, etc.).",
          ),
      },
      outputSchema: {
        // The artifact is the exact shape `@momentiq/dark-factory-schemas`
        // defines as `ReviewArtifact`. We expose it as a generic
        // record-of-unknown to keep the MCP schema small + future-
        // proof to schema-additive changes; clients that need typed
        // access can re-parse with `parseReviewArtifact`.
        artifact: z
          .record(z.unknown())
          .describe(
            "Full ReviewArtifact JSON as written by `df review`. " +
              "See @momentiq/dark-factory-schemas for the typed shape.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ commit }) => {
      const cwd = resolve(opts.cwd ?? process.cwd());
      const outcome = await loadForCommit(cwd, commit);
      if (!outcome.artifact) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: renderShowRunMarkdown(
                null,
                commit,
                outcome.resolvedSha,
                outcome.error,
              ),
            },
          ],
        };
      }
      const artifactRecord = outcome.artifact as unknown as Record<string, unknown>;
      return {
        structuredContent: { artifact: artifactRecord },
        content: [
          {
            type: "text",
            text: renderShowRunMarkdown(
              outcome.artifact,
              commit,
              outcome.resolvedSha,
              undefined,
            ),
          },
        ],
      };
    },
  );
}
