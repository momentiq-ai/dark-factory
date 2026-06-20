import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadAgentReviewConfig, type LoadedConfig } from "../../src/policy/config.js";
import { resolveCommit } from "../../src/git.js";
import { perShaQualityGatePath } from "../../src/evidence/per-sha.js";
import { resolveArtifactRoot } from "../../src/paths.js";
import { buildProofRecord, collectProofInputs, type ProofInputs } from "../../src/evidence/prove.js";
import { fixturePath } from "../_helpers.js";
import type { EvidenceBinding, Objective, QualityGateEvidence } from "@momentiq/dark-factory-schemas";

const HEAD_DIFF = "feed".repeat(16);

function obj(id: string, attestedBy: EvidenceBinding[], enforced = false): Objective {
  return { id, source: { kind: "cycle", ref: "21" }, text: id, attestedBy, enforced };
}

function inputs(partial: Partial<ProofInputs>): ProofInputs {
  return {
    commit: "abc123def456",
    headDiffHash: HEAD_DIFF,
    objectives: [],
    gateResults: {},
    criticResults: {},
    ...partial,
  };
}

const AT = "2026-06-20T00:00:00.000Z";

describe("buildProofRecord — per-binding trichotomy", () => {
  it("route: exit 0 + diffHash-bound → proven", () => {
    const r = buildProofRecord(
      inputs({
        objectives: [obj("cycle21#ec1", [{ kind: "route", routeId: "targeted-test" }])],
        gateResults: { "targeted-test": { exitCode: 0 } },
        evidenceDiffHash: HEAD_DIFF,
      }),
      AT,
    );
    expect(r.objectives[0].status).toBe("proven");
    expect(r.objectives[0].bindings[0]).toMatchObject({ kind: "route", ref: "targeted-test", status: "proven" });
    expect(r.objectives[0].bindings[0].detail).toMatch(/diffHash-bound/);
  });

  it("route: exit non-zero → failed", () => {
    const r = buildProofRecord(
      inputs({
        objectives: [obj("cycle21#ec1", [{ kind: "route", routeId: "targeted-test" }])],
        gateResults: { "targeted-test": { exitCode: 1 } },
        evidenceDiffHash: HEAD_DIFF,
      }),
      AT,
    );
    expect(r.objectives[0].status).toBe("failed");
  });

  it("route: no evidence → pending", () => {
    const r = buildProofRecord(
      inputs({ objectives: [obj("cycle21#ec1", [{ kind: "route", routeId: "targeted-test" }])] }),
      AT,
    );
    expect(r.objectives[0].status).toBe("pending");
    expect(r.objectives[0].bindings[0].detail).toMatch(/no route evidence/);
  });

  it("route: exit 0 but stale diffHash → pending (not proven)", () => {
    const r = buildProofRecord(
      inputs({
        objectives: [obj("cycle21#ec1", [{ kind: "route", routeId: "targeted-test" }])],
        gateResults: { "targeted-test": { exitCode: 0 } },
        evidenceDiffHash: "stale".padEnd(64, "0"),
      }),
      AT,
    );
    expect(r.objectives[0].status).toBe("pending");
    expect(r.objectives[0].bindings[0].detail).toMatch(/not bound to HEAD/);
  });

  it("route: exit 0 but SHA-only (no evidenceDiffHash) → pending", () => {
    const r = buildProofRecord(
      inputs({
        objectives: [obj("cycle21#ec1", [{ kind: "route", routeId: "targeted-test" }])],
        gateResults: { "targeted-test": { exitCode: 0 } },
      }),
      AT,
    );
    expect(r.objectives[0].status).toBe("pending");
  });

  it("critic: APPROVED → proven", () => {
    const r = buildProofRecord(
      inputs({
        objectives: [obj("cycle21#ec1", [{ kind: "critic", criticId: "codex" }])],
        criticResults: { codex: { status: "complete", verdict: "APPROVED" } },
      }),
      AT,
    );
    expect(r.objectives[0].status).toBe("proven");
    expect(r.objectives[0].bindings[0].detail).toMatch(/APPROVED/);
  });

  it("critic: CHANGES_REQUESTED → failed", () => {
    const r = buildProofRecord(
      inputs({
        objectives: [obj("cycle21#ec1", [{ kind: "critic", criticId: "codex" }])],
        criticResults: { codex: { status: "complete", verdict: "CHANGES_REQUESTED" } },
      }),
      AT,
    );
    expect(r.objectives[0].status).toBe("failed");
  });

  it("critic: no verdict yet (fleet has not run) → pending (the crux)", () => {
    const r = buildProofRecord(
      inputs({ objectives: [obj("cycle21#ec1", [{ kind: "critic", criticId: "codex" }])] }),
      AT,
    );
    expect(r.objectives[0].status).toBe("pending");
    expect(r.objectives[0].bindings[0].detail).toMatch(/awaiting critic/i);
  });

  it("test binding resolves via the same gate evidence keyed by ref", () => {
    const r = buildProofRecord(
      inputs({
        objectives: [obj("cycle21#ec1", [{ kind: "test", ref: "unit-suite" }])],
        gateResults: { "unit-suite": { exitCode: 0 } },
        evidenceDiffHash: HEAD_DIFF,
      }),
      AT,
    );
    expect(r.objectives[0].bindings[0]).toMatchObject({ kind: "test", ref: "unit-suite", status: "proven" });
  });
});

