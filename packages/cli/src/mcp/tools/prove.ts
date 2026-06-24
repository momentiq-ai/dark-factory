// df_prove MCP tool — Cycle 331.1 verifiable-objectives (#207).
//
// The agent-facing half of "declare victory with proof": returns the
// BoundProofRecord for a commit — each declared objective joined against its
// local evidence and resolved to proven / pending / failed — so an MCP-driven
// agent can cite the proof at closeout instead of asserting "done".
//
// Shares the exact join core with the `df prove` CLI (evidence/prove.ts), so the
// MCP structuredContent and `df prove --json` stay byte-equivalent. Trust
// boundary: agent-attested, evidence-backed (not independent verification).

import { resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BoundProofRecord } from "@momentiq/dark-factory-schemas";

import { buildProofRecord, collectProofInputs } from "../../evidence/prove.js";
import { resolveCommit } from "../../git.js";

export interface RegisterProveToolOptions {
  // Test override; production defaults to process.cwd() (where `df mcp` launched).
  cwd?: string;
  // Injectable clock for deterministic tests.
  now?: () => string;
}

function renderProofMarkdown(record: BoundProofRecord): string {
  const s = record.summary;
  if (s.total === 0) {
    return `**df_prove**: ${record.commit.slice(0, 12)} — no objectives declared (.darkfactory/objectives.yaml absent or empty).`;
  }
  const glyph: Record<string, string> = { proven: "✓", pending: "…", failed: "✗" };
  const lines = [
    `**df_prove**: ${record.commit.slice(0, 12)} — ${s.proven} proven · ${s.pending} pending · ${s.failed} failed (${s.total} total)`,
  ];
  for (const o of record.objectives) {
    lines.push(
      `  ${glyph[o.status] ?? "?"} ${o.id} [${o.status}, ${o.sourceVerification}${o.enforced ? ", enforced" : ""}] — ${o.text}`,
    );
    for (const b of o.bindings) {
      lines.push(`      ${b.kind}[${b.ref}] ${b.status} — ${b.detail}`);
    }
  }
  return lines.join("\n");
}

const bindingZ = z.object({
  kind: z.string().describe("'route' | 'critic' | 'test' (mirrors the EvidenceBinding kind)."),
  ref: z.string().describe("routeId | criticId | test ref."),
  status: z.string().describe("'proven' | 'pending' | 'failed'."),
  detail: z.string().describe("Short human derivation of the status."),
  uploadId: z.string().optional().describe("Cerebe object id, present once df publish has run."),
});

const objectiveZ = z.object({
  id: z.string(),
  text: z.string(),
  enforced: z.boolean(),
  status: z.string().describe("'proven' | 'pending' | 'failed' — worst-of its bindings."),
  sourceVerification: z
    .string()
    .describe(
      "Faithfulness rung (spec §4.7): 'source-bound' | 'human-reviewed' | 'inferred' | " +
        "'agent-asserted' — how strongly the objective is bound to its source criterion.",
    ),
  bindings: z.array(bindingZ),
});

export function registerProveTool(server: McpServer, opts: RegisterProveToolOptions = {}): void {
  server.registerTool(
    "df_prove",
    {
      title: "Closeout proof readout: which objectives are proven by their evidence",
      description:
        "Join `.darkfactory/objectives.yaml` against the local evidence for a " +
        "commit (route exit codes from `df verify`, critic verdicts from " +
        "`df review`) and return a BoundProofRecord — each objective resolved to " +
        "proven / pending / failed. A `pending` binding awaits evidence (e.g. the " +
        "critic fleet has not run on HEAD yet), distinct from `failed`. Use this " +
        "at closeout to cite proof instead of asserting completion. " +
        "Agent-attested, evidence-backed — not independent verification.",
      inputSchema: {
        commit: z
          .string()
          .min(1)
          .describe("Commit reference accepted by `git rev-parse` (SHA, 'HEAD', branch)."),
      },
      outputSchema: {
        schemaVersion: z.number(),
        commit: z.string().describe("Resolved commit SHA."),
        diffHash: z.string().optional().describe("The gated diff hash evidence binds to."),
        provenance: z.string().describe("'consumer-attested' for the local readout."),
        generatedAt: z.string(),
        objectives: z.array(objectiveZ),
        summary: z.object({
          proven: z.number(),
          pending: z.number(),
          failed: z.number(),
          total: z.number(),
        }),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ commit }) => {
      const cwd = resolve(opts.cwd ?? process.cwd());
      const now = opts.now ?? (() => new Date().toISOString());
      let record: BoundProofRecord;
      try {
        const collected = await collectProofInputs(cwd, commit);
        if (collected) {
          record = buildProofRecord(collected.inputs, now());
        } else {
          // No manifest → an empty record (the "no objectives declared" signal).
          // Still resolve the ref to a SHA so `commit` matches the contract (a
          // resolved SHA) regardless of whether a manifest exists.
          const sha = await resolveCommit(commit, cwd);
          record = buildProofRecord({ commit: sha, objectives: [], gateResults: {}, criticResults: {} }, now());
        }
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `**df_prove**: error for "${commit}" — ${(err as Error).message}` }],
        };
      }
      return {
        structuredContent: record as unknown as Record<string, unknown>,
        content: [{ type: "text", text: renderProofMarkdown(record) }],
      };
    },
  );
}
