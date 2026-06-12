// Cycle 21 — Evidence-Gated Validation Routes.
//
// Integration coverage for `enforceVerificationRoutes`:
//   - #184 — it enforces the PLANNED set (table floor ∪ additive planner),
//     so a planner addition is gated even when the table did not arm it.
//   - #186 — it rejects per-SHA evidence whose `diffHash` does not match
//     the gated diff (stale-evidence binding).
//   - #194 — once the gate runs content-binding (a `diffHash` is supplied),
//     evidence that carries NO `diffHash` is ALSO rejected (the absent-field
//     gaming hole is closed; Cycle 21 EC7 teeth). SHA-only binding survives
//     only when the GATE supplies no `diffHash` (the caller opts out).
//
// These tests do NOT alter `enforceVerificationRoutes`' existing pass/fail
// behavior for existing configs (no planner, no gate diffHash) — the existing
// gate.test.ts suite still covers that path unchanged.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadAgentReviewConfig, type LoadedConfig } from "../src/policy/config.js";
import { perShaQualityGatePath } from "../src/evidence/index.js";
import { enforceVerificationRoutes } from "../src/policy/gate.js";
import { resolveCommit } from "../src/git.js";
import { resolveArtifactRoot } from "../src/paths.js";
import { fixturePath } from "./_helpers.js";
import type { VerificationRoute } from "@momentiq/dark-factory-schemas";

interface TempRepo {
  dir: string;
  loaded: LoadedConfig;
  sha: string;
}

