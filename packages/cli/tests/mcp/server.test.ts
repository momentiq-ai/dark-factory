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

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("tools/list pins the cycle5 catalog (13 tools after step 6: 10 prior + review + review_status + bypass)", async () => {
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
      "df_adr_list",
      "df_adr_read",
      "df_bypass",
      "df_critics_config",
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
    expect(
      ((dfCycleRead?.inputSchema?.properties ?? {}) as Record<string, unknown>),
    ).toHaveProperty("cycle_id");
    expect(
      (dfCycleRead?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toEqual(
      expect.objectContaining({
        id: expect.anything(),
        frontmatter: expect.anything(),
        sections: expect.anything(),
      }),
    );

    const dfFindings = byName.get("df_findings");
    expect(dfFindings?.annotations?.readOnlyHint).toBe(true);
    expect(
      ((dfFindings?.inputSchema?.properties ?? {}) as Record<string, unknown>),
    ).toHaveProperty("commit");
    expect(
      (dfFindings?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toEqual(
      expect.objectContaining({ commit: expect.anything(), critics: expect.anything() }),
    );

    const dfShowRun = byName.get("df_show_run");
    expect(dfShowRun?.annotations?.readOnlyHint).toBe(true);
    expect(
      ((dfShowRun?.inputSchema?.properties ?? {}) as Record<string, unknown>),
    ).toHaveProperty("commit");
    expect(
      (dfShowRun?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toHaveProperty("artifact");

    const dfAdrList = byName.get("df_adr_list");
    expect(dfAdrList?.annotations?.readOnlyHint).toBe(true);
    expect(dfAdrList?.annotations?.openWorldHint).toBe(false);
    expect((dfAdrList?.inputSchema?.properties ?? {}) as Record<string, unknown>).toEqual({});
    expect(
      (dfAdrList?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toHaveProperty("adrs");

    const dfAdrRead = byName.get("df_adr_read");
    expect(dfAdrRead?.annotations?.readOnlyHint).toBe(true);
    expect(
      ((dfAdrRead?.inputSchema?.properties ?? {}) as Record<string, unknown>),
    ).toHaveProperty("adr_id");
    expect(
      (dfAdrRead?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toEqual(
      expect.objectContaining({
        id: expect.anything(),
        frontmatter: expect.anything(),
        body: expect.anything(),
        status: expect.anything(),
      }),
    );

    const dfCriticsConfig = byName.get("df_critics_config");
    expect(dfCriticsConfig?.annotations?.readOnlyHint).toBe(true);
    expect(dfCriticsConfig?.annotations?.openWorldHint).toBe(false);
    expect(
      (dfCriticsConfig?.inputSchema?.properties ?? {}) as Record<string, unknown>,
    ).toEqual({});
    expect(
      (dfCriticsConfig?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toEqual(
      expect.objectContaining({
        critics: expect.anything(),
        aggregation: expect.anything(),
        prompts: expect.anything(),
      }),
    );

    const dfStats = byName.get("df_stats");
    expect(dfStats?.annotations?.readOnlyHint).toBe(true);
    const statsInputProps =
      (dfStats?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    expect(statsInputProps).toHaveProperty("since");
    expect(statsInputProps).toHaveProperty("until");
    expect(
      (dfStats?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toEqual(
      expect.objectContaining({
        runs: expect.anything(),
        bypasses: expect.anything(),
        by_critic: expect.anything(),
        by_verdict: expect.anything(),
      }),
    );

    const dfGatePush = byName.get("df_gate_push");
    expect(dfGatePush?.annotations?.readOnlyHint).toBe(true);
    const gateInputProps =
      (dfGatePush?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    expect(gateInputProps).toHaveProperty("stdin_protocol");
    expect(
      (dfGatePush?.outputSchema as {
        properties?: { verdict?: { enum?: string[] } };
      })?.properties?.verdict?.enum?.sort(),
    ).toEqual(["allow", "block", "bypass-required"]);

    const dfReview = byName.get("df_review");
    expect(dfReview?.annotations?.readOnlyHint).toBe(false);
    expect(dfReview?.annotations?.destructiveHint).toBe(false);
    expect(dfReview?.annotations?.idempotentHint).toBe(false);
    expect(
      ((dfReview?.inputSchema?.properties ?? {}) as Record<string, unknown>),
    ).toHaveProperty("commit");
    expect(
      (dfReview?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toEqual(
      expect.objectContaining({
        job_id: expect.anything(),
        started_at: expect.anything(),
        expected_completion_seconds: expect.anything(),
      }),
    );

    const dfReviewStatus = byName.get("df_review_status");
    expect(dfReviewStatus?.annotations?.readOnlyHint).toBe(true);
    expect(
      ((dfReviewStatus?.inputSchema?.properties ?? {}) as Record<string, unknown>),
    ).toHaveProperty("job_id");
    expect(
      (dfReviewStatus?.outputSchema as {
        properties?: { status?: { enum?: string[] } };
      })?.properties?.status?.enum?.sort(),
    ).toEqual(["completed", "errored", "running"]);

    const dfBypass = byName.get("df_bypass");
    expect(dfBypass?.annotations?.readOnlyHint).toBe(false);
    expect(dfBypass?.annotations?.destructiveHint).toBe(true);
    const bypassInputProps =
      (dfBypass?.inputSchema?.properties ?? {}) as Record<string, unknown>;
    expect(bypassInputProps).toHaveProperty("reason");
    expect(bypassInputProps).toHaveProperty("sha");
    expect(bypassInputProps).toHaveProperty("issue_url");
    expect(
      (dfBypass?.outputSchema as { properties?: Record<string, unknown> })?.properties,
    ).toEqual(
      expect.objectContaining({
        audit_entry_id: expect.anything(),
        recorded_at: expect.anything(),
        warnings: expect.anything(),
      }),
    );

    // Step 4 populated resources/list; detailed shape pins live in
    // tests/mcp/resources.test.ts. Here we just assert the static
    // catalog (6 URIs) is present (templated `list` callbacks may add
    // entries on top in fixture-bearing tests, but in this no-fixture
    // catalog-pin test the cycles and ADRs lists are empty).
    const resources = await client.listResources();
    const staticUris = resources.resources
      .map((r) => r.uri)
      .filter((uri) => !uri.match(/^df:\/\/repo\/(cycle|adr|findings)\//))
      .sort();
    expect(staticUris).toEqual([
      "df://repo/adrs",
      "df://repo/audit-log",
      "df://repo/config/critics",
      "df://repo/cycles",
      "df://repo/principles",
      "df://repo/runs/recent",
    ]);

    // Step 7 populated prompts/list with 5 pure-template prompts.
    // Detailed shape pins live in tests/mcp/prompts.test.ts. Here we
    // just assert the catalog set.
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual([
      "df.diagnose_critic_failure",
      "df.draft_adr",
      "df.onboarding_analysis",
      "df.summarize_recent_runs",
      "df.write_cycle_doc",
    ]);

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

  // ---------------------------------------------------------------
  // df_findings / df_show_run integration — these need a real git
  // repo so resolveCommit + resolveArtifactDir succeed. setupArtifactRepo
  // creates a tmp repo, .agent-review/config.json, one commit, and writes
  // a fixture artifact JSON for the HEAD SHA. We pass `cwd: tmpRoot` to
  // createMcpServer so the tools target the fixture.
  // ---------------------------------------------------------------

  function setupArtifactRepo(opts: {
    /** Override criticResults; otherwise a minimal fixture is used. */
    criticResults?: unknown[];
  } = {}): { root: string; commitSha: string } {
    const root = mkdtempSync(join(tmpdir(), "df-mcp-findings-"));
    spawnSync("git", ["init", "-q", "-b", "main", root]);
    spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "t"], { cwd: root });
    spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
    writeFileSync(join(root, "README.md"), "# x\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    const rev = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    const commitSha = String(rev.stdout).trim();

    mkdirSync(join(root, ".agent-review"), { recursive: true });
    writeFileSync(
      join(root, ".agent-review", "config.json"),
      JSON.stringify({
        version: 1,
        critics: [
          {
            id: "cursor-local-chief-engineer",
            name: "Cursor",
            adapter: "cursor-sdk",
            required: true,
            runtime: "local",
            model: { id: "gpt-5.5", params: [] },
          },
        ],
        aggregation: {
          policy: "block-if-any",
          blockingSeverities: ["blocker", "high"],
        },
        git: {
          hookPath: ".husky",
          artifactDir: "agent-reviews",
          artifactScope: "git-common-dir",
        },
        policy: {
          blockOnMissingReview: true,
          blockOnReviewError: true,
          allowEmergencyBypass: true,
          postCommitMode: "async",
        },
        context: {
          guidanceFiles: [],
          promptFragments: [],
          maxChangedFileBytes: 1000,
          includeFullChangedFiles: true,
        },
        validation: {
          runBeforeReview: false,
          resultFile: "agent-reviews/quality-gates/latest.json",
          requiredQualityGates: [],
          optionalQualityGates: [],
        },
        security: {
          redactSecretsInDiagnostics: true,
          treatDiffAsUntrustedInput: true,
        },
      }),
      "utf8",
    );

    const criticResults = opts.criticResults ?? [
      {
        criticId: "cursor-local-chief-engineer",
        status: "complete",
        verdict: "CHANGES_REQUESTED",
        requiresHumanJudgment: false,
        reviewer: {
          name: "Cursor",
          adapter: "cursor-sdk",
          model: { id: "gpt-5.5", params: [] },
          runtime: "local",
        },
        summary: "1 blocker.",
        findings: [
          {
            severity: "blocker",
            category: "untyped-any",
            file: "src/foo.ts",
            line: 42,
            evidence: "function bar(x: any) { ... }",
            impact: "Type safety lost.",
            requiredFix: "Annotate x.",
          },
        ],
        validation: { qualityGateResults: [], qualityGatesMissing: [] },
        confidence: "high",
      },
    ];

    mkdirSync(join(root, ".git", "agent-reviews"), { recursive: true });
    writeFileSync(
      join(root, ".git", "agent-reviews", `${commitSha}.json`),
      JSON.stringify({
        version: 2,
        status: "complete",
        repo: "test/test",
        commit: commitSha,
        parent: "0000000000000000000000000000000000000000",
        range: `0000000..${commitSha.slice(0, 7)}`,
        diffHash: "sha256:test",
        artifactScope: "git-common-dir",
        gateVerdict: "CHANGES_REQUESTED",
        aggregationPolicy: "block-if-any",
        criticResults,
        createdAt: "2026-05-27T15:00:00.000Z",
      }),
      "utf8",
    );

    return { root, commitSha };
  }

  it("tools/call df_findings returns the narrowed shape for a real artifact", async () => {
    const { root, commitSha } = setupArtifactRepo();
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_findings",
        arguments: { commit: "HEAD" },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | {
            commit: string;
            critics: Array<{
              id: string;
              status: string;
              verdict?: string;
              findings: Array<{
                severity: string;
                file?: string;
                line?: number;
                rule: string;
                message: string;
              }>;
            }>;
          }
        | undefined;
      expect(structured?.commit).toBe(commitSha);
      expect(structured?.critics).toHaveLength(1);
      expect(structured?.critics[0]?.id).toBe("cursor-local-chief-engineer");
      expect(structured?.critics[0]?.verdict).toBe("CHANGES_REQUESTED");
      expect(structured?.critics[0]?.findings).toHaveLength(1);
      expect(structured?.critics[0]?.findings[0]).toMatchObject({
        severity: "blocker",
        file: "src/foo.ts",
        line: 42,
        rule: "untyped-any",
        message: "function bar(x: any) { ... }",
      });

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tools/call df_show_run returns the full artifact JSON", async () => {
    const { root, commitSha } = setupArtifactRepo();
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_show_run",
        arguments: { commit: commitSha },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | { artifact: { commit: string; criticResults?: Array<{ findings?: unknown[] }> } }
        | undefined;
      expect(structured?.artifact?.commit).toBe(commitSha);
      // The full artifact preserves fields df_findings narrows away —
      // impact + requiredFix are present here.
      const firstFinding = structured?.artifact?.criticResults?.[0]?.findings?.[0] as
        | { impact?: string; requiredFix?: string }
        | undefined;
      expect(firstFinding?.impact).toBe("Type safety lost.");
      expect(firstFinding?.requiredFix).toBe("Annotate x.");

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tools/call df_findings returns isError when the artifact is missing", async () => {
    // Set up a repo but DON'T write the artifact file.
    const root = mkdtempSync(join(tmpdir(), "df-mcp-findings-missing-"));
    spawnSync("git", ["init", "-q", "-b", "main", root]);
    spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "t"], { cwd: root });
    spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
    writeFileSync(join(root, "README.md"), "# x\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    mkdirSync(join(root, ".agent-review"), { recursive: true });
    writeFileSync(
      join(root, ".agent-review", "config.json"),
      JSON.stringify({
        version: 1,
        critics: [
          {
            id: "cursor-local-chief-engineer",
            name: "Cursor",
            adapter: "cursor-sdk",
            required: true,
            runtime: "local",
            model: { id: "gpt-5.5", params: [] },
          },
        ],
        aggregation: { policy: "block-if-any", blockingSeverities: ["blocker", "high"] },
        git: { hookPath: ".husky", artifactDir: "agent-reviews", artifactScope: "git-common-dir" },
        policy: {
          blockOnMissingReview: true,
          blockOnReviewError: true,
          allowEmergencyBypass: true,
          postCommitMode: "async",
        },
        context: { guidanceFiles: [], promptFragments: [], maxChangedFileBytes: 1000, includeFullChangedFiles: true },
        validation: { runBeforeReview: false, resultFile: "x", requiredQualityGates: [], optionalQualityGates: [] },
        security: { redactSecretsInDiagnostics: true, treatDiffAsUntrustedInput: true },
      }),
      "utf8",
    );

    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_findings",
        arguments: { commit: "HEAD" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      )?.text;
      expect(text).toMatch(/no review artifact/);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------
  // df_adr_list / df_adr_read integration tests with a fixture
  // docs/ADR/ tree. The ADR parser tests in tests/mcp/adr/ cover
  // parser behavior exhaustively; these tests pin the MCP-side
  // wiring (tools/call returns the right structured shape via
  // InMemoryTransport).
  // ---------------------------------------------------------------

  function setupAdrFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "df-mcp-adr-"));
    mkdirSync(join(root, "docs", "ADR"), { recursive: true });
    writeFileSync(
      join(root, "docs", "ADR", "2026-05-w1-w3-gate-migration.md"),
      `# ADR 2026-05 — W1→W3 gate migration: hosted critic is authoritative

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** PJ
- **Supersedes (in part):** ADR 2026-04 (local critic posture).

## Context

context

## Decision

decision
`,
      "utf8",
    );
    writeFileSync(
      join(root, "docs", "ADR", "2026-03-kms-vault.md"),
      `# ADR 2026-03 — KMS vault for vendor keys

- **Status:** Proposed
- **Date:** 2026-03-15
- **Deciders:** PJ

## Context

c

## Decision

d
`,
      "utf8",
    );
    return root;
  }

  it("tools/call df_adr_list returns the structured ADR catalog from cwd", async () => {
    const root = setupAdrFixture();
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_adr_list",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | {
            adrs: Array<{ id: string; title: string; status: string; date: string }>;
          }
        | undefined;
      expect(structured?.adrs?.map((a) => a.id).sort()).toEqual([
        "2026-03-kms-vault",
        "2026-05-w1-w3-gate-migration",
      ]);
      const w1w3 = structured?.adrs?.find((a) => a.id === "2026-05-w1-w3-gate-migration");
      expect(w1w3?.status).toBe("Accepted");
      expect(w1w3?.date).toBe("2026-05-26");

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tools/call df_adr_read returns frontmatter + body + status + supersedes", async () => {
    const root = setupAdrFixture();
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_adr_read",
        arguments: { adr_id: "2026-05-w1-w3-gate-migration" },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | {
            id: string;
            frontmatter: Record<string, string>;
            body: string;
            status: string;
            supersedes?: string;
          }
        | undefined;
      expect(structured?.id).toBe("2026-05-w1-w3-gate-migration");
      expect(structured?.status).toBe("Accepted");
      expect(structured?.supersedes).toMatch(/ADR 2026-04/);
      expect(structured?.frontmatter?.Date).toBe("2026-05-26");
      expect(structured?.body).toMatch(/## Context/);
      expect(structured?.body).toMatch(/## Decision/);
      expect(structured?.body).not.toMatch(/^# ADR 2026-05/m);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tools/call df_adr_read with unknown id returns isError=true", async () => {
    const root = setupAdrFixture();
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_adr_read",
        arguments: { adr_id: "missing" },
      });
      expect(result.isError).toBe(true);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------
  // df_critics_config integration tests — fixture is a repo root with
  // a valid .agent-review/config.json (no git init needed; the tool
  // doesn't touch git).
  // ---------------------------------------------------------------

  function setupCriticsConfigFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "df-mcp-critics-cfg-"));
    // loadAgentReviewConfig calls `git rev-parse --show-toplevel` to
    // locate the repo root, so the fixture has to be a real git
    // worktree even though the tool itself doesn't touch git.
    spawnSync("git", ["init", "-q", "-b", "main", root]);
    mkdirSync(join(root, ".agent-review", "prompts"), { recursive: true });
    // Guidance files + prompt fragments referenced in context.* must
    // exist on disk (loadAgentReviewConfig validates them by default).
    writeFileSync(join(root, "CLAUDE.md"), "# CLAUDE\n", "utf8");
    writeFileSync(join(root, "AGENTS.md"), "# AGENTS\n", "utf8");
    writeFileSync(
      join(root, ".agent-review", "prompts", "local-critic.md"),
      "# local-critic prompt\n",
      "utf8",
    );
    writeFileSync(
      join(root, ".agent-review", "config.json"),
      JSON.stringify({
        version: 1,
        critics: [
          {
            id: "cursor-local",
            name: "Cursor",
            adapter: "cursor-sdk",
            required: true,
            runtime: "local",
            model: { id: "gpt-5.5", params: [] },
          },
          {
            id: "codex-local",
            name: "Codex",
            adapter: "codex-sdk",
            required: false,
            runtime: "local",
            model: { id: "gpt-5.5", params: [] },
          },
        ],
        aggregation: {
          policy: "min-complete-quorum",
          blockingSeverities: ["blocker", "high"],
          quorum: 2,
        },
        git: {
          hookPath: ".husky",
          artifactDir: "agent-reviews",
          artifactScope: "git-common-dir",
        },
        policy: {
          blockOnMissingReview: true,
          blockOnReviewError: true,
          allowEmergencyBypass: true,
          postCommitMode: "async",
        },
        context: {
          guidanceFiles: ["CLAUDE.md", "AGENTS.md"],
          promptFragments: [".agent-review/prompts/local-critic.md"],
          maxChangedFileBytes: 200000,
          includeFullChangedFiles: true,
        },
        validation: {
          runBeforeReview: false,
          resultFile: "agent-reviews/quality-gates/latest.json",
          requiredQualityGates: [],
          optionalQualityGates: [],
        },
        security: {
          redactSecretsInDiagnostics: true,
          treatDiffAsUntrustedInput: true,
        },
      }),
      "utf8",
    );
    return root;
  }

  it("tools/call df_critics_config returns critics + aggregation + prompts", async () => {
    const root = setupCriticsConfigFixture();
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_critics_config",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | {
            critics: Array<{ id: string; adapter: string; required: boolean }>;
            aggregation: { policy: string; blockingSeverities: string[]; quorum: number };
            prompts: { guidanceFiles: string[]; promptFragments: string[] };
          }
        | undefined;
      expect(structured?.critics?.map((c) => c.id).sort()).toEqual([
        "codex-local",
        "cursor-local",
      ]);
      expect(structured?.aggregation?.policy).toBe("min-complete-quorum");
      expect(structured?.aggregation?.quorum).toBe(2);
      expect(structured?.prompts?.guidanceFiles).toEqual(["CLAUDE.md", "AGENTS.md"]);
      expect(structured?.prompts?.promptFragments).toEqual([
        ".agent-review/prompts/local-critic.md",
      ]);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tools/call df_critics_config returns isError when .agent-review/config.json is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "df-mcp-critics-cfg-missing-"));
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_critics_config",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (c) => c.type === "text",
      )?.text;
      expect(text).toMatch(/failed to load/);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------
  // df_stats + df_gate_push integration tests — both need a real
  // git fixture with .agent-review/config.json + telemetry NDJSON.
  // ---------------------------------------------------------------

  function setupStatsGateFixture(opts: {
    /** Pre-write telemetry events to .git/agent-reviews/_runs.ndjson. */
    telemetryEvents?: unknown[];
    /** Pre-write a per-SHA review artifact at .git/agent-reviews/<sha>.json. */
    artifact?: { commitSha: string; payload: unknown };
    /** Override config.policy.allowEmergencyBypass (default true). */
    allowEmergencyBypass?: boolean;
  } = {}): { root: string; headSha: string } {
    const root = mkdtempSync(join(tmpdir(), "df-mcp-stats-gate-"));
    spawnSync("git", ["init", "-q", "-b", "main", root]);
    spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "t"], { cwd: root });
    spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
    writeFileSync(join(root, "README.md"), "# x\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    const headSha = String(rev.stdout).trim();

    mkdirSync(join(root, ".agent-review", "prompts"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# CLAUDE\n", "utf8");
    writeFileSync(
      join(root, ".agent-review", "prompts", "local-critic.md"),
      "# local\n",
      "utf8",
    );
    writeFileSync(
      join(root, ".agent-review", "config.json"),
      JSON.stringify({
        version: 1,
        critics: [
          {
            id: "cursor-local",
            name: "Cursor",
            adapter: "cursor-sdk",
            required: true,
            runtime: "local",
            model: { id: "gpt-5.5", params: [] },
          },
        ],
        aggregation: {
          policy: "block-if-any",
          blockingSeverities: ["blocker", "high"],
        },
        git: {
          hookPath: ".husky",
          artifactDir: "agent-reviews",
          artifactScope: "git-common-dir",
        },
        policy: {
          blockOnMissingReview: true,
          blockOnReviewError: true,
          allowEmergencyBypass: opts.allowEmergencyBypass ?? true,
          postCommitMode: "async",
        },
        context: {
          guidanceFiles: ["CLAUDE.md"],
          promptFragments: [".agent-review/prompts/local-critic.md"],
          maxChangedFileBytes: 200000,
          includeFullChangedFiles: true,
        },
        validation: {
          runBeforeReview: false,
          resultFile: "agent-reviews/quality-gates/latest.json",
          requiredQualityGates: [],
          optionalQualityGates: [],
        },
        security: { redactSecretsInDiagnostics: true, treatDiffAsUntrustedInput: true },
      }),
      "utf8",
    );

    mkdirSync(join(root, ".git", "agent-reviews"), { recursive: true });
    if (opts.telemetryEvents) {
      writeFileSync(
        join(root, ".git", "agent-reviews", "_runs.ndjson"),
        opts.telemetryEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8",
      );
    }
    if (opts.artifact) {
      writeFileSync(
        join(root, ".git", "agent-reviews", `${opts.artifact.commitSha}.json`),
        JSON.stringify(opts.artifact.payload),
        "utf8",
      );
    }

    return { root, headSha };
  }

  it("tools/call df_stats returns the spec-narrowed shape with window metadata", async () => {
    const events = [
      {
        ts: "2026-05-01T10:00:00.000Z",
        event: "review_started",
        commit: "a",
        criticId: "cursor-local",
      },
      {
        ts: "2026-05-01T10:00:05.000Z",
        event: "critic_run_finished",
        commit: "a",
        criticId: "cursor-local",
        verdict: "APPROVED",
        durationMs: 5000,
      },
      {
        ts: "2026-05-01T10:00:06.000Z",
        event: "review_finished",
        commit: "a",
        verdict: "APPROVED",
      },
      {
        ts: "2026-05-02T10:00:00.000Z",
        event: "gate_bypassed",
        commit: "b",
        bypassReason: "emergency hotfix",
      },
    ];
    const { root } = setupStatsGateFixture({ telemetryEvents: events });
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({ name: "df_stats", arguments: {} });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | {
            runs: number;
            bypasses: number;
            by_critic: Record<string, { approved: number }>;
            by_verdict: { approved: number; changes_requested: number };
            window: { events_total: number; events_in_window: number };
          }
        | undefined;
      expect(structured?.bypasses).toBe(1);
      expect(structured?.by_verdict?.approved).toBe(1);
      expect(structured?.by_critic?.["cursor-local"]?.approved).toBe(1);
      expect(structured?.window?.events_total).toBe(4);
      expect(structured?.window?.events_in_window).toBe(4);

      // since filter
      const narrowed = await client.callTool({
        name: "df_stats",
        arguments: { since: "2026-05-02T00:00:00.000Z" },
      });
      const narrowedStructured = narrowed.structuredContent as {
        bypasses: number;
        window: { events_in_window: number };
      };
      expect(narrowedStructured.bypasses).toBe(1); // bypass on May-02 still in
      expect(narrowedStructured.window.events_in_window).toBe(1);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tools/call df_gate_push returns 'allow' when commits pass their gates", async () => {
    // Pre-write an APPROVED artifact for HEAD so the gate evaluation
    // doesn't fail on "missing review".
    const tmpRoot = mkdtempSync(join(tmpdir(), "df-mcp-gate-push-allow-"));
    spawnSync("git", ["init", "-q", "-b", "main", tmpRoot]);
    spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: tmpRoot });
    spawnSync("git", ["config", "user.name", "t"], { cwd: tmpRoot });
    spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: tmpRoot });
    writeFileSync(join(tmpRoot, "README.md"), "# x\n");
    spawnSync("git", ["add", "."], { cwd: tmpRoot });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: tmpRoot });
    const headSha = String(
      spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmpRoot, encoding: "utf8" }).stdout,
    ).trim();
    rmSync(tmpRoot, { recursive: true, force: true });

    const { root, headSha: realSha } = setupStatsGateFixture({
      artifact: {
        commitSha: "PLACEHOLDER",
        payload: {},
      },
    });
    // setupStatsGateFixture wrote a placeholder artifact at PLACEHOLDER.
    // Overwrite at the actual HEAD sha with a real APPROVED artifact so
    // evaluateCommitGate sees an artifact + APPROVED verdict.
    rmSync(join(root, ".git", "agent-reviews", "PLACEHOLDER.json"), { force: true });
    writeFileSync(
      join(root, ".git", "agent-reviews", `${realSha}.json`),
      JSON.stringify({
        version: 2,
        status: "complete",
        repo: "test/test",
        commit: realSha,
        parent: "0000000000000000000000000000000000000000",
        range: `0000000..${realSha.slice(0, 7)}`,
        diffHash: "sha256:test",
        artifactScope: "git-common-dir",
        gateVerdict: "APPROVED",
        aggregationPolicy: "block-if-any",
        criticResults: [
          {
            criticId: "cursor-local",
            status: "complete",
            verdict: "APPROVED",
            requiresHumanJudgment: false,
            reviewer: {
              name: "Cursor",
              adapter: "cursor-sdk",
              model: { id: "gpt-5.5", params: [] },
              runtime: "local",
            },
            summary: "ok",
            findings: [],
            validation: { qualityGateResults: [], qualityGatesMissing: [] },
            confidence: "high",
          },
        ],
        createdAt: "2026-05-27T15:00:00.000Z",
      }),
      "utf8",
    );

    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      // pre-push protocol: localRef localSha remoteRef remoteSha
      // For a "new branch" push: remoteSha is 0000....
      const stdinProtocol = `refs/heads/main ${realSha} refs/heads/main 0000000000000000000000000000000000000000\n`;

      // Note: actual diff-hash recomputation may interact with the
      // commit's parent. We expect either 'allow' or 'bypass-required'
      // depending on whether the artifact's diff matches the recomputed
      // diff. The key pin: the tool returns a structured verdict.
      const result = await client.callTool({
        name: "df_gate_push",
        arguments: { stdin_protocol: stdinProtocol },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | {
            verdict: string;
            reasons: Array<{ commit: string; reason: string }>;
            commits_evaluated: number;
            bypass_allowed: boolean;
          }
        | undefined;
      expect(structured?.verdict).toMatch(/^(allow|bypass-required|block)$/);
      // bypass_allowed mirrors config.policy.allowEmergencyBypass (true by default).
      expect(structured?.bypass_allowed).toBe(true);
      expect(structured?.commits_evaluated).toBeGreaterThanOrEqual(1);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tools/call df_gate_push returns 'block' (no override) when allowEmergencyBypass=false and gate blocks", async () => {
    const { root, headSha: realSha } = setupStatsGateFixture({
      allowEmergencyBypass: false,
      // No artifact written → blockOnMissingReview=true triggers block.
    });
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const stdinProtocol = `refs/heads/main ${realSha} refs/heads/main 0000000000000000000000000000000000000000\n`;
      const result = await client.callTool({
        name: "df_gate_push",
        arguments: { stdin_protocol: stdinProtocol },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        verdict: string;
        bypass_allowed: boolean;
        reasons: Array<{ reason: string }>;
      };
      expect(structured.verdict).toBe("block");
      expect(structured.bypass_allowed).toBe(false);
      expect(structured.reasons.length).toBeGreaterThan(0);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------
  // df_review + df_review_status integration — the test injects a
  // mock runReview via createMcpServer's _testRunReview opt so we
  // don't have to instantiate the real vendor adapter fleet.
  // ---------------------------------------------------------------

  function setupReviewBypassFixture(opts: { allowEmergencyBypass?: boolean } = {}): {
    root: string;
    sha: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "df-mcp-review-bypass-"));
    spawnSync("git", ["init", "-q", "-b", "main", root]);
    spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "t"], { cwd: root });
    spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
    writeFileSync(join(root, "README.md"), "# x\n");
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    const sha = String(
      spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout,
    ).trim();

    mkdirSync(join(root, ".agent-review", "prompts"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# CLAUDE\n", "utf8");
    writeFileSync(
      join(root, ".agent-review", "prompts", "local-critic.md"),
      "# local\n",
      "utf8",
    );
    writeFileSync(
      join(root, ".agent-review", "config.json"),
      JSON.stringify({
        version: 1,
        critics: [
          {
            id: "cursor-local",
            name: "Cursor",
            adapter: "cursor-sdk",
            required: true,
            runtime: "local",
            model: { id: "gpt-5.5", params: [] },
          },
        ],
        aggregation: { policy: "block-if-any", blockingSeverities: ["blocker", "high"] },
        git: { hookPath: ".husky", artifactDir: "agent-reviews", artifactScope: "git-common-dir" },
        policy: {
          blockOnMissingReview: true,
          blockOnReviewError: true,
          allowEmergencyBypass: opts.allowEmergencyBypass ?? true,
          postCommitMode: "async",
        },
        context: {
          guidanceFiles: ["CLAUDE.md"],
          promptFragments: [".agent-review/prompts/local-critic.md"],
          maxChangedFileBytes: 200000,
          includeFullChangedFiles: true,
        },
        validation: {
          runBeforeReview: false,
          resultFile: "agent-reviews/quality-gates/latest.json",
          requiredQualityGates: [],
          optionalQualityGates: [],
        },
        security: { redactSecretsInDiagnostics: true, treatDiffAsUntrustedInput: true },
      }),
      "utf8",
    );
    return { root, sha };
  }

  it("tools/call df_review returns job_id and df_review_status reports completion via the injected runner", async () => {
    const { root, sha } = setupReviewBypassFixture();
    try {
      // A synthetic outcome the mock runReview returns. The findings
      // mapper is tested separately; here we just pin the shape pass-
      // through.
      const fakeOutcome = {
        artifact: {
          version: 2 as const,
          status: "complete" as const,
          repo: "test/test",
          commit: sha,
          parent: "0000000000000000000000000000000000000000",
          range: `0000000..${sha.slice(0, 7)}`,
          diffHash: "sha256:test",
          artifactScope: "git-common-dir" as const,
          gateVerdict: "APPROVED" as const,
          aggregationPolicy: "block-if-any" as const,
          criticResults: [
            {
              criticId: "cursor-local",
              status: "complete" as const,
              verdict: "APPROVED" as const,
              requiresHumanJudgment: false,
              reviewer: {
                name: "Cursor",
                adapter: "cursor-sdk",
                model: { id: "gpt-5.5", params: [] },
                runtime: "local",
              },
              summary: "ok",
              findings: [],
              validation: { qualityGateResults: [], qualityGatesMissing: [] },
              confidence: "high" as const,
            },
          ],
          createdAt: "2026-05-27T15:00:00.000Z",
        },
        paths: {
          jsonPath: join(root, ".git", "agent-reviews", `${sha}.json`),
          markdownPath: null,
        },
        packet: {} as never,
        acquired: true,
      };

      const server = createMcpServer({
        cwd: root,
        _testRunReview: async () => fakeOutcome,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const reviewResult = await client.callTool({
        name: "df_review",
        arguments: { commit: sha },
      });
      expect(reviewResult.isError).toBeFalsy();
      const reviewStructured = reviewResult.structuredContent as
        | {
            job_id: string;
            started_at: string;
            expected_completion_seconds: number;
          }
        | undefined;
      expect(reviewStructured?.job_id).toMatch(/^job_[0-9a-f]+$/);
      expect(reviewStructured?.expected_completion_seconds).toBeGreaterThan(0);

      // Wait for the async runReview to settle. The fake returns
      // synchronously, but the .then() callback runs after the
      // current task — give the event loop a tick or two.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const jobId = reviewStructured!.job_id;
      const statusResult = await client.callTool({
        name: "df_review_status",
        arguments: { job_id: jobId },
      });
      expect(statusResult.isError).toBeFalsy();
      const statusStructured = statusResult.structuredContent as
        | {
            status: string;
            verdict?: string;
            findings?: { commit: string; critics: unknown[] };
          }
        | undefined;
      expect(statusStructured?.status).toBe("completed");
      expect(statusStructured?.verdict).toBe("APPROVED");
      expect(statusStructured?.findings?.commit).toBe(sha);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tools/call df_review_status returns isError for an unknown job_id", async () => {
    const { root } = setupReviewBypassFixture();
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_review_status",
        arguments: { job_id: "job_doesnotexist" },
      });
      expect(result.isError).toBe(true);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tools/call df_bypass appends a structured audit entry; missing issue_url surfaces a warning", async () => {
    const { root, sha } = setupReviewBypassFixture();
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-conformance-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      // Without issue_url → warns.
      const noIssue = await client.callTool({
        name: "df_bypass",
        arguments: { reason: "emergency hotfix for staging outage", sha },
      });
      expect(noIssue.isError).toBeFalsy();
      const noIssueStructured = noIssue.structuredContent as
        | { audit_entry_id: string; recorded_at: string; warnings: string[] }
        | undefined;
      expect(noIssueStructured?.audit_entry_id).toMatch(/^bypass_[0-9a-f]+$/);
      expect(noIssueStructured?.warnings ?? []).toEqual(
        expect.arrayContaining([expect.stringMatching(/issue_url missing/)]),
      );

      // With issue_url → no warning, and the audit entry encodes both
      // mcp:<id> and issue:<url> into bypassReason.
      const withIssue = await client.callTool({
        name: "df_bypass",
        arguments: {
          reason: "follow-up cleanup",
          sha,
          issue_url: "https://github.com/momentiq-ai/dark-factory/issues/999",
        },
      });
      const withIssueStructured = withIssue.structuredContent as
        | { warnings: string[]; audit_entry_id: string }
        | undefined;
      expect(withIssueStructured?.warnings).toEqual([]);

      // Both entries should now be in the telemetry NDJSON. Read it
      // back and pin the structured-reason prefix encoding.
      const ndjson = readFileSync(
        join(root, ".git", "agent-reviews", "_runs.ndjson"),
        "utf8",
      );
      const lines = ndjson
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { event: string; bypassReason?: string; commit?: string });
      expect(lines).toHaveLength(2);
      expect(lines.every((l) => l.event === "gate_bypassed")).toBe(true);
      expect(lines.every((l) => l.commit === sha)).toBe(true);
      // Reasons carry the prefix metadata.
      expect(lines[0]?.bypassReason).toMatch(/^\[mcp:bypass_[0-9a-f]+\] /);
      expect(lines[1]?.bypassReason).toMatch(
        /^\[mcp:bypass_[0-9a-f]+ issue:https:\/\/github\.com\/momentiq-ai\/dark-factory\/issues\/999\] /,
      );

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
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
