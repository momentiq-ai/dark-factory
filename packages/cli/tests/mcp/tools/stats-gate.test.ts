// MCP `df_gate_push` tool — Cycle 13 (dark-factory-platform#149) final-
// commit-only contract parity tests.
//
// Pin: the MCP tool surface MUST mirror the CLI `df gate-push` behavior
// so an MCP-driven agent and an operator running `df gate-push` from a
// shell evaluate the same push under the same semantic. Pre-Cycle-13 the
// MCP tool iterated every commit in the pushed range; Cycle 13 flipped
// the CLI default to HEAD-only and added a `--full-range` opt-in. Without
// the same flip on the MCP side, a regression-fixture replay (8-round
// find-fix trail with APPROVED HEAD + stale CHANGES_REQUESTED inter-
// mediates) blocks via the MCP path while the CLI allows it — exactly
// the surface-divergence the cycle 5 spec forbids.
//
// What this file pins:
//   1. df_gate_push default mode: 8-round trail with APPROVED HEAD →
//      verdict 'allow'. Mirrors the CLI regression test.
//   2. df_gate_push with full_range=true: same trail → verdict 'block'
//      (or 'bypass-required' when policy.allowEmergencyBypass=true).
//      Pins the opt-in path is wired AND the legacy semantic is intact.
//   3. df_gate_push input schema exposes `full_range` flag.
//   4. df_gate_push description text references the HEAD-only default
//      so MCP clients listing tools don't operate under the stale
//      "evaluates each commit" mental model.
//
// Fixture pattern reuses the same find-fix iteration trail the CLI's
// gate-push-final-commit-only.test.ts builds — same v1 config, same
// per-SHA artifact seeding with real diff hashes so the gate's stale-
// diff check passes.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { commitDiff, diffHash } from "../../../src/git.js";
import { createMcpServer } from "../../../src/mcp/server.js";

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return String(r.stdout).trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "df-mcp-gate-push-cycle13-"));
  spawnSync("git", ["init", "-q", "-b", "main", root]);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  return root;
}

function makeCommit(
  root: string,
  file: string,
  content: string,
  message: string,
): string {
  writeFileSync(join(root, file), content);
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", message], { cwd: root });
  return git(root, ["rev-parse", "HEAD"]);
}

function writeConfig(root: string, opts: { allowEmergencyBypass?: boolean } = {}): void {
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
        blockOnMissingReview: false,
        blockOnReviewError: false,
        allowEmergencyBypass: opts.allowEmergencyBypass ?? false,
        postCommitMode: "async",
      },
      context: {
        guidanceFiles: [],
        promptFragments: [],
        maxChangedFileBytes: 1000,
        includeFullChangedFiles: false,
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
}

async function seedArtifact(
  root: string,
  commitSha: string,
  verdict: "APPROVED" | "CHANGES_REQUESTED",
): Promise<void> {
  mkdirSync(join(root, ".git", "agent-reviews"), { recursive: true });
  const findings = verdict === "CHANGES_REQUESTED"
    ? [
        {
          severity: "blocker",
          category: "missing-test",
          file: "src/foo.ts",
          line: 1,
          evidence: "no test exists for the new function",
          impact: "regression risk",
          requiredFix: "add a unit test",
        },
      ]
    : [];
  const parent = git(root, ["rev-list", "--parents", "-n", "1", commitSha])
    .split(/\s+/)
    .slice(1)[0] ?? "";
  const diff = await commitDiff(parent, commitSha, root);
  const realDiffHash = diffHash(diff);
  writeFileSync(
    join(root, ".git", "agent-reviews", `${commitSha}.json`),
    JSON.stringify({
      version: 2,
      status: "complete",
      repo: "test/test",
      commit: commitSha,
      parent,
      range: `${parent.slice(0, 7)}..${commitSha.slice(0, 7)}`,
      diffHash: realDiffHash,
      artifactScope: "git-common-dir",
      gateVerdict: verdict,
      aggregationPolicy: "block-if-any",
      criticResults: [
        {
          criticId: "cursor-local-chief-engineer",
          status: "complete",
          verdict,
          requiresHumanJudgment: false,
          reviewer: {
            name: "Cursor",
            adapter: "cursor-sdk",
            model: { id: "gpt-5.5", params: [] },
            runtime: "local",
          },
          summary: findings.length > 0 ? `${findings.length} blocker(s).` : "no blockers.",
          findings,
          validation: { qualityGateResults: [], qualityGatesMissing: [] },
          confidence: "high",
        },
      ],
      createdAt: "2026-05-27T15:00:00.000Z",
    }),
    "utf8",
  );
}

