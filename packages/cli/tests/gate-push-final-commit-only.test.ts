// Cycle 13 (dark-factory-platform#149) — semantic-flip tests for
// `df gate-push`.
//
// Pins:
//   1. DEFAULT mode (final-commit-only): a push whose HEAD commit is
//      APPROVED proceeds (exit 0) even if intermediate commits' per-SHA
//      artifacts carry stale CHANGES_REQUESTED verdicts. This is the
//      core regression test for the find-fix-new-commit termination
//      failure observed on Cycle 13 — the 8-round iteration trail
//      produced a final commit with APPROVED on its own merits, but
//      the implicit-default per-commit gate rejected the push because
//      intermediate commits' artifacts still said CHANGES_REQUESTED.
//      The default flip makes that scenario terminate cleanly.
//
//   2. LEGACY mode via `--full-range`: blocks the same push (any
//      intermediate CHANGES_REQUESTED still vetoes). Proves the
//      override is wired and the legacy semantic is preserved for
//      forensic / per-commit-audit consumers.
//
//   3. LEGACY mode via `DF_GATE_FULL_RANGE=1`: same as (2) but the
//      env-var path. Pins both knobs for symmetry — the env var is
//      the documented operator surface (set once, persisted in the
//      shell), the flag is the per-invocation surface.
//
//   4. Mode banner: the output prints `GATE MODE: final-commit-only`
//      or `GATE MODE: full-range` so operators can see which semantic
//      is active without remembering the env-var/flag state.
//
//   5. Single-commit push: trivially gates that commit regardless of
//      mode (no intermediate commits exist).
//
//   6. Help text: `df gate-push --help` documents the new default,
//      the `--full-range` flag, and the `DF_GATE_FULL_RANGE` env var.
//
// All fixtures use v1 configs (no TDD classifier, no verification
// routes) so the gate's only input is the per-SHA artifact verdict
// — the minimal surface needed to validate the range-iteration
// semantic without dragging in the full v2 deterministic-gate stack.

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