describe("buildProofRecord — rollup, summary, record", () => {
  it("objective status is worst-of its bindings (proven + pending → pending)", () => {
    const r = buildProofRecord(
      inputs({
        objectives: [
          obj("cycle21#ec1", [
            { kind: "route", routeId: "targeted-test" },
            { kind: "critic", criticId: "codex" },
          ]),
        ],
        gateResults: { "targeted-test": { exitCode: 0 } },
        evidenceDiffHash: HEAD_DIFF,
        // codex absent → pending
      }),
      AT,
    );
    expect(r.objectives[0].status).toBe("pending");
  });

  it("failed dominates pending in worst-of", () => {
    const r = buildProofRecord(
      inputs({
        objectives: [
          obj("cycle21#ec1", [
            { kind: "route", routeId: "r" },
            { kind: "critic", criticId: "codex" },
          ]),
        ],
        gateResults: { r: { exitCode: 1 } },
      }),
      AT,
    );
    expect(r.objectives[0].status).toBe("failed");
  });

  it("empty attestedBy → pending (declared but unbound)", () => {
    const r = buildProofRecord(inputs({ objectives: [obj("cycle21#ec1", [])] }), AT);
    expect(r.objectives[0].status).toBe("pending");
    expect(r.objectives[0].bindings).toHaveLength(0);
  });

  it("computes summary counts and stamps record fields", () => {
    const r = buildProofRecord(
      inputs({
        objectives: [
          obj("cycle21#ec1", [{ kind: "route", routeId: "r" }]),
          obj("cycle21#ec2", [{ kind: "critic", criticId: "codex" }]),
        ],
        gateResults: { r: { exitCode: 0 } },
        evidenceDiffHash: HEAD_DIFF,
      }),
      AT,
    );
    expect(r.summary).toEqual({ proven: 1, pending: 1, failed: 0, total: 2 });
    expect(r.commit).toBe("abc123def456");
    expect(r.diffHash).toBe(HEAD_DIFF);
    expect(r.provenance).toBe("consumer-attested");
    expect(r.generatedAt).toBe(AT);
    expect(r.schemaVersion).toBe(1);
  });

  it("attaches uploadId pointers when present", () => {
    const r = buildProofRecord(
      inputs({
        objectives: [obj("cycle21#ec1", [{ kind: "route", routeId: "r" }])],
        gateResults: { r: { exitCode: 0 } },
        evidenceDiffHash: HEAD_DIFF,
        uploadIds: { r: "up_42" },
      }),
      AT,
    );
    expect(r.objectives[0].bindings[0].uploadId).toBe("up_42");
  });
});

// --- collectProofInputs (reads objectives.yaml + gate evidence from disk) ----

async function setupRepo(objectivesYaml: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "df-prove-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir], { cwd: process.cwd() });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# r\n");
  const cfg = JSON.parse(readFileSync(fixturePath("config.json"), "utf8"));
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(cfg));
  if (objectivesYaml !== null) {
    mkdirSync(join(dir, ".darkfactory"), { recursive: true });
    writeFileSync(join(dir, ".darkfactory/objectives.yaml"), objectivesYaml);
  }
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const sha = await resolveCommit("HEAD", dir);
  return { dir, loaded, sha };
}

const OBJECTIVES_YAML = `schemaVersion: 1
objectives:
  - id: cycle21#ec1
    source: { kind: cycle, ref: "21" }
    text: "A route-backed objective."
    attestedBy:
      - { kind: route, routeId: targeted-test }
    enforced: false
`;

describe("collectProofInputs", () => {
  it("returns null when no objectives manifest is present", async () => {
    const { dir, sha } = await setupRepo(null);
    expect(await collectProofInputs(dir, sha)).toBeNull();
  });

  it("resolves the manifest from the repo root even when invoked from a subdirectory", async () => {
    const { dir, sha } = await setupRepo(OBJECTIVES_YAML);
    const sub = join(dir, "packages", "deep");
    mkdirSync(sub, { recursive: true });
    const collected = await collectProofInputs(sub, sha);
    expect(collected).not.toBeNull();
    expect(collected!.inputs.objectives).toHaveLength(1);
  });

  it("reads objectives + gate evidence; critic with no artifact stays pending", async () => {
    const { dir, loaded, sha } = await setupRepo(OBJECTIVES_YAML);
    const gp = perShaQualityGatePath(await resolveArtifactRoot(loaded), loaded.config.git.artifactDir, sha);
    const evidence: QualityGateEvidence = {
      version: 2,
      commit: sha,
      generatedAt: AT,
      results: [],
      gateResults: {
        "targeted-test": { command: "t", exitCode: 0, durationMs: 1, logExcerpt: "ok", startedAt: AT, finishedAt: AT, routeId: "targeted-test" },
      },
      // df verify stamps the gated diffHash; mirror that the evidence is bound.
    };
    mkdirSync(dirname(gp), { recursive: true });
    writeFileSync(gp, `${JSON.stringify(evidence, null, 2)}\n`);

    const collected = await collectProofInputs(dir, sha);
    expect(collected).not.toBeNull();
    expect(collected!.inputs.objectives).toHaveLength(1);
    expect(collected!.inputs.gateResults["targeted-test"].exitCode).toBe(0);
    // No review artifact written → criticResults empty.
    expect(Object.keys(collected!.inputs.criticResults)).toHaveLength(0);
    expect(collected!.resolvedSha).toBe(sha);
  });
});