// Build a temp repo with a config whose verificationRoutes are the supplied
// set. A single commit at HEAD; the SHA is what evidence binds to.
async function setupRepo(routes: VerificationRoute[]): Promise<TempRepo> {
  const dir = mkdtempSync(join(tmpdir(), "agent-review-routes-"));
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

async function writeEvidence(
  repo: TempRepo,
  opts: {
    gateResults: Record<string, { exitCode: number }>;
    diffHash?: string;
  },
): Promise<void> {
  const root = await resolveArtifactRoot(repo.loaded);
  const path = perShaQualityGatePath(root, repo.loaded.config.git.artifactDir, repo.sha);
  mkdirSync(dirname(path), { recursive: true });
  const gateResults: Record<string, unknown> = {};
  for (const [id, r] of Object.entries(opts.gateResults)) {
    gateResults[id] = {
      command: `df verify --route ${id}`,
      exitCode: r.exitCode,
      durationMs: 1,
      logExcerpt: r.exitCode === 0 ? "ok" : "boom",
      startedAt: "2026-06-08T00:00:00Z",
      finishedAt: "2026-06-08T00:00:00Z",
      routeId: id,
    };
  }
  const evidence = {
    version: 2,
    commit: repo.sha,
    generatedAt: "2026-06-08T00:00:00Z",
    results: [],
    gateResults,
    ...(opts.diffHash !== undefined ? { diffHash: opts.diffHash } : {}),
  };
  writeFileSync(path, JSON.stringify(evidence));
}

const TF: VerificationRoute = {
  id: "terraform",
  trigger: ["infra/terraform/**"],
  command: "df verify --route terraform",
  evidencePath: "agent-reviews/quality-gates/${sha}.json",
  category: "infra",
  evidenceKind: "terraform",
};
const EXTRA: VerificationRoute = {
  id: "generated-artifact",
  // Triggers on NOTHING via the table — only the planner can arm it.
  trigger: ["never/matches/**"],
  command: "df verify --route generated-artifact",
  evidencePath: "agent-reviews/quality-gates/${sha}.json",
  category: "generated",
  evidenceKind: "test",
};

describe("enforceVerificationRoutes — additive planner (#184)", () => {
  it("enforces a planner-added route even though the table did not arm it", async () => {
    const repo = await setupRepo([TF]);
    // Table arms `terraform` (changed path matches). Evidence is present &
    // passing for terraform, but the planner adds `generated-artifact`,
    // whose evidence is MISSING → the planned route must block.
    await writeEvidence(repo, { gateResults: { terraform: { exitCode: 0 } } });
    const result = await enforceVerificationRoutes({
      loaded: repo.loaded,
      sha: repo.sha,
      changedPaths: ["infra/terraform/main.tf"],
      planner: () => [EXTRA],
    });
    const ids = result.active.map((r) => r.id).sort();
    expect(ids).toEqual(["generated-artifact", "terraform"]);
    const extra = result.perRoute.find((r) => r.routeId === "generated-artifact");
    expect(extra?.status).toBe("missing");
  });

  it("with no planner, enforces only the table floor (existing behavior)", async () => {
    const repo = await setupRepo([TF]);
    await writeEvidence(repo, { gateResults: { terraform: { exitCode: 0 } } });
    const result = await enforceVerificationRoutes({
      loaded: repo.loaded,
      sha: repo.sha,
      changedPaths: ["infra/terraform/main.tf"],
    });
    expect(result.active.map((r) => r.id)).toEqual(["terraform"]);
    expect(result.perRoute.find((r) => r.routeId === "terraform")?.status).toBe("ok");
  });
});

describe("enforceVerificationRoutes — diffHash content binding (#186)", () => {
  it("rejects evidence whose diffHash != the gated diff (treated as failed)", async () => {
    const repo = await setupRepo([TF]);
    await writeEvidence(repo, {
      gateResults: { terraform: { exitCode: 0 } },
      diffHash: "sha256:STALE",
    });
    const result = await enforceVerificationRoutes({
      loaded: repo.loaded,
      sha: repo.sha,
      changedPaths: ["infra/terraform/main.tf"],
      diffHash: "sha256:FRESH",
    });
    const tf = result.perRoute.find((r) => r.routeId === "terraform");
    expect(tf?.status).toBe("failed");
    expect(tf?.detail).toMatch(/diff/i);
  });

  it("accepts evidence whose diffHash matches the gated diff", async () => {
    const repo = await setupRepo([TF]);
    await writeEvidence(repo, {
      gateResults: { terraform: { exitCode: 0 } },
      diffHash: "sha256:FRESH",
    });
    const result = await enforceVerificationRoutes({
      loaded: repo.loaded,
      sha: repo.sha,
      changedPaths: ["infra/terraform/main.tf"],
      diffHash: "sha256:FRESH",
    });
    expect(result.perRoute.find((r) => r.routeId === "terraform")?.status).toBe("ok");
  });

  it("#194: SHA-only evidence (no diffHash) is now FAILED when a gate diffHash is supplied (content-binding teeth)", async () => {
    const repo = await setupRepo([TF]);
    // Evidence carries NO diffHash (the pre-#194 shape). #194 REVOKES the
    // prior permissive behavior: once the gate runs content-binding (a
    // diffHash is supplied — runner.ts always does), evidence that cannot
    // prove it was produced for THIS diff can no longer satisfy the route.
    // This closes the gaming hole where stripping the field bypassed the
    // same-SHA/different-diff binding; SHA-only producers must adopt the
    // diffHash-stamping producer (`df verify`).
    await writeEvidence(repo, { gateResults: { terraform: { exitCode: 0 } } });
    const result = await enforceVerificationRoutes({
      loaded: repo.loaded,
      sha: repo.sha,
      changedPaths: ["infra/terraform/main.tf"],
      diffHash: "sha256:FRESH",
    });
    const tf = result.perRoute.find((r) => r.routeId === "terraform");
    expect(tf?.status).toBe("failed");
    expect(tf?.detail).toMatch(/diff/i);
  });

  it("#194: missing-before-diffHash — a no-evidence route is `missing`, a route WITH evidence on a SHA-only file is diffHash-`failed`", async () => {
    const repo = await setupRepo([TF]);
    // SHA-only evidence file (no diffHash). The planner adds a SECOND route
    // (`generated-artifact`) whose evidence is absent. Under content-binding:
    //   - terraform HAS evidence but the file is unbound  → failed (the teeth)
    //   - generated-artifact has NO evidence              → missing wins, so
    //     the operator is told to RUN the route (precise diagnostic), not
    //     that its (absent) evidence is stale.
    await writeEvidence(repo, { gateResults: { terraform: { exitCode: 0 } } });
    const result = await enforceVerificationRoutes({
      loaded: repo.loaded,
      sha: repo.sha,
      changedPaths: ["infra/terraform/main.tf"],
      diffHash: "sha256:FRESH",
      planner: () => [EXTRA],
    });
    expect(result.perRoute.find((r) => r.routeId === "terraform")?.status).toBe("failed");
    expect(result.perRoute.find((r) => r.routeId === "generated-artifact")?.status).toBe(
      "missing",
    );
  });

  it("BACK-COMPAT: no gate diffHash supplied → diffHash on evidence is ignored (SHA-only binding)", async () => {
    const repo = await setupRepo([TF]);
    await writeEvidence(repo, {
      gateResults: { terraform: { exitCode: 0 } },
      diffHash: "sha256:WHATEVER",
    });
    const result = await enforceVerificationRoutes({
      loaded: repo.loaded,
      sha: repo.sha,
      changedPaths: ["infra/terraform/main.tf"],
      // no diffHash on the gate call
    });
    expect(result.perRoute.find((r) => r.routeId === "terraform")?.status).toBe("ok");
  });
});