import { commitDiff, diffHash } from "../src/git.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "dist", "cli.js");

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runDfCli(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
  } = {},
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...(options.env ?? {}) },
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
    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
  });
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`,
    );
  }
  return String(r.stdout).trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "df-gate-push-cycle13-"));
  spawnSync("git", ["init", "-q", "-b", "main", root]);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "t"], { cwd: root });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  return root;
}

function makeCommit(root: string, file: string, content: string, message: string): string {
  writeFileSync(join(root, file), content);
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", message], { cwd: root });
  return git(root, ["rev-parse", "HEAD"]);
}

function writeConfig(root: string): void {
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
          // `block-if-any` requires at least one `required: true` critic;
          // the loader rejects a config where every critic is optional
          // (since under that policy the gate only blocks on required
          // critics, so the combination would silently downgrade blockers
          // to warnings). Set true so the loader accepts the fixture.
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
        // Intermediate commits in the test fixture get NO artifact —
        // we only seed the explicit ones below. The default-mode test
        // setups all give HEAD an artifact (APPROVED), so HEAD never
        // hits this branch. The legacy-mode tests seed every commit
        // explicitly, also avoiding the branch. Set false defensively
        // so an accidental gap surfaces as a test bug, not a hard
        // block from this policy.
        blockOnMissingReview: false,
        blockOnReviewError: false,
        allowEmergencyBypass: true,
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
  opts: { withBlocker?: boolean } = {},
): Promise<void> {
  mkdirSync(join(root, ".git", "agent-reviews"), { recursive: true });
  const findings = opts.withBlocker || verdict === "CHANGES_REQUESTED"
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
  // The gate's stale_diff_hash check compares the artifact's diffHash
  // to a freshly-computed sha over the parent..commit diff. The
  // fixture has to compute the real hash so the gate doesn't reject
  // the artifact as stale. Use the same `commitDiff` + `diffHash`
  // helpers `runCommitGate` uses (re-exported from src/git.ts) so the
  // two paths can't drift.
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

// Build a fixture simulating the Cycle 13 find-fix iteration trail:
// 1 base commit on `main`, then N iteration commits where every
// intermediate carries a stale CHANGES_REQUESTED artifact and the
// FINAL (HEAD) commit carries APPROVED. Returns `{ root, baseSha,
// commits, headSha }`.
//
// Sets up a remote `origin` pointing at a bare clone with the base
// commit checked in, so pre-push stdin (`localRef localSha remoteRef
// remoteSha`) can use real SHAs.
async function fixtureIterationTrail(rounds: number): Promise<{
  root: string;
  baseSha: string;
  iterationShas: string[];
  headSha: string;
  remoteSha: string;
}> {
  const root = initRepo();
  writeConfig(root);

  const baseSha = makeCommit(root, "README.md", "# fixture\n", "base");

  // Iteration commits — every one CHANGES_REQUESTED except the last.
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
  // remoteSha = baseSha (the push range is baseSha..HEAD)
  return { root, baseSha, iterationShas, headSha, remoteSha: baseSha };
}

function prePushStdin(
  localRef: string,
  localSha: string,
  remoteRef: string,
  remoteSha: string,
): string {
  return `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`;
}

describe("df gate-push — Cycle 13 (dark-factory-platform#149) final-commit-only default", () => {
  it("[REGRESSION] 8-round find-fix trail with APPROVED HEAD: default mode allows push", async () => {
    // The exact scenario from the consumer-side issue: 8 rounds of
    // find-fix-new-commit produced a final commit with `GATE: PASSED`
    // (APPROVED), but every intermediate carried CHANGES_REQUESTED.
    // Pre-Cycle-13 default rejected the push (any-block veto); the
    // Cycle 13 default gates HEAD only, so this push must proceed.
    const { root, headSha, remoteSha } = await fixtureIterationTrail(8);
    try {
      const r = await runDfCli(["gate-push"], {
        cwd: root,
        stdin: prePushStdin(
          "refs/heads/main",
          headSha,
          "refs/heads/main",
          remoteSha,
        ),
      });
      expect(r.exitCode).toBe(0);
      // Mode banner advertises the default semantic.
      expect(r.stdout).toContain("GATE MODE: final-commit-only");
      expect(r.stdout).toContain(headSha.slice(0, 12));
      // The intermediate-commits hint should fire (7 intermediates).
      expect(r.stdout).toContain("intermediate commits (7) are iteration receipts");
      expect(r.stdout).toContain("df findings --range");
      // The gating output references HEAD's short SHA.
      expect(r.stdout).toContain(`-- ${headSha.slice(0, 12)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("[REGRESSION] same 8-round trail with --full-range: legacy mode blocks the push", async () => {
    const { root, headSha, remoteSha } = await fixtureIterationTrail(8);
    try {
      const r = await runDfCli(["gate-push", "--full-range"], {
        cwd: root,
        stdin: prePushStdin(
          "refs/heads/main",
          headSha,
          "refs/heads/main",
          remoteSha,
        ),
      });
      // Legacy gates every commit; 7 of 8 are CHANGES_REQUESTED →
      // exit 1, mode banner says full-range.
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("GATE MODE: full-range");
      expect(r.stdout).toContain("(8 commits)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("DF_GATE_FULL_RANGE=1 env var matches --full-range flag semantics", async () => {
    const { root, headSha, remoteSha } = await fixtureIterationTrail(3);
    try {
      const r = await runDfCli(["gate-push"], {
        cwd: root,
        env: { DF_GATE_FULL_RANGE: "1" },
        stdin: prePushStdin(
          "refs/heads/main",
          headSha,
          "refs/heads/main",
          remoteSha,
        ),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("GATE MODE: full-range");
      expect(r.stdout).toContain("(3 commits)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("default mode with APPROVED-only trail still proceeds", async () => {
    // Sanity check: every commit APPROVED → default + legacy both
    // pass. Pins that final-commit-only doesn't accidentally let a
    // CHANGES_REQUESTED HEAD through.
    const root = initRepo();
    writeConfig(root);
    const baseSha = makeCommit(root, "README.md", "# fixture\n", "base");
    const a = makeCommit(root, "a.ts", "export const a = 1;\n", "a");
    const b = makeCommit(root, "b.ts", "export const b = 2;\n", "b");
    await seedArtifact(root, a, "APPROVED");
    await seedArtifact(root, b, "APPROVED");
    try {
      const r = await runDfCli(["gate-push"], {
        cwd: root,
        stdin: prePushStdin("refs/heads/main", b, "refs/heads/main", baseSha),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("GATE MODE: final-commit-only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("default mode with CHANGES_REQUESTED HEAD blocks the push", async () => {
    // Inverse of the regression test: HEAD itself is bad → the gate
    // still blocks, even with intermediate APPROVED commits. Pins
    // that HEAD's verdict really is the gate.
    const root = initRepo();
    writeConfig(root);
    const baseSha = makeCommit(root, "README.md", "# fixture\n", "base");
    const a = makeCommit(root, "a.ts", "export const a = 1;\n", "a");
    const b = makeCommit(root, "b.ts", "export const b = 2;\n", "b");
    await seedArtifact(root, a, "APPROVED");
    await seedArtifact(root, b, "CHANGES_REQUESTED");
    try {
      const r = await runDfCli(["gate-push"], {
        cwd: root,
        stdin: prePushStdin("refs/heads/main", b, "refs/heads/main", baseSha),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("GATE MODE: final-commit-only");
      expect(r.stdout).toContain(b.slice(0, 12));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("single-commit push (1 commit total) gates that commit regardless of mode", async () => {
    const root = initRepo();
    writeConfig(root);
    const baseSha = makeCommit(root, "README.md", "# fixture\n", "base");
    const a = makeCommit(root, "a.ts", "export const a = 1;\n", "a");
    await seedArtifact(root, a, "APPROVED");
    try {
      const r = await runDfCli(["gate-push"], {
        cwd: root,
        stdin: prePushStdin("refs/heads/main", a, "refs/heads/main", baseSha),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("GATE MODE: final-commit-only");
      // No intermediate-commits hint when there are no intermediates.
      expect(r.stdout).not.toContain("intermediate commits");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--help documents the default + the --full-range flag + DF_GATE_FULL_RANGE", async () => {
    const r = await runDfCli(["gate-push", "--help"]);
    expect(r.exitCode).toBe(0);
    // The HEAD-only default semantic is the load-bearing claim.
    expect(r.stdout).toContain("Gates ONLY the HEAD");
    expect(r.stdout).toContain("--full-range");
    expect(r.stdout).toContain("DF_GATE_FULL_RANGE");
    // Cycle 13 + cross-repo reference so operators can trace why the
    // default flipped.
    expect(r.stdout).toContain("Cycle 13");
    expect(r.stdout).toContain("dark-factory-platform#149");
    // The intermediate-receipt audit surface is documented as the
    // companion inspection path.
    expect(r.stdout).toContain("df findings --range");
    // Also still mentions the bypass surface and CI-replay path.
    expect(r.stdout).toContain("AGENT_REVIEW_BYPASS");
    expect(r.stdout).toContain("CI replay");
  });
});

describe("df findings --range — audit-mode inspection (dark-factory-platform#149)", () => {
  it("--help documents the --range flag and its NOT-a-gate posture", async () => {
    const r = await runDfCli(["findings", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df findings");
    expect(r.stdout).toContain("--range");
    expect(r.stdout).toContain("--json");
    // The NOT-a-gate semantic is load-bearing — readers must not
    // mistake `findings --range` for a re-gate. The help text has to
    // call this out explicitly.
    expect(r.stdout).toContain("re-run critics");
    expect(r.stdout).toContain("audit");
  });

  it("--range without value exits 2 with usage hint", async () => {
    const r = await runDfCli(["findings", "--range"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--range");
    expect(r.stderr).toContain("--help");
  });

  it("missing --range exits 2", async () => {
    const r = await runDfCli(["findings"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--range");
  });

  it("range with mixed verdicts surfaces every commit (text mode)", async () => {
    const { root, baseSha, iterationShas, headSha } = await fixtureIterationTrail(3);
    try {
      const r = await runDfCli(
        ["findings", "--range", `${baseSha}..${headSha}`],
        { cwd: root },
      );
      expect(r.exitCode).toBe(0);
      // Header lists the count.
      expect(r.stdout).toContain("3 commit(s) in");
      // Every iteration commit appears with its verdict line.
      for (const sha of iterationShas) {
        expect(r.stdout).toContain(sha.slice(0, 12));
      }
      // The intermediate verdicts are surfaced (CHANGES_REQUESTED for
      // the first two; APPROVED for the last). Both must be visible
      // since the whole point of `--range` is to expose the trail.
      expect(r.stdout).toContain("CHANGES_REQUESTED");
      expect(r.stdout).toContain("APPROVED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--json output is a parseable array of df_findings-shaped records", async () => {
    const { root, baseSha, iterationShas, headSha } = await fixtureIterationTrail(3);
    try {
      const r = await runDfCli(
        ["findings", "--range", `${baseSha}..${headSha}`, "--json"],
        { cwd: root },
      );
      expect(r.exitCode).toBe(0);
      const records = JSON.parse(r.stdout) as Array<{
        commit: string;
        critics?: Array<{ id: string; status: string; verdict?: string }>;
        error?: string;
      }>;
      expect(records.length).toBe(3);
      // Order matches the rev-list --reverse walk: oldest first.
      expect(records[0]?.commit).toBe(iterationShas[0]);
      expect(records[2]?.commit).toBe(iterationShas[2]);
      // df_findings shape (commit + critics with verdict) is preserved.
      const last = records[2];
      expect(last?.critics?.[0]?.verdict).toBe("APPROVED");
      const first = records[0];
      expect(first?.critics?.[0]?.verdict).toBe("CHANGES_REQUESTED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("missing intermediate artifact appears as { commit, error } in JSON", async () => {
    // The find-fix flow can produce intermediates without artifacts
    // (e.g. a hook-skipped commit). `df findings --range` must surface
    // those as gaps explicitly, not silently drop them.
    const root = initRepo();
    writeConfig(root);
    const baseSha = makeCommit(root, "README.md", "# fixture\n", "base");
    const a = makeCommit(root, "a.ts", "export const a = 1;\n", "a");
    const b = makeCommit(root, "b.ts", "export const b = 2;\n", "b");
    // Only `b` gets an artifact; `a` is a gap.
    await seedArtifact(root, b, "APPROVED");
    try {
      const r = await runDfCli(
        ["findings", "--range", `${baseSha}..${b}`, "--json"],
        { cwd: root },
      );
      expect(r.exitCode).toBe(0);
      const records = JSON.parse(r.stdout) as Array<{
        commit: string;
        critics?: unknown;
        error?: string;
      }>;
      expect(records.length).toBe(2);
      const aRec = records.find((rec) => rec.commit === a);
      expect(aRec?.error).toBeDefined();
      expect(aRec?.critics).toBeUndefined();
      const bRec = records.find((rec) => rec.commit === b);
      expect(bRec?.error).toBeUndefined();
      expect(bRec?.critics).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("empty range exits 0 (idempotent — no commits to inspect)", async () => {
    const root = initRepo();
    writeConfig(root);
    const baseSha = makeCommit(root, "README.md", "# fixture\n", "base");
    try {
      const r = await runDfCli(
        ["findings", "--range", `${baseSha}..${baseSha}`],
        { cwd: root },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("0 commit(s)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("empty range with --json prints empty array", async () => {
    const root = initRepo();
    writeConfig(root);
    const baseSha = makeCommit(root, "README.md", "# fixture\n", "base");
    try {
      const r = await runDfCli(
        ["findings", "--range", `${baseSha}..${baseSha}`, "--json"],
        { cwd: root },
      );
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalid range exits 1 with git error in stderr", async () => {
    const root = initRepo();
    writeConfig(root);
    makeCommit(root, "README.md", "# fixture\n", "base");
    try {
      const r = await runDfCli(
        ["findings", "--range", "not-a-ref..also-not-a-ref"],
        { cwd: root },
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("git rev-list");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
