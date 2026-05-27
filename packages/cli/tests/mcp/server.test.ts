// Conformance test for the cycle5 Phase 1 MCP server.
//
// What this test pins:
//   - createMcpServer() returns a connectable MCP server.
//   - The initialize handshake completes successfully.
//   - The negotiated protocol version is 2025-06-18 (the version pinned
//     by cycle5; an ADR is required to bump per the cycle doc).
//   - tools/list returns the currently-registered tools (just `df_doctor`
//     after step 2; each subsequent Phase 1 step adds one entry and
//     replaces the positive assertion below).
//   - resources/list and prompts/list still return empty (populated in
//     later Phase 1 steps).
//
// Approach: drive the server via the SDK's in-memory transport pair so
// we exercise the real JSON-RPC framing without spawning a subprocess.
// A separate subprocess test (tests/mcp/cli-routing.test.ts) covers the
// `df mcp` CLI wiring + stdio transport end-to-end.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  InitializeRequestSchema,
  InitializeResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "../../src/mcp/server.js";

const CYCLE5_PINNED_PROTOCOL_VERSION = "2025-06-18";

describe("MCP server (cycle5 Phase 1)", () => {
  it("the SDK we depend on supports the cycle5-pinned protocol version", () => {
    // Compile-time pin: if a future SDK bump drops 2025-06-18 from the
    // supported set, this test fails immediately. That should force a
    // cycle5 ADR before the bump lands.
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(CYCLE5_PINNED_PROTOCOL_VERSION);
  });

  it("completes the initialize handshake and negotiates protocol 2025-06-18", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    // Drive the handshake directly so we can request the cycle5-pinned
    // version explicitly. The high-level Client class hard-codes its own
    // LATEST_PROTOCOL_VERSION, so it can't pin to an older supported
    // version on its own — driving the JSON-RPC directly lets us assert
    // the server can serve 2025-06-18.
    const initRequest = InitializeRequestSchema.parse({
      method: "initialize",
      params: {
        protocolVersion: CYCLE5_PINNED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "df-conformance-test", version: "0.0.0" },
      },
    });
    const response = await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const onMessage = (msg: unknown): void => {
        clientTransport.onmessage = undefined;
        resolvePromise(msg);
      };
      clientTransport.onmessage = onMessage;
      clientTransport.onerror = (err) => rejectPromise(err);
      void clientTransport.send({
        jsonrpc: "2.0",
        id: 1,
        ...initRequest,
      });
    });
    const envelope = response as {
      jsonrpc: string;
      id: number;
      result?: unknown;
      error?: { message: string };
    };
    expect(envelope.error).toBeUndefined();
    const result = InitializeResultSchema.parse(envelope.result);
    expect(result.protocolVersion).toBe(CYCLE5_PINNED_PROTOCOL_VERSION);
    expect(result.serverInfo.name).toMatch(/dark-factory/);

    await server.close();
  });

  it("tools/list pins the cycle5 catalog (df_doctor + df_cycle_list + df_cycle_read after step 3a)", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client(
      { name: "df-conformance-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const tools = await client.listTools();
    // Replace the assertion (not augment it) each time a new tool lands
    // so every step's diff is self-describing in PR review. See the
    // file-header comment for the cycle5 step-by-step approach.
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "df_cycle_list",
      "df_cycle_read",
      "df_doctor",
    ]);

    // Schema-surface pins per tool. Detailed schemas live in each
    // tool's own test file (and per-tool unit tests where applicable);
    // here we pin the top-level contract that tools/list reports.
    const byName = new Map(tools.tools.map((t) => [t.name, t]));

    const dfDoctor = byName.get("df_doctor");
    expect(dfDoctor?.annotations?.readOnlyHint).toBe(true);
    expect(dfDoctor?.inputSchema?.type).toBe("object");
    expect((dfDoctor?.inputSchema?.properties ?? {}) as Record<string, unknown>).toEqual({});
    expect(
      (dfDoctor?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toEqual(
      expect.objectContaining({ ok: expect.anything(), checks: expect.anything() }),
    );

    const dfCycleList = byName.get("df_cycle_list");
    expect(dfCycleList?.annotations?.readOnlyHint).toBe(true);
    expect(dfCycleList?.annotations?.openWorldHint).toBe(false);
    expect(dfCycleList?.inputSchema?.type).toBe("object");
    expect((dfCycleList?.inputSchema?.properties ?? {}) as Record<string, unknown>).toEqual({});
    expect(
      (dfCycleList?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toHaveProperty("cycles");

    const dfCycleRead = byName.get("df_cycle_read");
    expect(dfCycleRead?.annotations?.readOnlyHint).toBe(true);
    expect(dfCycleRead?.inputSchema?.type).toBe("object");
    const cycleReadInputProps =
      (dfCycleRead?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    expect(cycleReadInputProps).toHaveProperty("cycle_id");
    expect(
      (dfCycleRead?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toEqual(
      expect.objectContaining({
        id: expect.anything(),
        frontmatter: expect.anything(),
        sections: expect.anything(),
      }),
    );

    const resources = await client.listResources();
    expect(resources.resources).toEqual([]);

    const prompts = await client.listPrompts();
    expect(prompts.prompts).toEqual([]);

    await client.close();
    await server.close();
  });

  it("tools/call df_doctor returns structuredContent matching the output schema", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client(
      { name: "df-conformance-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "df_doctor",
      arguments: {},
    });

    // The tool always returns content (markdown fallback) and
    // structuredContent (the typed shape clients should prefer). The
    // structuredContent shape is gated by the registered outputSchema,
    // so the SDK already validated `ok` is a boolean and `checks` is
    // an array of valid entries before this point.
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as
      | { ok: boolean; checks: Array<{ name: string; status: string; message?: string }> }
      | undefined;
    expect(structured).toBeDefined();
    expect(typeof structured?.ok).toBe("boolean");
    expect(Array.isArray(structured?.checks)).toBe(true);
    // At least the node_version check is always emitted by runDoctor;
    // its presence proves the tool actually called through to the real
    // doctor module (the alternative is the config-missing degenerate
    // path, which also emits ≥1 check). This is a "the tool DID
    // something" smoke pin, not a value pin.
    expect(structured?.checks.length ?? 0).toBeGreaterThan(0);

    // Markdown fallback: each check name should appear in the rendered
    // text. Clients that don't read structuredContent still see useful
    // information.
    const textContent = (result.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === "text",
    );
    expect(textContent?.text).toBeDefined();

    await client.close();
    await server.close();
  });

  it("tools/call df_cycle_list returns the structured cycle catalog from cwd", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "df-mcp-cycle-list-"));
    try {
      mkdirSync(join(fixtureRoot, "docs", "roadmap", "cycles"), { recursive: true });
      writeFileSync(
        join(fixtureRoot, "docs", "roadmap", "cycles", "cycle1-alpha.md"),
        `---
title: "Cycle 1 — alpha"
status: "done"
owner: "@pj"
target: "2026-01-15"
---

# Cycle 1 — alpha

## Scope

x
`,
        "utf8",
      );
      writeFileSync(
        join(fixtureRoot, "docs", "roadmap", "cycles", "cycle2-beta.md"),
        `---
title: "Cycle 2 — beta"
status: "active"
---

# Cycle 2 — beta

## Scope

y
`,
        "utf8",
      );

      const server = createMcpServer({ cwd: fixtureRoot });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_cycle_list",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | {
            cycles: Array<{
              id: string;
              title: string;
              status: string;
              owner?: string;
              target?: string;
            }>;
          }
        | undefined;
      expect(structured?.cycles?.map((c) => c.id).sort()).toEqual([
        "cycle1",
        "cycle2",
      ]);
      const cycle1 = structured?.cycles?.find((c) => c.id === "cycle1");
      expect(cycle1?.owner).toBe("@pj");
      expect(cycle1?.target).toBe("2026-01-15");

      await client.close();
      await server.close();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("tools/call df_cycle_read returns frontmatter + sections for a valid id", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "df-mcp-cycle-read-"));
    try {
      mkdirSync(join(fixtureRoot, "docs", "roadmap", "cycles"), { recursive: true });
      writeFileSync(
        join(fixtureRoot, "docs", "roadmap", "cycles", "cycle1-alpha.md"),
        `---
title: "Cycle 1"
status: "done"
---

# Cycle 1

## Scope

scope text

## Exit criteria

exit text
`,
        "utf8",
      );

      const server = createMcpServer({ cwd: fixtureRoot });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_cycle_read",
        arguments: { cycle_id: "cycle1" },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | { id: string; frontmatter: Record<string, unknown>; sections: Record<string, string> }
        | undefined;
      expect(structured?.id).toBe("cycle1");
      expect(structured?.frontmatter).toMatchObject({ title: "Cycle 1", status: "done" });
      expect(Object.keys(structured?.sections ?? {}).sort()).toEqual([
        "exit_criteria",
        "scope",
      ]);
      expect(structured?.sections?.scope?.trim()).toBe("scope text");

      await client.close();
      await server.close();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("tools/call df_cycle_read with an unknown id returns isError=true", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "df-mcp-cycle-read-miss-"));
    try {
      mkdirSync(join(fixtureRoot, "docs", "roadmap", "cycles"), { recursive: true });

      const server = createMcpServer({ cwd: fixtureRoot });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_cycle_read",
        arguments: { cycle_id: "cycle999" },
      });
      expect(result.isError).toBe(true);

      await client.close();
      await server.close();
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("advertises the three primitive capabilities the catalog will fill", async () => {
    const server = createMcpServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client(
      { name: "df-conformance-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const caps = client.getServerCapabilities();
    expect(caps).toBeDefined();
    // The server registers the three primitive request handlers up front
    // (so /list returns []), which means the SDK derives `tools`,
    // `resources`, `prompts` capability blocks on the server's behalf.
    // Pinning that here so a regression where a future refactor drops
    // one of the three primitives is caught immediately.
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeDefined();

    await client.close();
    await server.close();
  });
});
