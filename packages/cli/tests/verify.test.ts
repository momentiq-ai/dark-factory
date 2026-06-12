// Cycle 22 (momentiq-ai/dark-factory#192 + #194) — `df verify`.
//
// `cmdVerify` is the first-class CLI graduation of the route-runner library:
// it arms the verification routes for a commit's diff, runs each route's
// producer, writes per-SHA `QualityGateEvidence` stamped with the gated
// `diffHash` (the producer half of #194), and maps the 0/1/2 route contract
// onto its exit code. These tests cover the exit-code mapping, the `--route`
// filter, the recursion guard, and — the load-bearing acceptance — the
// produce→enforce round trip: evidence `df verify` writes SATISFIES
// `enforceVerificationRoutes` for the same diff and is REJECTED for a
// different diff.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cmdVerify } from "../src/commands/verify.js";
import { loadAgentReviewConfig, type LoadedConfig } from "../src/policy/config.js";
import { collectChangedPaths, readQualityGateEvidence } from "../src/evidence/index.js";
import { enforceVerificationRoutes } from "../src/policy/gate.js";
import {
  changedFiles,
  commitDiff,
  commitParent,
  diffHash,
  resolveCommit,
} from "../src/git.js";
import { fixturePath } from "./_helpers.js";
import type { VerificationRoute } from "@momentiq/dark-factory-schemas";

interface Captured {
  out: string;
  err: string;
}
function capture(): {
  io: { stdout: (s: string) => void; stderr: (s: string) => void };
  cap: Captured;
} {
  const cap: Captured = { out: "", err: "" };
  return {
    io: {
      stdout: (s: string) => {
        cap.out += s;
      },
      stderr: (s: string) => {
        cap.err += s;
      },
    },
    cap,
  };
}

interface TempRepo {
  dir: string;
  loaded: LoadedConfig;
  sha: string;
}

function route(id: string, command: string | null, trigger: string[]): VerificationRoute {
  return {
    id,
    trigger,
    command,
    evidencePath: command === null ? null : "agent-reviews/quality-gates/${sha}.json",
    category: "test",
    evidenceKind: command === null ? "none" : "test",
  };
}

