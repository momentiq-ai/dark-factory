// Integration tests for the cycle5 Phase 1 step 9 elicitation wiring.
//
// When df_bypass is called WITHOUT issue_url AND the client declares
// the elicitation capability, the server calls elicitInput to ask
// the user for either a URL or an explicit "no issue needed"
// confirmation. The user's answer is captured in the audit entry's
// bypassReason metadata prefix.
//
// Clients without elicitation fall through to the soft-warning
// behavior (covered by the existing df_bypass test in server.test.ts);
// this file pins the step-9 elicitation paths.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createMcpServer } from "../../src/mcp/server.js";

let root: string;
let sha: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "df-elicit-"));
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
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type ElicitHandler = () => {
  action: "accept" | "decline" | "cancel";
  content?: { issue_url?: string; no_issue_needed?: boolean };
};

async function openWithElicitation(handler: ElicitHandler) {
  const server = createMcpServer({ cwd: root });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "df-elicit-test", version: "0.0.0" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(ElicitRequestSchema, () => handler());
  await client.connect(clientTransport);
  return {
    client,
    server,
    close: async (): Promise<void> => {
      await client.close();
      await server.close();
    },
  };
}

function readBypassEntries(): Array<{ event: string; bypassReason: string }> {
  return readFileSync(join(root, ".git", "agent-reviews", "_runs.ndjson"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { event: string; bypassReason: string });
}

describe("df_bypass elicitation (cycle5 Phase 1 step 9)", () => {
  it("captures the user-provided issue URL into the audit metadata", async () => {
    const { client, close } = await openWithElicitation(() => ({
      action: "accept",
      content: {
        issue_url: "https://github.com/momentiq-ai/dark-factory/issues/1234",
      },
    }));
    try {
      const result = await client.callTool({
        name: "df_bypass",
        arguments: { reason: "elicited URL", sha },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as
        | { warnings: string[] }
        | undefined;
      // No warning because we got a URL from elicitation.
      expect(structured?.warnings).toEqual([]);

      const entries = readBypassEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.bypassReason).toMatch(
        /^\[mcp:bypass_[0-9a-f]+ issue:https:\/\/github\.com\/momentiq-ai\/dark-factory\/issues\/1234\]/,
      );
    } finally {
      await close();
    }
  });

  it("records `no-issue:elicited` when the user explicitly waives the issue link", async () => {
    const { client, close } = await openWithElicitation(() => ({
      action: "accept",
      content: { no_issue_needed: true },
    }));
    try {
      const result = await client.callTool({
        name: "df_bypass",
        arguments: { reason: "intentional waiver", sha },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { warnings: string[] };
      // Explicit waiver → no warning (the user made a deliberate
      // choice, recorded in the audit log).
      expect(structured.warnings).toEqual([]);

      const entries = readBypassEntries();
      expect(entries[0]?.bypassReason).toMatch(
        /^\[mcp:bypass_[0-9a-f]+ no-issue:elicited\]/,
      );
    } finally {
      await close();
    }
  });

  it("rejects an issue_url that isn't an http(s) URL — falls back to soft warning", async () => {
    const { client, close } = await openWithElicitation(() => ({
      action: "accept",
      content: { issue_url: "not-a-url" },
    }));
    try {
      const result = await client.callTool({
        name: "df_bypass",
        arguments: { reason: "garbage URL", sha },
      });
      const structured = result.structuredContent as { warnings: string[] };
      // No URL in the metadata (rejected by the http(s) check).
      // Also no no-issue:elicited (the user provided SOMETHING). The
      // accepted-but-empty path treats this as the soft-skip case.
      expect(structured.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/issue_url missing/)]),
      );
      const entries = readBypassEntries();
      expect(entries[0]?.bypassReason).not.toMatch(/issue:not-a-url/);
    } finally {
      await close();
    }
  });

  it("when the user declines the elicitation, the bypass still records (no warning)", async () => {
    const { client, close } = await openWithElicitation(() => ({
      action: "decline",
    }));
    try {
      const result = await client.callTool({
        name: "df_bypass",
        arguments: { reason: "declined elicitation", sha },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { warnings: string[] };
      // User actively declined — no warning (they engaged with the
      // prompt and chose to skip).
      expect(structured.warnings).toEqual([]);

      const entries = readBypassEntries();
      // No issue + no no-issue:elicited in metadata.
      expect(entries[0]?.bypassReason).toMatch(/^\[mcp:bypass_[0-9a-f]+\]/);
      expect(entries[0]?.bypassReason).not.toMatch(/issue:/);
      expect(entries[0]?.bypassReason).not.toMatch(/no-issue:/);
    } finally {
      await close();
    }
  });

  it("explicit issue_url argument skips elicitation entirely (callers that already pass one don't get prompted)", async () => {
    let elicitCallCount = 0;
    const { client, close } = await openWithElicitation(() => {
      elicitCallCount += 1;
      return { action: "accept", content: {} };
    });
    try {
      const result = await client.callTool({
        name: "df_bypass",
        arguments: {
          reason: "explicit URL",
          sha,
          issue_url: "https://github.com/momentiq-ai/dark-factory/issues/9999",
        },
      });
      expect(result.isError).toBeFalsy();
      // Elicitation never called — the arg was already provided.
      expect(elicitCallCount).toBe(0);

      const entries = readBypassEntries();
      expect(entries[0]?.bypassReason).toMatch(
        /issue:https:\/\/github\.com\/momentiq-ai\/dark-factory\/issues\/9999/,
      );
    } finally {
      await close();
    }
  });
});
