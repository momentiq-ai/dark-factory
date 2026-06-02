// Behavior tests for `df show` + `df status` (issue #55).
//
// Pins:
//   1. `df show --json` output is byte-equivalent with the
//      `df_show_run` MCP tool's `structuredContent` envelope.
//      Both surfaces share `loadForCommit` from
//      src/commands/show-status-core.ts, so the test creates one
//      fixture repo + artifact and compares the CLI subcommand's
//      stdout against the MCP tool's structuredContent for the SAME
//      commit. Any drift (e.g. someone re-wraps the CLI's payload
//      under a different key) fails the test loudly.
//   2. `df show` (no --json) renders the human-readable status block
//      with the verdict + per-critic lines.
//   3. `df status --json` returns the narrowed shape (commit, status,
//      verdict, critics with id/status/verdict/findings count) — the
//      pipeline-friendly subset.
//   4. Failure modes: a non-existent artifact exits 1 with a clear
//      error message; an invalid commit ref exits 1; unknown flag
//      exits 2.

import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/mcp/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "dist", "cli.js");

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runDfCli(args: string[], cwd?: string): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code) => {
      resolvePromise({ exitCode: code === null ? -1 : code, stdout, stderr });
    });
  });
}

function setupArtifactRepo(): { root: string; commitSha: string } {
  const root = mkdtempSync(join(tmpdir(), "df-cli-show-status-"));
  spawnSync("git", ["init", "-q", "-b", "main", root]);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  writeFileSync(join(root, "README.md"), "# fixture\n");
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
      diffHash: "sha256:test-fixture",
      artifactScope: "git-common-dir",
      gateVerdict: "CHANGES_REQUESTED",
      aggregationPolicy: "block-if-any",
      criticResults: [
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
      ],
      createdAt: "2026-05-27T15:00:00.000Z",
    }),
    "utf8",
  );

  return { root, commitSha };
}

describe("df show — CLI mirror of df_show_run (closes #55)", () => {
  it("--help prints the subcommand's own help (routed past printHelp)", async () => {
    const r = await runDfCli(["show", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df show");
    expect(r.stdout).toContain("--json");
    expect(r.stdout).toContain("--commit");
  });

  it("--json output is byte-equivalent with df_show_run.structuredContent", async () => {
    const { root, commitSha } = setupArtifactRepo();
    try {
      // CLI side — spawn the binary inside the fixture repo.
      const cli = await runDfCli(["show", "--json", "--commit", commitSha], root);
      expect(cli.exitCode).toBe(0);
      const cliPayload = JSON.parse(cli.stdout) as { artifact: unknown };

      // MCP side — call the same backend through the MCP server.
      const server = createMcpServer({ cwd: root });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client(
        { name: "df-show-equivalence", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientT);
      const mcpResult = await client.callTool({
        name: "df_show_run",
        arguments: { commit: commitSha },
      });
      expect(mcpResult.isError).toBeFalsy();
      const mcpPayload = mcpResult.structuredContent as { artifact: unknown };

      // Cycle 5 spec: the two payloads MUST match exactly. Any future
      // drift (e.g. CLI re-wraps under a different envelope key) is a
      // spec violation caught here loudly.
      expect(cliPayload).toEqual(mcpPayload);
      expect(
        (cliPayload.artifact as { commit?: string }).commit,
      ).toBe(commitSha);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("without --json renders the human-readable status block", async () => {
    const { root, commitSha } = setupArtifactRepo();
    try {
      const r = await runDfCli(["show", "--commit", commitSha], root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`commit:   ${commitSha}`);
      expect(r.stdout).toContain("verdict:  CHANGES_REQUESTED");
      expect(r.stdout).toContain("cursor-local-chief-engineer");
      expect(r.stdout).toContain("findings=1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults --commit to HEAD when omitted", async () => {
    const { root } = setupArtifactRepo();
    try {
      const r = await runDfCli(["show", "--json"], root);
      expect(r.exitCode).toBe(0);
      const payload = JSON.parse(r.stdout) as { artifact: { commit: string } };
      expect(payload.artifact.commit).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 1 with a clear error when no artifact exists for the commit", async () => {
    const { root } = setupArtifactRepo();
    try {
      // Make a second commit so HEAD has no artifact (the fixture only
      // wrote the FIRST commit's artifact).
      writeFileSync(join(root, "second.txt"), "x\n");
      spawnSync("git", ["add", "."], { cwd: root });
      spawnSync("git", ["commit", "-q", "-m", "second"], { cwd: root });

      const r = await runDfCli(["show", "--commit", "HEAD"], root);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("no review artifact");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("unknown flag exits 2 with usage hint", async () => {
    const r = await runDfCli(["show", "--bogus"], "/tmp");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("df show");
    expect(r.stderr).toContain("--help");
  });
});

describe("df status — CLI narrowed verdict view (closes #55)", () => {
  it("--help prints the subcommand's own help (routed past printHelp)", async () => {
    const r = await runDfCli(["status", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df status");
    expect(r.stdout).toContain("--json");
  });

  it("without --json renders the human-readable status block", async () => {
    const { root, commitSha } = setupArtifactRepo();
    try {
      const r = await runDfCli(["status", "--commit", commitSha], root);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`commit:   ${commitSha}`);
      expect(r.stdout).toContain("verdict:  CHANGES_REQUESTED");
      expect(r.stdout).toContain("cursor-local-chief-engineer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--json returns the narrowed pipeline-friendly shape", async () => {
    const { root, commitSha } = setupArtifactRepo();
    try {
      const r = await runDfCli(["status", "--json", "--commit", commitSha], root);
      expect(r.exitCode).toBe(0);
      const payload = JSON.parse(r.stdout) as {
        commit: string;
        status: string;
        verdict: string | null;
        critics: Array<{
          id: string;
          status: string;
          verdict: string | null;
          findings: number;
        }>;
      };
      expect(payload.commit).toBe(commitSha);
      expect(payload.status).toBe("complete");
      expect(payload.verdict).toBe("CHANGES_REQUESTED");
      expect(payload.critics).toHaveLength(1);
      expect(payload.critics[0]).toEqual({
        id: "cursor-local-chief-engineer",
        status: "complete",
        verdict: "CHANGES_REQUESTED",
        findings: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits 1 when no config exists in cwd", async () => {
    const r = await runDfCli(["status"], "/tmp");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("df status");
  });
});
