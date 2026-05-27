// Conformance snapshot test — cycle5 Phase 1 step 11.
//
// Captures the FULL tools + resources + prompts catalog (names,
// titles, descriptions, annotations, input/output schemas) and
// pins it as a vitest snapshot. Any drift fails this test in CI;
// updating the snapshot requires intentional `vitest -u` in the
// same PR + a justification in the PR body. This is the
// "OpenAPI-equivalent contract diff" the cycle5 spec calls for:
//
//   "An emitted OpenAPI-equivalent of the MCP tool catalog is
//    checked into the repo and diffed in CI. Drift requires
//    intentional schema bump."
//
// The snapshot lives at tests/mcp/__snapshots__/conformance.test.
// ts.snap and is part of the committed PR diff — reviewers can
// see exactly what tools/resources/prompts a PR adds, changes, or
// removes without rummaging through the test file.
//
// We do NOT snapshot the templated-list output for resources/list
// (those vary by what's on disk); the snapshot covers only the
// static catalog + the templates themselves.

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../../src/mcp/server.js";

interface CatalogSnapshot {
  tools: Array<{
    name: string;
    title?: string;
    description?: string;
    annotations?: unknown;
    inputSchema?: unknown;
    outputSchema?: unknown;
  }>;
  resourceTemplates: Array<{
    uriTemplate: string;
    name?: string;
    description?: string;
    mimeType?: string;
  }>;
  prompts: Array<{
    name: string;
    title?: string;
    description?: string;
    arguments?: Array<{
      name: string;
      description?: string;
      required?: boolean;
    }>;
  }>;
}

async function captureCatalog(): Promise<CatalogSnapshot> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "conformance-snapshot", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    const templates = await client.listResourceTemplates();
    const prompts = await client.listPrompts();

    // Normalize: strip non-schema fields that aren't part of the
    // contract (the SDK injects an `execution` block on every tool
    // that isn't part of the cycle5 catalog spec — we exclude it
    // so non-meaningful SDK churn doesn't break the snapshot).
    const normalizedTools = [...tools.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        const out: CatalogSnapshot["tools"][number] = { name: t.name };
        if (t.title !== undefined) out.title = t.title;
        if (t.description !== undefined) out.description = t.description;
        if (t.annotations !== undefined) out.annotations = t.annotations;
        if (t.inputSchema !== undefined) out.inputSchema = t.inputSchema;
        if (t.outputSchema !== undefined) out.outputSchema = t.outputSchema;
        return out;
      });

    const normalizedTemplates = [...templates.resourceTemplates]
      .sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate))
      .map((t) => {
        const out: CatalogSnapshot["resourceTemplates"][number] = {
          uriTemplate: t.uriTemplate,
        };
        if (t.name !== undefined) out.name = t.name;
        if (t.description !== undefined) out.description = t.description;
        if (t.mimeType !== undefined) out.mimeType = t.mimeType;
        return out;
      });

    const normalizedPrompts = [...prompts.prompts]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => {
        const out: CatalogSnapshot["prompts"][number] = { name: p.name };
        if (p.title !== undefined) out.title = p.title;
        if (p.description !== undefined) out.description = p.description;
        if (p.arguments !== undefined) {
          out.arguments = [...p.arguments]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((a) => {
              const out2: NonNullable<CatalogSnapshot["prompts"][number]["arguments"]>[number] = {
                name: a.name,
              };
              if (a.description !== undefined) out2.description = a.description;
              if (a.required !== undefined) out2.required = a.required;
              return out2;
            });
        }
        return out;
      });

    return {
      tools: normalizedTools,
      resourceTemplates: normalizedTemplates,
      prompts: normalizedPrompts,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe("MCP catalog conformance snapshot (cycle5 Phase 1 step 11)", () => {
  it("pins the full tools + resourceTemplates + prompts catalog", async () => {
    const snapshot = await captureCatalog();

    // Sanity counts — match the cycle5 Phase 1 catalog as of step 10:
    //   - 15 tools (steps 2 + 3a-d + 5 + 6 + 8)
    //   - 5 resource templates (3 path-templated + 2 query-templated)
    //   - 5 prompts (step 7)
    // Counts pinned BESIDES the full snapshot so a delta is easy to
    // spot in the failing-test output.
    expect(snapshot.tools.map((t) => t.name)).toEqual([
      "df_adr_generate",
      "df_adr_list",
      "df_adr_read",
      "df_bypass",
      "df_critics_config",
      "df_cycle_doc_generate",
      "df_cycle_list",
      "df_cycle_read",
      "df_doctor",
      "df_findings",
      "df_gate_push",
      "df_review",
      "df_review_status",
      "df_show_run",
      "df_stats",
    ]);
    expect(snapshot.resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      "df://repo/adr/{adr_id}",
      "df://repo/audit-log{?since}",
      "df://repo/cycle/{cycle_id}",
      "df://repo/findings/{commit_sha}",
      "df://repo/runs/recent{?limit}",
    ]);
    expect(snapshot.prompts.map((p) => p.name)).toEqual([
      "df.diagnose_critic_failure",
      "df.draft_adr",
      "df.onboarding_analysis",
      "df.summarize_recent_runs",
      "df.write_cycle_doc",
    ]);

    // Full catalog snapshot — descriptions, annotations, input/output
    // schemas. Updating this snapshot (via `vitest -u`) is the
    // intentional path for a contract change; the PR diff will show
    // reviewers exactly what shifted.
    expect(snapshot).toMatchSnapshot();
  });

  it("every tool has both inputSchema AND outputSchema declared", async () => {
    const snapshot = await captureCatalog();
    for (const tool of snapshot.tools) {
      expect(
        tool.inputSchema,
        `tool ${tool.name} missing inputSchema`,
      ).toBeDefined();
      expect(
        tool.outputSchema,
        `tool ${tool.name} missing outputSchema`,
      ).toBeDefined();
    }
  });

  it("every tool that writes (readOnlyHint=false) carries explicit destructiveHint + idempotentHint", async () => {
    const snapshot = await captureCatalog();
    const writeTools = snapshot.tools.filter(
      (t) =>
        (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint ===
        false,
    );
    expect(writeTools.length).toBeGreaterThan(0);
    for (const tool of writeTools) {
      const ann = tool.annotations as
        | { destructiveHint?: boolean; idempotentHint?: boolean }
        | undefined;
      expect(
        ann?.destructiveHint,
        `tool ${tool.name} (readOnlyHint=false) must declare destructiveHint`,
      ).toBeDefined();
      expect(
        ann?.idempotentHint,
        `tool ${tool.name} (readOnlyHint=false) must declare idempotentHint`,
      ).toBeDefined();
    }
  });

  it("every prompt declares at least one argument so clients can render input forms", async () => {
    const snapshot = await captureCatalog();
    for (const prompt of snapshot.prompts) {
      expect(
        (prompt.arguments ?? []).length,
        `prompt ${prompt.name} has no arguments — clients can't render an input form`,
      ).toBeGreaterThan(0);
    }
  });
});
