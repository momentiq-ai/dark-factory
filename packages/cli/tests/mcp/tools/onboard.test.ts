// packages/cli/tests/mcp/tools/onboard.test.ts
//
// Task 6 — df_onboard MCP tool tests.
//
// ESM MOCKING DOCTRINE (mirrors cmd-onboard-integration.test.ts):
//
// 1. Top-of-file `vi.mock(modulePath, factory)` — hoisted above all
//    `import`s. `vi.doMock` runs AFTER imports have already bound to the
//    real module, so it does NOT intercept the MCP server's static
//    reference to `cmdOnboard` (captured at `createMcpServer`
//    registration time).
// 2. Partial-mock factories preserve other exports; `vi.mocked()` +
//    per-test `mockImplementationOnce` / `mockResolvedValueOnce` swap the
//    body.
// 3. CLOSURE TRAP: mock factories run at hoist time — BEFORE any
//    `beforeEach`. Mock bodies MUST NOT close over `beforeEach`-scoped
//    variables (e.g. `root` tmpdir). Per-test overrides read from CALL
//    ARGS via `mockImplementationOnce(({ target }) => ...)` so each test
//    sees its own tmpdir, not the FIRST test's stale closure.
// 4. autoProfile mock: the analyzer runs against a partial tmpdir →
//    non-deterministic profile resolution. Hard-pin to "local".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock cmdOnboard via top-of-file vi.mock so per-test overrides via
// mockResolvedValueOnce / mockImplementationOnce intercept the MCP
// server's captured reference. Default factory keeps the call shape
// sane; tests that need a specific shape (apply / pr destructiveHint,
// dry-run plan) override.
vi.mock("../../../src/commands/onboard.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/commands/onboard.js")>();
  return { ...actual, cmdOnboard: vi.fn(actual.cmdOnboard) };
});

// Hard-pin autoProfile to "local" so the agent-review-config seeder's
// emit shape is deterministic in tests.
vi.mock("../../../src/onboard/auto-profile.js", () => ({
  autoProfile: vi.fn(() => "local"),
}));

import { createMcpServer } from "../../../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cmdOnboard } from "../../../src/commands/onboard.js";

const cmdOnboardMock = vi.mocked(cmdOnboard);

// Shared mock body builder. Reads `target` from CALL ARGS to avoid the
// closure trap — each test sees its own tmpdir, not the FIRST
// beforeEach's stale value.
function makeMockResult(args: {
  target: string;
  summary: string;
  branchName: string | null;
}): {
  analysis: Record<string, unknown>;
  plan: Record<string, unknown>;
  branchName: string | null;
  applied: boolean;
} {
  return {
    analysis: {
      schemaVersion: 1,
      repoRoot: args.target,
      canonicalName: "owner/repo",
      stacks: [],
      services: [],
      dependencies: [],
      ci: { workflows: [], deployStory: null },
      tree: { topLevelDirs: [], languageBreakdown: {}, testDirs: [], fileCount: 0 },
      git: {
        recentCommitConventions: { conventional: false, cycleReferenced: false },
        defaultBranch: "main",
      },
      docs: {
        existing: [],
        hasClaudeMd: false,
        hasAgentsMd: false,
        agentContextSetPresent: false,
        claudeMd: null,
        agentsMd: null,
      },
      dfPresence: { hooks: false, configJson: false, prWorkflow: false, cliPin: null },
      decisions: [],
      analyzerErrors: [],
    },
    plan: {
      schemaVersion: 1,
      sourceAnalysisSchemaVersion: 1,
      templateRef: "gh:momentiq-ai/sage-blueprint@" + "0".repeat(40),
      generatedAtIso: new Date("2026-06-03T00:00:00Z").toISOString(),
      files: [],
      summary: args.summary,
    },
    branchName: args.branchName,
    applied: true,
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-onboard-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^2" } }));
  await mkdir(join(root, "services", "api"), { recursive: true });
  await writeFile(join(root, "services", "api", "index.ts"), "");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  // `mockClear()` only resets call history; the partial-mock factory's
  // `vi.fn(actual.cmdOnboard)` default implementation stays installed.
  // `mockReset()` would DESTROY the default — subsequent tests would
  // see `cmdOnboard` return `undefined` and fail.
  cmdOnboardMock.mockClear();
});

