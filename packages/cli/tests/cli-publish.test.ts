import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cmdPublish, type PublishDeps } from "../src/commands/publish.js";
import { loadAgentReviewConfig, type LoadedConfig } from "../src/policy/config.js";
import { resolveCommit } from "../src/git.js";
import { perShaQualityGatePath } from "../src/evidence/per-sha.js";
import { resolveArtifactRoot } from "../src/paths.js";
import { sha256Hex } from "../src/evidence/cerebe.js";
import type { EvidenceUploader } from "../src/evidence/publish.js";
import { fixturePath } from "./_helpers.js";
import type { PublishedEvidence, QualityGateEvidence } from "@momentiq/dark-factory-schemas";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
    out,
    err,
  };
}

function mockUploader(): EvidenceUploader {
  let n = 0;
  return {
    async uploadFile(input) {
      n += 1;
      return {
        uploadId: `up_${n}`,
        sha256: sha256Hex(input.bytes),
        sizeBytes: input.bytes.byteLength,
        contentType: input.contentType,
      };
    },
  };
}

const CONFIGURED: PublishDeps = {
  resolveCerebe: () => ({ baseUrl: "https://cerebe.example", apiKey: "k" }),
  makeUploader: () => mockUploader(),
};

async function setupRepo(): Promise<{ dir: string; loaded: LoadedConfig; sha: string }> {
  const dir = mkdtempSync(join(tmpdir(), "df-publish-cmd-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir], { cwd: process.cwd() });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# r\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const cfg = JSON.parse(readFileSync(fixturePath("config.json"), "utf8"));
  cfg.validation.verificationRoutes = [
    {
      id: "playwright",
      trigger: ["web/**"],
      command: "p",
      evidencePath: "agent-reviews/quality-gates/${sha}.json",
      category: "ui",
      evidenceKind: "playwright",
    },
  ];
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(cfg));

  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const sha = await resolveCommit("HEAD", dir);
  return { dir, loaded, sha };
}

async function writeEvidence(
  dir: string,
  loaded: LoadedConfig,
  sha: string,
  withUi: boolean,
): Promise<void> {
  const root = await resolveArtifactRoot(loaded);
  const gp = perShaQualityGatePath(root, loaded.config.git.artifactDir, sha);
  const evidence: QualityGateEvidence = {
    version: 2,
    commit: sha,
    generatedAt: "2026-06-20T00:00:00.000Z",
    results: [],
    gateResults: {
      playwright: {
        command: "p",
        exitCode: 0,
        durationMs: 1,
        logExcerpt: "ok",
        startedAt: "2026-06-20T00:00:00.000Z",
        finishedAt: "2026-06-20T00:00:01.000Z",
        routeId: "playwright",
      },
    },
    diffHash: "abcd".repeat(16),
  };
  mkdirSync(dirname(gp), { recursive: true });
  writeFileSync(gp, `${JSON.stringify(evidence, null, 2)}\n`);
  if (withUi) {
    const uiDir = join(dir, "agent-reviews/quality-gates/ui", sha, "home");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(join(uiDir, "before.png"), "PNGDATA");
  }
}

describe("cmdPublish", () => {
  it("--help prints usage and exits 0", async () => {
    const c = capture();
    const code = await cmdPublish(["--help"], c.io);
    expect(code).toBe(0);
    expect(c.out.join("")).toContain("df publish");
  });

  it("rejects an unknown flag with exit 2", async () => {
    const c = capture();
    const code = await cmdPublish(["--bogus"], c.io);
    expect(code).toBe(2);
    expect(c.err.join("")).toMatch(/unknown flag/);
  });

  it("exits 0 with a message when there is no evidence to publish", async () => {
    const { dir, sha } = await setupRepo();
    const c = capture();
    const code = await cmdPublish(["--commit", sha, "--cwd", dir], c.io, CONFIGURED);
    expect(code).toBe(0);
    expect(c.out.join("")).toMatch(/nothing to publish/);
  });

  it("uploads evidence and writes a complete manifest to --out", async () => {
    const { dir, loaded, sha } = await setupRepo();
    await writeEvidence(dir, loaded, sha, true);
    const outPath = join(dir, "evidence-pointers.json");
    const c = capture();
    const code = await cmdPublish(
      ["--commit", sha, "--cwd", dir, "--out", outPath],
      c.io,
      CONFIGURED,
    );
    expect(code).toBe(0);
    const manifest = JSON.parse(readFileSync(outPath, "utf8")) as PublishedEvidence;
    expect(manifest.status).toBe("complete");
    expect(manifest.provenance).toBe("consumer-attested");
    expect(manifest.commit).toBe(sha);
    expect(manifest.diffHash).toBe("abcd".repeat(16));
    expect(manifest.gateEvidence?.uploadId).toBeTruthy();
    expect(manifest.routes["playwright"].artifacts).toHaveLength(1);
    expect(c.err.join("")).toMatch(/status=complete/);
  });

  it("degrades-and-passes (exit 0) when Cerebe is unconfigured", async () => {
    const { dir, loaded, sha } = await setupRepo();
    await writeEvidence(dir, loaded, sha, true);
    const c = capture();
    const code = await cmdPublish(["--commit", sha, "--cwd", dir], c.io, {
      resolveCerebe: () => null,
    });
    expect(code).toBe(0);
    const manifest = JSON.parse(c.out.join("")) as PublishedEvidence;
    expect(manifest.status).toBe("degraded");
    expect(manifest.degradedReason).toMatch(/CEREBE_API_URL/);
    expect(c.err.join("")).toMatch(/status=degraded/);
  });
});
