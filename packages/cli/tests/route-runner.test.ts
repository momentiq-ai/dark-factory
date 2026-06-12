// Cycle 21 — Evidence-Gated Validation Routes (momentiq-ai/dark-factory#185).
//
// The route-runner generalizes the `.husky/pre-commit` Docker build-evidence
// shim beyond Docker: given the armed routes + changed paths, it runs each
// route's producer command and writes per-SHA `QualityGateEvidence` keyed by
// `routeId` under `gateResults`, honoring the SAME 0/1/2 exit-code contract
// as the #141 shim:
//   - exit 0 → green   (route passed)
//   - exit 1 → block   (route failed; the gate blocks)
//   - exit 2 → soft-skip→requiresHumanJudgment (tool unreachable in this
//             environment; recorded, not silently dropped)
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentReviewConfig, type LoadedConfig } from "../src/policy/config.js";
import { perShaQualityGatePath, readQualityGateEvidence } from "../src/evidence/index.js";
import { runRoutes } from "../src/evidence/route-runner.js";
import { resolveCommit } from "../src/git.js";
import { resolveArtifactRoot } from "../src/paths.js";
import { fixturePath } from "./_helpers.js";
import type { VerificationRoute } from "@momentiq/dark-factory-schemas";

interface TempRepo {
  dir: string;
  loaded: LoadedConfig;
  sha: string;
}

