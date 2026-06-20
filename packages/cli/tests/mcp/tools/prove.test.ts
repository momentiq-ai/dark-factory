// df_prove MCP tool — end-to-end tools/call against a real fixture repo.
// Drives the in-memory transport so the JSON-RPC framing + the shared join core
// are exercised together. The pure join + CLI are covered in
// tests/evidence/prove.test.ts and tests/cli-prove.test.ts.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../../../src/mcp/server.js";
import { loadAgentReviewConfig } from "../../../src/policy/config.js";
import { commitDiff, diffHash, resolveCommit, safeParentOrThrow } from "../../../src/git.js";
import { perShaQualityGatePath } from "../../../src/evidence/per-sha.js";
import { resolveArtifactRoot } from "../../../src/paths.js";
import { fixturePath } from "../../_helpers.js";
import type { BoundProofRecord, QualityGateEvidence } from "@momentiq/dark-factory-schemas";

const OBJECTIVES = `schemaVersion: 1
objectives:
  - id: cycle21#ec1
    source: { kind: cycle, ref: "21" }
    text: "Route-backed objective."
    attestedBy:
      - { kind: route, routeId: targeted-test }
    enforced: false
`;

function initRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  spawnSync("git", ["init", "-q", "-b", "main", root]);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  writeFileSync(join(root, "README.md"), "# x\n");
  const cfg = JSON.parse(readFileSync(fixturePath("config.json"), "utf8"));
  mkdirSync(join(root, ".agent-review"), { recursive: true });
  writeFileSync(join(root, ".agent-review/config.json"), JSON.stringify(cfg));
  return root;
}

function commitAll(root: string): void {
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
}

async function connectClient(root: string): Promise<Client> {
  const server = createMcpServer({ cwd: root });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "df-prove-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("df_prove MCP tool", () => {
  it("a diffHash-bound green route proves the objective (structuredContent)", async () => {
    const root = initRepo("df-mcp-prove-");
    mkdirSync(join(root, ".darkfactory"), { recursive: true });
    writeFileSync(join(root, ".darkfactory/objectives.yaml"), OBJECTIVES);
    commitAll(root);

    const loaded = await loadAgentReviewConfig({ cwd: root, validateGuidanceFiles: false });
    const sha = await resolveCommit("HEAD", root);
    const parent = await safeParentOrThrow(sha, root);
    const headDiff = diffHash(await commitDiff(parent, sha, root));

    const gp = perShaQualityGatePath(await resolveArtifactRoot(loaded), loaded.config.git.artifactDir, sha);
    const evidence: QualityGateEvidence = {
      version: 2,
      commit: sha,
      generatedAt: "2026-06-20T00:00:00.000Z",
      results: [],
      gateResults: {
        "targeted-test": {
          command: "t",
          exitCode: 0,
          durationMs: 1,
          logExcerpt: "ok",
          startedAt: "2026-06-20T00:00:00.000Z",
          finishedAt: "2026-06-20T00:00:01.000Z",
          routeId: "targeted-test",
        },
      },
      diffHash: headDiff, // bind the evidence to HEAD's diff so the route proves
    };
    mkdirSync(dirname(gp), { recursive: true });
    writeFileSync(gp, `${JSON.stringify(evidence, null, 2)}\n`);

    const client = await connectClient(root);
    const result = await client.callTool({ name: "df_prove", arguments: { commit: sha } });
    const rec = result.structuredContent as unknown as BoundProofRecord;
    expect(rec.schemaVersion).toBe(1);
    expect(rec.commit).toBe(sha);
    expect(rec.provenance).toBe("consumer-attested");
    expect(rec.objectives[0].id).toBe("cycle21#ec1");
    expect(rec.objectives[0].status).toBe("proven");
    expect(rec.objectives[0].bindings[0]).toMatchObject({
      kind: "route",
      ref: "targeted-test",
      status: "proven",
    });
    expect(rec.summary).toEqual({ proven: 1, pending: 0, failed: 0, total: 1 });
  });

  it("returns an empty record when no objectives manifest exists", async () => {
    const root = initRepo("df-mcp-prove-empty-");
    commitAll(root);
    const sha = await resolveCommit("HEAD", root);

    const client = await connectClient(root);
    const result = await client.callTool({ name: "df_prove", arguments: { commit: sha } });
    const rec = result.structuredContent as unknown as BoundProofRecord;
    expect(rec.summary.total).toBe(0);
    expect(rec.objectives).toHaveLength(0);
  });
});
