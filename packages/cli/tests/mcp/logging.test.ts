// Integration tests for cycle5 Phase 1 step 10 — logging/message
// notifications.
//
// The server declares the `logging` capability + emits
// notifications/message during long-running tools (df_review,
// df_cycle_doc_generate, df_adr_generate). Clients subscribe by
// setting a notification handler for LoggingMessageNotificationSchema.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CreateMessageRequestSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "../../src/mcp/server.js";
import type {
  ReviewRunOptions,
  ReviewRunOutcome,
} from "../../src/runner.js";

let root: string;
let sha: string;

function writeStandardConfig(rootDir: string): void {
  mkdirSync(join(rootDir, ".agent-review", "prompts"), { recursive: true });
  writeFileSync(join(rootDir, "CLAUDE.md"), "# CLAUDE\n", "utf8");
  writeFileSync(
    join(rootDir, ".agent-review", "prompts", "local-critic.md"),
    "# local\n",
    "utf8",
  );
  writeFileSync(
    join(rootDir, ".agent-review", "config.json"),
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
        allowEmergencyBypass: true,
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
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "df-logging-"));
  spawnSync("git", ["init", "-q", "-b", "main", root]);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  writeFileSync(join(root, "README.md"), "# x\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  sha = String(
    spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout,
  ).trim();
  writeStandardConfig(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("logging/message notifications (cycle5 Phase 1 step 10)", () => {
  it("server declares the `logging` capability on initialize", async () => {
    const server = createMcpServer({ cwd: root });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "df-logging-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    expect(client.getServerCapabilities()?.logging).toBeDefined();
    await client.close();
    await server.close();
  });

  it("df_review emits logging/message notifications via the tee'd telemetry sink", async () => {
    // Stub runReview that emits a few synthetic telemetry events via
    // the supplied sink, then returns a synthetic outcome. This is
    // exactly the path the LoggingTeeSink covers.
    const stubRunReview = async (
      options: ReviewRunOptions,
    ): Promise<ReviewRunOutcome> => {
      const sink = options.telemetry;
      if (sink) {
        sink.emit({
          ts: new Date().toISOString(),
          event: "review_started",
          commit: sha,
        });
        sink.emit({
          ts: new Date().toISOString(),
          event: "critic_run_started",
          commit: sha,
          criticId: "cursor-local",
        });
        sink.emit({
          ts: new Date().toISOString(),
          event: "critic_run_finished",
          commit: sha,
          criticId: "cursor-local",
          verdict: "APPROVED",
          durationMs: 1234,
        });
        sink.emit({
          ts: new Date().toISOString(),
          event: "review_finished",
          commit: sha,
          verdict: "APPROVED",
        });
      }
      return {
        artifact: {
          version: 2,
          status: "complete",
          repo: "test/test",
          commit: sha,
          parent: "0000000000000000000000000000000000000000",
          range: `0000000..${sha.slice(0, 7)}`,
          diffHash: "sha256:test",
          artifactScope: "git-common-dir",
          gateVerdict: "APPROVED",
          aggregationPolicy: "block-if-any",
          criticResults: [],
          createdAt: "2026-05-27T15:00:00.000Z",
        },
        paths: {
          jsonPath: join(root, ".git", "agent-reviews", `${sha}.json`),
          markdownPath: null,
        },
        packet: {} as never,
        acquired: true,
      };
    };

    const server = createMcpServer({ cwd: root, _testRunReview: stubRunReview });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "df-logging-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const collected: Array<{ level: string; logger?: string; data: unknown }> = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      collected.push({
        level: n.params.level,
        ...(n.params.logger !== undefined ? { logger: n.params.logger } : {}),
        data: n.params.data,
      });
    });
    await client.connect(clientTransport);

    await client.callTool({
      name: "df_review",
      arguments: { commit: sha },
    });
    // Wait a few ticks for the async runReview + the logging
    // notifications to flush.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }

    // The 4 stubbed events should produce 4 logging notifications via
    // the tee'd sink — all with logger="df_review".
    const dfReviewLogs = collected.filter((c) => c.logger === "df_review");
    expect(dfReviewLogs.length).toBeGreaterThanOrEqual(4);
    const datas = dfReviewLogs.map((c) => String(c.data));
    expect(datas.some((d) => /review started/.test(d))).toBe(true);
    expect(datas.some((d) => /running critic.*cursor-local/.test(d))).toBe(true);
    expect(datas.some((d) => /critic finished.*APPROVED/.test(d))).toBe(true);
    expect(datas.some((d) => /review finished.*APPROVED/.test(d))).toBe(true);

    await client.close();
    await server.close();
  });

  it("df_cycle_doc_generate emits log messages at each step (sending → received → wrote)", async () => {
    const server = createMcpServer({ cwd: root });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "df-logging-test", version: "0.0.0" },
      { capabilities: { sampling: {} } },
    );
    client.setRequestHandler(CreateMessageRequestSchema, () => ({
      model: "claude-test-stub",
      role: "assistant" as const,
      content: {
        type: "text" as const,
        text:
          "---\ntitle: T\nstatus: draft\n---\n\n# cycle99 — Test\n\n## Scope\n\nx\n\n## Implementation plan\n\n1.\n\n## Exit criteria\n\nok\n",
      },
      stopReason: "endTurn" as const,
    }));
    const collected: Array<{ level: string; logger?: string; data: unknown }> = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      collected.push({
        level: n.params.level,
        ...(n.params.logger !== undefined ? { logger: n.params.logger } : {}),
        data: n.params.data,
      });
    });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "df_cycle_doc_generate",
      arguments: { cycle_id: "cycle99", title: "Test", scope: "x" },
    });
    expect(result.isError).toBeFalsy();
    // Wait for any trailing notifications.
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
    }

    const logs = collected.filter((c) => c.logger === "df_cycle_doc_generate");
    expect(logs.length).toBeGreaterThanOrEqual(3);
    const datas = logs.map((c) => String(c.data));
    expect(datas.some((d) => /sending prompt/.test(d))).toBe(true);
    expect(datas.some((d) => /LLM response received/.test(d))).toBe(true);
    expect(datas.some((d) => /^wrote /.test(d))).toBe(true);

    await client.close();
    await server.close();
  });

  it("df_cycle_doc_generate emits an error-level log when validation fails", async () => {
    const server = createMcpServer({ cwd: root });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "df-logging-test", version: "0.0.0" },
      { capabilities: { sampling: {} } },
    );
    client.setRequestHandler(CreateMessageRequestSchema, () => ({
      model: "claude-test-stub",
      role: "assistant" as const,
      content: { type: "text" as const, text: "this is not a valid cycle doc" },
      stopReason: "endTurn" as const,
    }));
    const collected: Array<{ level: string; data: unknown }> = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      collected.push({ level: n.params.level, data: n.params.data });
    });
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "df_cycle_doc_generate",
      arguments: { cycle_id: "cycle98", title: "Bad", scope: "x" },
    });
    expect(result.isError).toBe(true);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const errorLogs = collected.filter((c) => c.level === "error");
    expect(errorLogs.length).toBeGreaterThanOrEqual(1);
    expect(errorLogs.some((c) => /validation failed/.test(String(c.data)))).toBe(true);

    await client.close();
    await server.close();
  });

  it("notifications include a `level` field and the `logger` namespace", async () => {
    // Lightweight check that the notification shape matches the
    // schema clients use (level + data are required by the SDK;
    // logger is optional but our code always sets it).
    const stubRunReview = async (options: ReviewRunOptions): Promise<ReviewRunOutcome> => {
      options.telemetry?.emit({
        ts: new Date().toISOString(),
        event: "review_started",
        commit: sha,
      });
      return {
        artifact: {
          version: 2,
          status: "complete",
          repo: "test/test",
          commit: sha,
          parent: "0000000000000000000000000000000000000000",
          range: `0000000..${sha.slice(0, 7)}`,
          diffHash: "sha256:test",
          artifactScope: "git-common-dir",
          gateVerdict: "APPROVED",
          aggregationPolicy: "block-if-any",
          criticResults: [],
          createdAt: "2026-05-27T15:00:00.000Z",
        },
        paths: {
          jsonPath: join(root, ".git", "agent-reviews", `${sha}.json`),
          markdownPath: null,
        },
        packet: {} as never,
        acquired: true,
      };
    };

    const server = createMcpServer({ cwd: root, _testRunReview: stubRunReview });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "df-logging-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const collected: Array<{
      level?: string;
      logger?: string;
      data?: unknown;
    }> = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      collected.push({
        level: n.params.level,
        ...(n.params.logger !== undefined ? { logger: n.params.logger } : {}),
        data: n.params.data,
      });
    });
    await client.connect(clientTransport);

    await client.callTool({ name: "df_review", arguments: { commit: sha } });
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(collected.length).toBeGreaterThan(0);
    for (const c of collected) {
      expect(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]).toContain(
        c.level,
      );
      expect(c.logger).toBe("df_review");
      expect(typeof c.data).toBe("string");
    }

    await client.close();
    await server.close();
  });
});
