// Cycle 22 (#194) — `df gates`' route evidence must be diffHash-bound so the
// push gate (`enforceVerificationRoutes`) accepts it. df gates delegates its
// route loop to the same `runRoutes` orchestrator as `df verify`, which stamps
// the gated diffHash. Without the stamp, df gates would write SHA-only
// evidence that #194's tightened gate now REJECTS — a silent trap this test
// pins shut. Spawns the built binary (so the test exercises the real
// `main()` → cmdGates → runRoutes wiring with `process.cwd()` = the temp repo).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadAgentReviewConfig } from "../src/policy/config.js";
import { enforceVerificationRoutes } from "../src/policy/gate.js";
import { collectChangedPaths, readQualityGateEvidence } from "../src/evidence/index.js";
import {
  changedFiles,
  commitDiff,
  commitParent,
  diffHash,
  resolveCommit,
} from "../src/git.js";
import { fixturePath } from "./_helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "dist", "cli.js");

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runDfCli(args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code) =>
      resolvePromise({ exitCode: code === null ? -1 : code, stdout, stderr }),
    );
  });
}

// A temp repo whose HEAD commit changes infra/terraform/main.tf, arming a
// single terraform route whose producer command is `routeCommand`.
function setupRepo(routeCommand: string): string {
  const dir = mkdtempSync(join(tmpdir(), "df-gates-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir], { cwd: process.cwd() });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

  const cfg = JSON.parse(readFileSync(fixturePath("config.json"), "utf8"));
  cfg.validation.verificationRoutes = [
    {
      id: "terraform",
      trigger: ["infra/terraform/**"],
      command: routeCommand,
      evidencePath: "agent-reviews/quality-gates/${sha}.json",
      category: "infra",
      evidenceKind: "terraform",
    },
  ];
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(cfg));
  writeFileSync(join(dir, "README.md"), "# r\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  mkdirSync(join(dir, "infra/terraform"), { recursive: true });
  writeFileSync(join(dir, "infra/terraform/main.tf"), "resource{}\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "feat"], { cwd: dir });
  return dir;
}

describe("df gates — route evidence is diffHash-bound + gate-compatible (#194)", () => {
  it("stamps the gated diffHash on route evidence and the gate ACCEPTS it", async () => {
    const dir = setupRepo("true");
    const r = await runDfCli(["gates"], dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/PASS route\[terraform\]/);

    const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
    const sha = await resolveCommit("HEAD", dir);
    const parent = await commitParent(sha, dir);
    const gated = diffHash(await commitDiff(parent, sha, dir));

    // #194 producer half — df gates stamped the gated diffHash.
    const { evidence } = await readQualityGateEvidence(loaded, sha);
    expect(evidence?.diffHash).toBe(gated);

    // #194 enforce half — the gate accepts df gates' (now-bound) evidence.
    const files = await changedFiles(parent, sha, dir, { readContent: false });
    const evalResult = await enforceVerificationRoutes({
      loaded,
      sha,
      changedPaths: collectChangedPaths(files),
      diffHash: gated,
    });
    expect(evalResult.perRoute.find((p) => p.routeId === "terraform")?.status).toBe("ok");
  });

  it("fails fast (exit 1) on an un-overridden `df verify` placeholder route", async () => {
    const dir = setupRepo("df verify --route terraform");
    const r = await runDfCli(["gates"], dir);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/placeholder command/i);
  });
});