async function fixtureIterationTrail(
  rounds: number,
  opts: { allowEmergencyBypass?: boolean } = {},
): Promise<{
  root: string;
  baseSha: string;
  iterationShas: string[];
  headSha: string;
  remoteSha: string;
}> {
  const root = initRepo();
  writeConfig(root, opts);
  const baseSha = makeCommit(root, "README.md", "# fixture\n", "base");
  const iterationShas: string[] = [];
  for (let i = 1; i <= rounds; i++) {
    const isLast = i === rounds;
    const sha = makeCommit(
      root,
      `iteration-${i}.ts`,
      `// round ${i}\nexport const round${i} = ${i};\n`,
      `round ${i}: ${isLast ? "final fix" : "iterate"}`,
    );
    iterationShas.push(sha);
    await seedArtifact(root, sha, isLast ? "APPROVED" : "CHANGES_REQUESTED");
  }
  const headSha = iterationShas[iterationShas.length - 1] ?? "";
  return { root, baseSha, iterationShas, headSha, remoteSha: baseSha };
}

function prePushStdin(localSha: string, remoteSha: string): string {
  return `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`;
}

describe("df_gate_push MCP tool — Cycle 13 final-commit-only contract parity", () => {
  it("[REGRESSION] default mode: 8-round trail with APPROVED HEAD returns verdict 'allow'", async () => {
    // Same scenario as the CLI's regression test (gate-push-final-
    // commit-only.test.ts). MCP-driven agents replaying this fixture
    // must see 'allow' so their gate semantic matches the operator's
    // CLI gate semantic. Without this parity the same push is allowed
    // by the CLI and blocked by the MCP tool — cycle 5 surface
    // divergence.
    const { root, headSha, remoteSha } = await fixtureIterationTrail(8);
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-stats-gate-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_gate_push",
        arguments: { stdin_protocol: prePushStdin(headSha, remoteSha) },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        verdict: string;
        commits_evaluated: number;
        reasons: Array<{ commit: string }>;
      };
      expect(structured.verdict).toBe("allow");
      // Default mode evaluates ONLY HEAD, not all 8 commits.
      expect(structured.commits_evaluated).toBe(1);
      expect(structured.reasons).toHaveLength(0);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("full_range=true: same 8-round trail blocks (legacy semantic preserved)", async () => {
    // The MCP tool's opt-in legacy path must match the CLI's
    // --full-range flag: every commit gated, any blocker vetoes.
    // With allowEmergencyBypass=false the verdict is the hard 'block';
    // this fixture sets it that way so the assertion is unambiguous.
    const { root, headSha, remoteSha } = await fixtureIterationTrail(8);
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-stats-gate-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_gate_push",
        arguments: {
          stdin_protocol: prePushStdin(headSha, remoteSha),
          full_range: true,
        },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        verdict: string;
        commits_evaluated: number;
        reasons: Array<{ commit: string }>;
      };
      // Legacy mode evaluates all 8 commits; 7 carry CHANGES_REQUESTED
      // blocker findings, so the verdict is the hard block (no bypass
      // path — policy.allowEmergencyBypass=false in this fixture).
      expect(structured.verdict).toBe("block");
      expect(structured.commits_evaluated).toBe(8);
      expect(structured.reasons.length).toBeGreaterThan(0);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("default mode with CHANGES_REQUESTED HEAD blocks (HEAD's verdict is the gate)", async () => {
    // Inverse pin: default-mode HEAD-only doesn't accidentally allow
    // a bad HEAD through just because intermediates are APPROVED.
    const root = initRepo();
    writeConfig(root, { allowEmergencyBypass: false });
    const baseSha = makeCommit(root, "README.md", "# fixture\n", "base");
    const a = makeCommit(root, "a.ts", "export const a = 1;\n", "a");
    const b = makeCommit(root, "b.ts", "export const b = 2;\n", "b");
    await seedArtifact(root, a, "APPROVED");
    await seedArtifact(root, b, "CHANGES_REQUESTED");
    try {
      const server = createMcpServer({ cwd: root });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: "df-stats-gate-test", version: "0.0.0" },
        { capabilities: {} },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "df_gate_push",
        arguments: { stdin_protocol: prePushStdin(b, baseSha) },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        verdict: string;
        commits_evaluated: number;
        reasons: Array<{ commit: string }>;
      };
      expect(structured.verdict).toBe("block");
      expect(structured.commits_evaluated).toBe(1);
      expect(structured.reasons.length).toBeGreaterThan(0);

      await client.close();
      await server.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tool catalog exposes the full_range input flag and HEAD-only default in description", async () => {
    // tools/list contract: an MCP client reading the catalog must see
    // both the new opt-in input AND a description that no longer
    // claims per-commit evaluation as the default.
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client(
      { name: "df-stats-gate-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const dfGatePush = tools.tools.find((t) => t.name === "df_gate_push");
    expect(dfGatePush).toBeDefined();
    const inputProps = (dfGatePush?.inputSchema?.properties ?? {}) as Record<
      string,
      unknown
    >;
    expect(inputProps).toHaveProperty("full_range");
    // The description must surface the new default semantic so clients
    // listing tools don't operate under the stale per-commit mental
    // model. Mirrors the CLI gate-push --help requirement.
    expect(dfGatePush?.description ?? "").toMatch(/HEAD/);
    expect(dfGatePush?.description ?? "").toContain("full_range");

    await client.close();
    await server.close();
  });
});