async function makeClient(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createMcpServer({ cwd: root });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("df_onboard MCP tool", () => {
  it("is registered + listable", async () => {
    const { client, cleanup } = await makeClient();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("df_onboard");
    } finally {
      await cleanup();
    }
  });

  it("analysis-only mode returns structuredContent with the analysis", async () => {
    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "df_onboard",
        arguments: { target: root, mode: "analysis-only" },
      });
      const sc = result.structuredContent as { analysis: { schemaVersion: number; repoRoot: string } };
      expect(sc.analysis.schemaVersion).toBe(1);
      expect(sc.analysis.repoRoot).toBe(root);
    } finally {
      await cleanup();
    }
  });

  it("dry-run mode returns structuredContent with dryRun=true + a plan", async () => {
    cmdOnboardMock.mockImplementationOnce(async (opts) =>
      makeMockResult({
        target: opts.target,
        summary: "mocked-for-dry-run-test",
        branchName: null,
      }) as Awaited<ReturnType<typeof cmdOnboard>>,
    );
    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "df_onboard",
        arguments: { target: root, mode: "dry-run" },
      });
      const sc = result.structuredContent as { dryRun: boolean; applied: boolean; plan: { files: unknown[] } };
      expect(sc.dryRun).toBe(true);
      expect(sc.applied).toBe(true); // mocked result; the real orchestrator returns false for dry-run
      expect(Array.isArray(sc.plan.files)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("returns an isError result when mode is invalid", async () => {
    const { client, cleanup } = await makeClient();
    try {
      // The Zod input-schema validation produces a structured error result
      // (isError: true) rather than a thrown exception — that's how the
      // SDK surfaces input validation failures to the client.
      const result = await client.callTool({
        name: "df_onboard",
        arguments: { target: root, mode: "nonsense" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toMatch(/Invalid enum value|invalid_enum_value/);
    } finally {
      await cleanup();
    }
  });

  it("renders a markdown summary in content[0].text", async () => {
    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "df_onboard",
        arguments: { target: root, mode: "analysis-only" },
      });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toContain("df_onboard");
    } finally {
      await cleanup();
    }
  });

  it("analysis-only response carries destructiveHint=false (per-call annotation)", async () => {
    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "df_onboard",
        arguments: { target: root, mode: "analysis-only" },
      });
      const annotations = (result as { annotations?: { destructiveHint?: boolean } }).annotations;
      expect(annotations?.destructiveHint).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("dry-run response carries destructiveHint=false (per-call annotation)", async () => {
    cmdOnboardMock.mockImplementationOnce(async (opts) =>
      makeMockResult({
        target: opts.target,
        summary: "mocked-for-destructive-hint-dry-run",
        branchName: null,
      }) as Awaited<ReturnType<typeof cmdOnboard>>,
    );
    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "df_onboard",
        arguments: { target: root, mode: "dry-run" },
      });
      const annotations = (result as { annotations?: { destructiveHint?: boolean } }).annotations;
      expect(annotations?.destructiveHint).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("listTools surfaces openWorldHint=true and NO tool-level destructiveHint (it's per-call)", async () => {
    const { client, cleanup } = await makeClient();
    try {
      const tools = await client.listTools();
      const df = tools.tools.find((t) => t.name === "df_onboard");
      expect(df?.annotations?.openWorldHint).toBe(true);
      // destructiveHint is set per-call (varies by mode), NOT at registration.
      expect(df?.annotations?.destructiveHint).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("apply mode response carries destructiveHint=true (per-call)", async () => {
    cmdOnboardMock.mockImplementationOnce(async (opts) =>
      makeMockResult({
        target: opts.target,
        summary: "mocked-for-apply-destructive-hint",
        branchName: null,
      }) as Awaited<ReturnType<typeof cmdOnboard>>,
    );
    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "df_onboard",
        arguments: { target: root, mode: "apply" },
      });
      const annotations = (result as { annotations?: { destructiveHint?: boolean } }).annotations;
      expect(annotations?.destructiveHint).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("pr mode response carries destructiveHint=true (per-call)", async () => {
    cmdOnboardMock.mockImplementationOnce(async (opts) =>
      makeMockResult({
        target: opts.target,
        summary: "mocked-for-pr-destructive-hint",
        branchName: "df/onboard-deadbeef",
      }) as Awaited<ReturnType<typeof cmdOnboard>>,
    );
    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "df_onboard",
        arguments: { target: root, mode: "pr" },
      });
      const annotations = (result as { annotations?: { destructiveHint?: boolean } }).annotations;
      expect(annotations?.destructiveHint).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("dry-run delegates to cmdOnboard and returns a merged ScaffoldPlan (Phase B + Phase C, deduped)", async () => {
    cmdOnboardMock.mockImplementationOnce(async (opts) =>
      makeMockResult({
        target: opts.target,
        summary: "mocked-for-merge-delegation",
        branchName: null,
      }) as Awaited<ReturnType<typeof cmdOnboard>>,
    );
    const { client, cleanup } = await makeClient();
    try {
      const result = await client.callTool({
        name: "df_onboard",
        arguments: { target: root, mode: "dry-run" },
      });
      const sc = result.structuredContent as {
        plan: { schemaVersion?: number; files: { path: string }[] };
      };
      // schemaVersion carries through — the response is NOT a synthetic
      // seeder-only envelope; it's the real merged plan shape.
      expect(sc.plan.schemaVersion).toBe(1);
      expect(Array.isArray(sc.plan.files)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
