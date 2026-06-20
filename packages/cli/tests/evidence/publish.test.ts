import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadAgentReviewConfig } from "../../src/policy/config.js";
import { resolveCommit } from "../../src/git.js";
import { perShaQualityGatePath } from "../../src/evidence/per-sha.js";
import { resolveArtifactRoot } from "../../src/paths.js";
import { sha256Hex, type CerebeUploadInput } from "../../src/evidence/cerebe.js";
import {
  buildPublishManifest,
  collectPublishArtifacts,
  contentTypeForPath,
  type ArtifactSource,
  type EvidenceUploader,
} from "../../src/evidence/publish.js";
import { fixturePath } from "../_helpers.js";
import type { QualityGateEvidence, VerificationRoute } from "@momentiq/dark-factory-schemas";

function src(path: string, contentType: string, text: string): ArtifactSource {
  return { path, contentType, bytes: new TextEncoder().encode(text) };
}

// A mock uploader that mints sequential ids and echoes a locally-computed hash.
function mockUploader(): EvidenceUploader & { calls: CerebeUploadInput[] } {
  const calls: CerebeUploadInput[] = [];
  let n = 0;
  return {
    calls,
    async uploadFile(input) {
      calls.push(input);
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

const BASE = {
  commit: "abc123def456",
  diffHash: "feed".repeat(16),
  sessionId: "df-publish:abc123",
  userId: "dark-factory",
};

describe("buildPublishManifest", () => {
  it("uploads gate + route artifacts and returns a complete manifest", async () => {
    const uploader = mockUploader();
    const m = await buildPublishManifest({
      ...BASE,
      uploader,
      gate: src(".git/agent-reviews/quality-gates/abc123def456.json", "application/json", "{}"),
      routes: [
        {
          routeId: "playwright",
          exitCode: 0,
          sources: [src("agent-reviews/quality-gates/ui/abc123def456/home/before.png", "image/png", "PNG")],
        },
        { routeId: "targeted-test", exitCode: 0, sources: [] },
      ],
    });
    expect(m.status).toBe("complete");
    expect(m.provenance).toBe("consumer-attested");
    expect(m.diffHash).toBe(BASE.diffHash);
    expect(m.gateEvidence?.uploadId).toBe("up_1");
    expect(m.gateEvidence?.sha256).toBe(sha256Hex(new TextEncoder().encode("{}")));
    expect(m.routes["playwright"].artifacts).toHaveLength(1);
    expect(m.routes["playwright"].artifacts[0].contentType).toBe("image/png");
    expect(m.routes["targeted-test"].artifacts).toHaveLength(0);
    expect(m.routes["targeted-test"].exitCode).toBe(0);
    // gate + one png
    expect(uploader.calls).toHaveLength(2);
    expect(uploader.calls[0].sessionId).toBe("df-publish:abc123");
  });

  it("degrades (no uploads) when the uploader is null — air-gap fail-soft", async () => {
    const m = await buildPublishManifest({
      ...BASE,
      uploader: null,
      gate: src("g.json", "application/json", "{}"),
      routes: [{ routeId: "playwright", exitCode: 0, sources: [src("a.png", "image/png", "x")] }],
    });
    expect(m.status).toBe("degraded");
    expect(m.degradedReason).toMatch(/CEREBE_API_URL/);
    expect(m.gateEvidence).toBeUndefined();
    // route exit codes are still recorded, but with no uploaded artifacts
    expect(m.routes["playwright"].exitCode).toBe(0);
    expect(m.routes["playwright"].artifacts).toHaveLength(0);
    // diffHash is still surfaced
    expect(m.diffHash).toBe(BASE.diffHash);
  });

  it("degrades when an upload throws, keeping the successful uploads", async () => {
    const failing: EvidenceUploader = {
      async uploadFile(input) {
        if (input.contentType === "image/png") throw new Error("503 upstream");
        return { uploadId: "up_g", sha256: sha256Hex(input.bytes), sizeBytes: input.bytes.byteLength, contentType: input.contentType };
      },
    };
    const m = await buildPublishManifest({
      ...BASE,
      uploader: failing,
      gate: src("g.json", "application/json", "{}"),
      routes: [{ routeId: "playwright", exitCode: 0, sources: [src("a.png", "image/png", "x")] }],
    });
    expect(m.status).toBe("degraded");
    expect(m.degradedReason).toMatch(/503 upstream/);
    // the gate JSON still uploaded — partial evidence is preserved, not dropped
    expect(m.gateEvidence?.uploadId).toBe("up_g");
    expect(m.routes["playwright"].artifacts).toHaveLength(0);
  });
});

describe("contentTypeForPath", () => {
  it("maps known extensions", () => {
    expect(contentTypeForPath("/x/a.png")).toBe("image/png");
    expect(contentTypeForPath("/x/a.json")).toBe("application/json");
    expect(contentTypeForPath("/x/a.html")).toBe("text/html");
    expect(contentTypeForPath("/x/a.weird")).toBe("application/octet-stream");
  });
});

// --- collectPublishArtifacts (reads the gate JSON + UI tree from disk) -------

function uiRoute(): VerificationRoute {
  return {
    id: "playwright",
    trigger: ["web/**"],
    command: "playwright-producer",
    evidencePath: "agent-reviews/quality-gates/${sha}.json",
    category: "ui",
    evidenceKind: "playwright",
  };
}
function testRoute(): VerificationRoute {
  return {
    id: "targeted-test",
    trigger: ["services/*/src/**"],
    command: "npm test",
    evidencePath: "agent-reviews/quality-gates/${sha}.json",
    category: "test",
    evidenceKind: "test",
  };
}

async function setupRepo(routes: VerificationRoute[]) {
  const dir = mkdtempSync(join(tmpdir(), "df-publish-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir], { cwd: process.cwd() });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# r\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const cfg = JSON.parse(readFileSync(fixturePath("config.json"), "utf8"));
  cfg.validation.verificationRoutes = routes;
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(cfg));

  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const sha = await resolveCommit("HEAD", dir);
  return { dir, loaded, sha };
}

function writeGateEvidence(
  dir: string,
  loaded: Awaited<ReturnType<typeof loadAgentReviewConfig>>,
  sha: string,
  evidence: QualityGateEvidence,
): Promise<void> {
  return resolveArtifactRoot(loaded).then((root) => {
    const p = perShaQualityGatePath(root, loaded.config.git.artifactDir, sha);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(evidence, null, 2)}\n`);
  });
}

describe("collectPublishArtifacts", () => {
  it("returns null when no evidence exists for the commit", async () => {
    const { dir, loaded, sha } = await setupRepo([testRoute()]);
    const got = await collectPublishArtifacts(loaded, sha, dir);
    expect(got).toBeNull();
  });

  it("reads the gate JSON + discovers UI artifacts for the playwright route", async () => {
    const { dir, loaded, sha } = await setupRepo([uiRoute(), testRoute()]);
    await writeGateEvidence(dir, loaded, sha, {
      version: 2,
      commit: sha,
      generatedAt: "2026-06-20T00:00:00.000Z",
      results: [],
      gateResults: {
        playwright: { command: "playwright-producer", exitCode: 0, durationMs: 1, logExcerpt: "ok", startedAt: "2026-06-20T00:00:00.000Z", finishedAt: "2026-06-20T00:00:01.000Z", routeId: "playwright" },
        "targeted-test": { command: "npm test", exitCode: 0, durationMs: 1, logExcerpt: "ok", startedAt: "2026-06-20T00:00:00.000Z", finishedAt: "2026-06-20T00:00:01.000Z", routeId: "targeted-test" },
      },
      diffHash: "abcd".repeat(16),
    });
    // UI artifacts written to the working tree by the playwright producer
    const uiDir = join(dir, "agent-reviews/quality-gates/ui", sha, "home");
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(join(uiDir, "before.png"), "PNGDATA");
    writeFileSync(join(uiDir, "after.png"), "PNGDATA2");

    const got = await collectPublishArtifacts(loaded, sha, dir);
    expect(got).not.toBeNull();
    expect(got!.diffHash).toBe("abcd".repeat(16));
    expect(got!.gate?.contentType).toBe("application/json");
    expect(got!.gate?.path).toContain("quality-gates");

    const pw = got!.routes.find((r) => r.routeId === "playwright")!;
    expect(pw.sources.map((s) => s.path).sort()).toEqual([
      `agent-reviews/quality-gates/ui/${sha}/home/after.png`,
      `agent-reviews/quality-gates/ui/${sha}/home/before.png`,
    ]);
    expect(pw.sources.every((s) => s.contentType === "image/png")).toBe(true);

    const tt = got!.routes.find((r) => r.routeId === "targeted-test")!;
    expect(tt.sources).toHaveLength(0);
  });
});