async function setupRepo(routes: VerificationRoute[]): Promise<TempRepo> {
  const dir = mkdtempSync(join(tmpdir(), "agent-review-runner-"));
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

function route(id: string, command: string, trigger: string[]): VerificationRoute {
  return {
    id,
    trigger,
    command,
    evidencePath: "agent-reviews/quality-gates/${sha}.json",
    category: "test",
    evidenceKind: "test",
  };
}

describe("runRoutes — generalized evidence producer (#185)", () => {
  it("runs an armed route and writes gateResults[routeId] with exitCode 0 (green)", async () => {
    const repo = await setupRepo([route("ok", "true", ["**/*"])]);
    const summary = await runRoutes({
      loaded: repo.loaded,
      commit: repo.sha,
      changedPaths: ["src/x.ts"],
    });
    expect(summary.ran.map((r) => r.routeId)).toContain("ok");

    const { evidence } = await readQualityGateEvidence(repo.loaded, repo.sha);
    expect(evidence?.gateResults?.["ok"]?.exitCode).toBe(0);
    expect(evidence?.gateResults?.["ok"]?.routeId).toBe("ok");
  });

  it("does NOT arm a route whose trigger no path matches", async () => {
    const repo = await setupRepo([route("idle", "true", ["never/matches/**"])]);
    const summary = await runRoutes({
      loaded: repo.loaded,
      commit: repo.sha,
      changedPaths: ["src/x.ts"],
    });
    expect(summary.ran).toHaveLength(0);
    const { evidence } = await readQualityGateEvidence(repo.loaded, repo.sha);
    expect(evidence?.gateResults?.["idle"]).toBeUndefined();
  });

  it("records exit 1 as a blocking failure (green=false)", async () => {
    const repo = await setupRepo([route("fail", "false", ["**/*"])]);
    const summary = await runRoutes({
      loaded: repo.loaded,
      commit: repo.sha,
      changedPaths: ["src/x.ts"],
    });
    const ran = summary.ran.find((r) => r.routeId === "fail");
    expect(ran?.exitCode).toBe(1);
    expect(ran?.outcome).toBe("block");
    const { evidence } = await readQualityGateEvidence(repo.loaded, repo.sha);
    expect(evidence?.gateResults?.["fail"]?.exitCode).toBe(1);
  });

  it("treats exit 2 as a soft-skip → requiresHumanJudgment (recorded, NON-zero)", async () => {
    // `sh -c 'exit 2'` — the #141 shim's soft-skip signal (tool unreachable).
    const repo = await setupRepo([
      route("softskip", "sh -c 'exit 2'", ["**/*"]),
    ]);
    const summary = await runRoutes({
      loaded: repo.loaded,
      commit: repo.sha,
      changedPaths: ["src/x.ts"],
    });
    const ran = summary.ran.find((r) => r.routeId === "softskip");
    expect(ran?.exitCode).toBe(2);
    expect(ran?.outcome).toBe("soft-skip");
    expect(ran?.requiresHumanJudgment).toBe(true);
    // The exit code is preserved as 2 (NON-zero) so the gate's
    // `exitCode === 0` pass-condition does NOT treat it as green — a
    // soft-skip is not a pass.
    const { evidence } = await readQualityGateEvidence(repo.loaded, repo.sha);
    expect(evidence?.gateResults?.["softskip"]?.exitCode).toBe(2);
  });

  it("runs MULTIPLE armed routes, accumulating gateResults for each", async () => {
    const repo = await setupRepo([
      route("a", "true", ["a/**"]),
      route("b", "true", ["b/**"]),
      route("c", "true", ["c/**"]),
    ]);
    const summary = await runRoutes({
      loaded: repo.loaded,
      commit: repo.sha,
      changedPaths: ["a/x", "b/y"], // arms a + b, not c
    });
    expect(summary.ran.map((r) => r.routeId).sort()).toEqual(["a", "b"]);
    const { evidence } = await readQualityGateEvidence(repo.loaded, repo.sha);
    expect(evidence?.gateResults?.["a"]?.exitCode).toBe(0);
    expect(evidence?.gateResults?.["b"]?.exitCode).toBe(0);
    expect(evidence?.gateResults?.["c"]).toBeUndefined();
  });

  it("stamps the diffHash on the evidence when supplied (#186 producer half)", async () => {
    const repo = await setupRepo([route("ok", "true", ["**/*"])]);
    await runRoutes({
      loaded: repo.loaded,
      commit: repo.sha,
      changedPaths: ["src/x.ts"],
      diffHash: "sha256:abc123",
    });
    const { evidence } = await readQualityGateEvidence(repo.loaded, repo.sha);
    expect(evidence?.diffHash).toBe("sha256:abc123");
  });

  it("skips a suppression-only route (command:null) — nothing to produce", async () => {
    const docs: VerificationRoute = {
      id: "docs-only",
      trigger: ["**/*.md"],
      command: null,
      evidencePath: null,
      category: "docs",
      exclusive: true,
      evidenceKind: "none",
    };
    const repo = await setupRepo([docs, route("ok", "true", ["**/*"])]);
    const summary = await runRoutes({
      loaded: repo.loaded,
      commit: repo.sha,
      changedPaths: ["README.md"],
    });
    // docs-only is exclusive + every changed path matches → it suppresses
    // the command route, and itself has nothing to run.
    expect(summary.ran.find((r) => r.routeId === "docs-only")).toBeUndefined();
    expect(summary.ran.find((r) => r.routeId === "ok")).toBeUndefined();
    expect(summary.suppressedBy).toBe("docs-only");
  });
});

// Cycle 22 (momentiq-ai/dark-factory#192) — the `df verify --route <id>`
// filter + the recursion guard that graduates the producer to a first-class
// subcommand. `routeFilter` narrows the ARMED set (not the raw table), so
// `df verify --route X` stays consistent with the no-arg run + the gate.
describe("runRoutes — --route filter + recursion guard (#192)", () => {
  it("routeFilter narrows the armed set to the named route", async () => {
    const repo = await setupRepo([
      route("a", "true", ["a/**"]),
      route("b", "true", ["b/**"]),
    ]);
    const summary = await runRoutes({
      loaded: repo.loaded,
      commit: repo.sha,
      changedPaths: ["a/x", "b/y"], // arms a + b
      routeFilter: "a",
    });
    expect(summary.ran.map((r) => r.routeId)).toEqual(["a"]);
    const { evidence } = await readQualityGateEvidence(repo.loaded, repo.sha);
    expect(evidence?.gateResults?.["a"]?.exitCode).toBe(0);
    expect(evidence?.gateResults?.["b"]).toBeUndefined();
  });

  it("routeFilter for a route the diff did NOT trigger runs nothing (filter-the-armed-set)", async () => {
    const repo = await setupRepo([
      route("a", "true", ["a/**"]),
      route("b", "true", ["b/**"]),
    ]);
    const summary = await runRoutes({
      loaded: repo.loaded,
      commit: repo.sha,
      changedPaths: ["a/x"], // arms a only; b not triggered
      routeFilter: "b",
    });
    expect(summary.ran).toHaveLength(0);
  });

  it("THROWS on an active route whose command is an un-overridden `df verify` placeholder", async () => {
    const repo = await setupRepo([
      route("playwright", "df verify --route playwright", ["**/*"]),
    ]);
    await expect(
      runRoutes({
        loaded: repo.loaded,
        commit: repo.sha,
        changedPaths: ["web/app.tsx"],
      }),
    ).rejects.toThrow(/placeholder command/i);
  });

  it("recursion guard also fires under a routeFilter targeting the placeholder route", async () => {
    const repo = await setupRepo([
      route("playwright", "df verify --route playwright", ["**/*"]),
      route("ok", "true", ["**/*"]),
    ]);
    await expect(
      runRoutes({
        loaded: repo.loaded,
        commit: repo.sha,
        changedPaths: ["web/app.tsx"],
        routeFilter: "playwright",
      }),
    ).rejects.toThrow(/playwright/);
  });

  it("recursion guard does NOT fire for an un-triggered placeholder route (nothing would run)", async () => {
    const repo = await setupRepo([
      route("playwright", "df verify --route playwright", ["web/**"]),
      route("ok", "true", ["**/*"]),
    ]);
    // change does not touch web/** → playwright not armed → guard must not trip
    const summary = await runRoutes({
      loaded: repo.loaded,
      commit: repo.sha,
      changedPaths: ["src/x.ts"],
    });
    expect(summary.ran.map((r) => r.routeId)).toEqual(["ok"]);
  });
});