// Build a temp repo whose HEAD commit changes `changedFile` so the
// parent..HEAD diff arms routes that trigger on it. The config (with
// `routes`) lands in the INIT commit so it is NOT part of HEAD's diff.
async function setupRepo(
  routes: VerificationRoute[],
  changedFile: string,
): Promise<TempRepo> {
  const dir = mkdtempSync(join(tmpdir(), "df-verify-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir], { cwd: process.cwd() });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

  writeFileSync(join(dir, "README.md"), "# r\n");
  const cfg = JSON.parse(readFileSync(fixturePath("config.json"), "utf8"));
  cfg.validation.verificationRoutes = routes;
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(cfg));
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const abs = join(dir, changedFile);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "changed\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "feat"], { cwd: dir });

  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const sha = await resolveCommit("HEAD", dir);
  return { dir, loaded, sha };
}

async function gatedDiffHashOf(repo: TempRepo): Promise<string> {
  const parent = await commitParent(repo.sha, repo.dir);
  return diffHash(await commitDiff(parent, repo.sha, repo.dir));
}

const TF_FILE = "infra/terraform/main.tf";
const TF_TRIGGER = ["infra/terraform/**"];

describe("cmdVerify — exit-code mapping (#192)", () => {
  it("runs an armed route, stamps diffHash-bound evidence, exits 0 (green)", async () => {
    const repo = await setupRepo([route("terraform", "true", TF_TRIGGER)], TF_FILE);
    const { io, cap } = capture();
    const code = await cmdVerify(["--cwd", repo.dir], io);
    expect(code).toBe(0);

    const { evidence } = await readQualityGateEvidence(repo.loaded, repo.sha);
    expect(evidence?.gateResults?.["terraform"]?.exitCode).toBe(0);
    // Producer half of #194 — the evidence is bound to the gated diff.
    expect(evidence?.diffHash).toBe(await gatedDiffHashOf(repo));
    expect(cap.out).toMatch(/PASS route\[terraform\]/);
  });

  it("exits 1 when a ran route blocks (exit 1)", async () => {
    const repo = await setupRepo([route("terraform", "false", TF_TRIGGER)], TF_FILE);
    const { io, cap } = capture();
    const code = await cmdVerify(["--cwd", repo.dir], io);
    expect(code).toBe(1);
    expect(cap.out).toMatch(/FAIL route\[terraform\]/);
  });

  it("exits 2 when a ran route soft-skips (exit 2), none blocked", async () => {
    const repo = await setupRepo(
      [route("terraform", "sh -c 'exit 2'", TF_TRIGGER)],
      TF_FILE,
    );
    const { io } = capture();
    const code = await cmdVerify(["--cwd", repo.dir], io);
    expect(code).toBe(2);
  });

  it("block dominates soft-skip in the exit code (1 over 2)", async () => {
    const repo = await setupRepo(
      [
        route("a", "false", ["**/*"]),
        route("b", "sh -c 'exit 2'", ["**/*"]),
      ],
      "src/x.ts",
    );
    const { io } = capture();
    const code = await cmdVerify(["--cwd", repo.dir], io);
    expect(code).toBe(1);
  });
});

describe("cmdVerify — produce → enforce round trip (#192 + #194 acceptance)", () => {
  it("evidence df verify writes SATISFIES the gate for the same diff, and is REJECTED for a different diff", async () => {
    const repo = await setupRepo([route("terraform", "true", TF_TRIGGER)], TF_FILE);
    const { io } = capture();
    expect(await cmdVerify(["--cwd", repo.dir], io)).toBe(0);

    const parent = await commitParent(repo.sha, repo.dir);
    const files = await changedFiles(parent, repo.sha, repo.dir, { readContent: false });
    const changedPaths = collectChangedPaths(files);
    const gatedDiffHash = await gatedDiffHashOf(repo);

    // Unchanged diff → re-validates the existing evidence (gate passes).
    const okEval = await enforceVerificationRoutes({
      loaded: repo.loaded,
      sha: repo.sha,
      changedPaths,
      diffHash: gatedDiffHash,
    });
    expect(okEval.perRoute.find((r) => r.routeId === "terraform")?.status).toBe("ok");

    // Changed diff → the stamped evidence is now stale (gate blocks).
    const staleEval = await enforceVerificationRoutes({
      loaded: repo.loaded,
      sha: repo.sha,
      changedPaths,
      diffHash: "sha256:DIFFERENT",
    });
    expect(staleEval.perRoute.find((r) => r.routeId === "terraform")?.status).toBe("failed");
  });
});

describe("cmdVerify — --route filter (#192)", () => {
  it("runs only the named route", async () => {
    const repo = await setupRepo(
      [route("a", "true", ["**/*"]), route("b", "true", ["**/*"])],
      "src/x.ts",
    );
    const { io } = capture();
    expect(await cmdVerify(["--cwd", repo.dir, "--route", "a"], io)).toBe(0);
    const { evidence } = await readQualityGateEvidence(repo.loaded, repo.sha);
    expect(evidence?.gateResults?.["a"]?.exitCode).toBe(0);
    expect(evidence?.gateResults?.["b"]).toBeUndefined();
  });

  it("exits 2 with an actionable error on an UNKNOWN route id", async () => {
    const repo = await setupRepo([route("terraform", "true", TF_TRIGGER)], TF_FILE);
    const { io, cap } = capture();
    const code = await cmdVerify(["--cwd", repo.dir, "--route", "nope"], io);
    expect(code).toBe(2);
    expect(cap.err).toMatch(/unknown route "nope"/i);
  });

  it("exits 0 (nothing to verify) for a KNOWN route the diff did not trigger", async () => {
    // terraform is configured but the change is under src/ → not triggered.
    const repo = await setupRepo([route("terraform", "true", TF_TRIGGER)], "src/x.ts");
    const { io, cap } = capture();
    const code = await cmdVerify(["--cwd", repo.dir, "--route", "terraform"], io);
    expect(code).toBe(0);
    expect(cap.out).toMatch(/nothing to verify/i);
  });
});

describe("cmdVerify — recursion guard + degenerate cases (#192)", () => {
  it("exits 1 with a clear error when a route still has the `df verify` placeholder", async () => {
    const repo = await setupRepo(
      [route("playwright", "df verify --route playwright", ["**/*"])],
      "web/app.tsx",
    );
    const { io, cap } = capture();
    const code = await cmdVerify(["--cwd", repo.dir], io);
    expect(code).toBe(1);
    expect(cap.err).toMatch(/placeholder command/i);
  });

  it("exits 0 (nothing to verify) when no route is triggered", async () => {
    const repo = await setupRepo(
      [route("terraform", "true", TF_TRIGGER)],
      "src/unrelated.ts",
    );
    const { io, cap } = capture();
    const code = await cmdVerify(["--cwd", repo.dir], io);
    expect(code).toBe(0);
    expect(cap.out).toMatch(/nothing to verify/i);
  });

  it("--help exits 0 and documents the subcommand", async () => {
    const { io, cap } = capture();
    const code = await cmdVerify(["--help"], io);
    expect(code).toBe(0);
    expect(cap.out).toMatch(/df verify/);
    expect(cap.out).toMatch(/--route/);
  });

  it("exits 2 on an unknown flag", async () => {
    const { io, cap } = capture();
    const code = await cmdVerify(["--bogus"], io);
    expect(code).toBe(2);
    expect(cap.err).toMatch(/unknown flag/i);
  });
});
