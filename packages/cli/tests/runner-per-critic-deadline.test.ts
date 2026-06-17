// Issue #180 — per-critic deadline (mid-review hang guard).
//
// A "mid-review" hang is distinct from #167's post-completion hang: an
// adapter's `review()` promise never settles (a stalled vendor stream that
// ignores `options.signal`), so `Promise.all` over the critics never
// resolves → `runReview()` never returns → `main()` never resolves → the
// #167 `finalizeExit` backstop (armed in the entrypoint's `.then` AFTER
// `main()` resolves) never arms → the process runs to the 20m GHA job clamp
// and is killed as an orphan, dequeuing the PR.
//
// The fix races each `adapter.review()` against a per-critic deadline,
// derived from `DF_CRITIC_TIMEOUT_MS`, that RESOLVES (never rejects) to a
// structured `critic_deadline_exceeded` error. On a deadline win the
// aggregate still settles → `runReview()` returns → `main()` resolves →
// `finalizeExit` arms. Under the `min-complete-quorum` policy the degraded
// critic does NOT block the gate (degrade-and-pass), so the merge queue is
// no longer dequeued by one wedged adapter.
//
// PRIMARY assertion: with one never-resolving adapter + 3 healthy critics
// (quorum 2), `runReview()` SETTLES within the deadline+grace, the wedged
// critic's result is `status:"error"` `code:"critic_deadline_exceeded"`, the
// aggregate verdict is APPROVED (degrade-AND-PASS), and the evidence artifact
// is written. WITHOUT the fix this test times out at vitest's 10s limit — it
// is a real regression test.

import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { CONFIG_RELATIVE_PATH, type LoadedConfig } from "../src/policy/config.js";
import {
  AdapterRegistry,
  type CriticAdapter,
  type CriticReviewOptions,
} from "../src/adapters/critic.js";
import {
  computePerCriticDeadlineMs,
  dispatchWithDeadline,
  runReview,
} from "../src/runner.js";
import {
  parseAgentReviewConfig,
  type AgentReviewConfig,
  type CriticConfig,
  type CriticResult,
  type DoctorCheck,
  type ReviewPacket,
} from "@momentiq/dark-factory-schemas";

const CRITIC_IDS = ["a", "b", "c", "d"] as const;

function buildConfig(): AgentReviewConfig {
  return parseAgentReviewConfig({
    version: 2,
    critics: CRITIC_IDS.map((id) => ({
      id,
      name: id,
      adapter: id,
      required: false,
      runtime: "local",
      model: { id: "m", params: [] },
    })),
    aggregation: {
      policy: "min-complete-quorum",
      blockingSeverities: ["blocker", "high"],
      quorum: 2,
    },
    git: {
      hookPath: ".husky",
      artifactDir: "agent-reviews",
      artifactScope: "git-common-dir",
    },
    policy: {
      blockOnMissingReview: true,
      blockOnReviewError: true,
      allowEmergencyBypass: true,
      postCommitMode: "async",
    },
    context: {
      guidanceFiles: [],
      promptFragments: [],
      maxChangedFileBytes: 200000,
      includeFullChangedFiles: true,
    },
    tdd: {
      classifier: {
        productionGlobs: ["**/*.py"],
        testGlobs: ["tests/**"],
        exclusionGlobs: ["docs/**"],
        justificationTrailer: "Tdd-Justification",
      },
    },
    validation: {
      runBeforeReview: false,
      resultFile: "agent-reviews/quality-gates/latest.json",
      requiredQualityGates: [],
      optionalQualityGates: [],
      verificationRoutes: [],
    },
    security: {
      redactSecretsInDiagnostics: true,
      treatDiffAsUntrustedInput: true,
    },
  });
}

// A healthy adapter that returns an APPROVED result immediately.
function makeApprovingAdapter(id: string): CriticAdapter {
  return {
    id,
    requiredEnvVars: [] as const,
    async review(
      _packet: ReviewPacket,
      critic: CriticConfig,
      _options: CriticReviewOptions,
    ): Promise<CriticResult> {
      return {
        criticId: critic.id,
        status: "complete",
        verdict: "APPROVED",
        requiresHumanJudgment: false,
        reviewer: {
          name: critic.name,
          adapter: critic.adapter,
          model: critic.model,
          runtime: critic.runtime,
        },
        summary: "ok",
        findings: [],
        validation: { qualityGateResults: [], qualityGatesMissing: [] },
        confidence: "high",
      };
    },
    async doctor(_critic: CriticConfig): Promise<DoctorCheck[]> {
      return [];
    },
  };
}

// The pathological adapter: its `review()` promise NEVER settles and it
// ignores `options.signal` entirely — exactly the wedged-stream case #180
// describes. Without the per-critic deadline this hangs `Promise.all`.
function makeWedgedAdapter(id: string): CriticAdapter {
  return {
    id,
    requiredEnvVars: [] as const,
    review(
      _packet: ReviewPacket,
      _critic: CriticConfig,
      _options: CriticReviewOptions,
    ): Promise<CriticResult> {
      // Never resolves. Deliberately does NOT observe `options.signal`.
      return new Promise<CriticResult>(() => {});
    },
    async doctor(_critic: CriticConfig): Promise<DoctorCheck[]> {
      return [];
    },
  };
}

async function setupRepo(): Promise<{ dir: string; sha: string; loaded: LoadedConfig }> {
  const dir = mkdtempSync(join(tmpdir(), "df-per-critic-deadline-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir]);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  const cfg = buildConfig();
  writeFileSync(join(dir, CONFIG_RELATIVE_PATH), JSON.stringify(cfg, null, 2) + "\n");
  writeFileSync(join(dir, "README.md"), "# test\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir }).stdout.toString().trim();
  return {
    dir,
    sha,
    loaded: { config: cfg, repoRoot: dir, configPath: join(dir, CONFIG_RELATIVE_PATH) },
  };
}

describe("computePerCriticDeadlineMs — ordering invariant (issue #180)", () => {
  test("production deadline sits strictly between the 15m abort and 20m clamp", () => {
    const FIFTEEN_MIN = 900_000;
    const TWENTY_MIN = 1_200_000;
    const perCritic = computePerCriticDeadlineMs(FIFTEEN_MIN);
    // 900_000 + min(30_000, 900_000) = 930_000 (15.5m).
    expect(perCritic).toBe(930_000);
    // Load-bearing ordering: 15m abort < per-critic deadline < 20m job clamp.
    // A well-behaved adapter emits its own structured error at the 15m abort;
    // only a genuinely-wedged adapter reaches the generic per-critic deadline,
    // which still fires comfortably before the 20m clamp.
    expect(perCritic).toBeGreaterThan(FIFTEEN_MIN);
    expect(perCritic).toBeLessThan(TWENTY_MIN);
  });

  test("grace shrinks with the base so a low test deadline still fires fast", () => {
    // A fixed +30s grace would make the deadline un-observable inside a unit
    // test's 10s timeout. The grace is min(30_000, base), so a 100ms base
    // yields a 200ms deadline.
    expect(computePerCriticDeadlineMs(100)).toBe(200);
    expect(computePerCriticDeadlineMs(50)).toBe(100);
  });
});

describe("dispatchWithDeadline — resolves to a structured error on deadline (issue #180)", () => {
  const CRITIC: CriticConfig = {
    id: "wedged",
    name: "Wedged Critic",
    adapter: "x",
    required: false,
    runtime: "local",
    model: { id: "m", params: [] },
  };

  test("a never-resolving review resolves to critic_deadline_exceeded within the deadline", async () => {
    const never = new Promise<CriticResult>(() => {});
    const result = await dispatchWithDeadline({
      reviewPromise: never,
      critic: CRITIC,
      deadlineMs: 30,
      commit: "deadbeef",
    });
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("critic_deadline_exceeded");
    expect(result.error?.retryable).toBe(false);
    expect(result.criticId).toBe("wedged");
  });

  test("a fast healthy review wins the race and the deadline result is discarded", async () => {
    const ok: CriticResult = {
      criticId: "wedged",
      status: "complete",
      verdict: "APPROVED",
      requiresHumanJudgment: false,
      reviewer: {
        name: CRITIC.name,
        adapter: CRITIC.adapter,
        model: CRITIC.model,
        runtime: CRITIC.runtime,
      },
      summary: "ok",
      findings: [],
      validation: { qualityGateResults: [], qualityGatesMissing: [] },
      confidence: "high",
    };
    const result = await dispatchWithDeadline({
      reviewPromise: Promise.resolve(ok),
      critic: CRITIC,
      deadlineMs: 30,
      commit: "deadbeef",
    });
    expect(result.status).toBe("complete");
    expect(result.verdict).toBe("APPROVED");
  });
});

describe("runReview — per-critic deadline degrade-and-pass (issue #180)", () => {
  test("one wedged adapter degrades to an error result; the gate still passes under quorum", async () => {
    const { dir, sha, loaded } = await setupRepo();
    const registry = new AdapterRegistry();
    // 3 healthy APPROVED critics + 1 never-resolving wedged critic. Quorum is
    // 2, so the 3 completions satisfy quorum and the degraded critic must NOT
    // block the gate (degrade-AND-pass).
    registry.register(makeApprovingAdapter("a"));
    registry.register(makeApprovingAdapter("b"));
    registry.register(makeApprovingAdapter("c"));
    registry.register(makeWedgedAdapter("d"));

    const prior = process.env["DF_CRITIC_TIMEOUT_MS"];
    // Base 50ms → per-critic deadline 100ms; settles well inside the 10s test
    // timeout. WITHOUT the fix this test hangs until vitest kills it at 10s.
    process.env["DF_CRITIC_TIMEOUT_MS"] = "50";
    let outcome;
    try {
      outcome = await runReview({ loaded, registry, ref: sha, cwd: dir });
    } finally {
      if (prior === undefined) delete process.env["DF_CRITIC_TIMEOUT_MS"];
      else process.env["DF_CRITIC_TIMEOUT_MS"] = prior;
    }

    // The wedged critic's result is a structured deadline error.
    const wedged = outcome.artifact.criticResults.find((r) => r.criticId === "d");
    expect(wedged, "wedged critic 'd' must appear in the artifact").toBeDefined();
    expect(wedged!.status).toBe("error");
    expect(wedged!.error?.code).toBe("critic_deadline_exceeded");

    // The three healthy critics completed.
    for (const id of ["a", "b", "c"]) {
      const r = outcome.artifact.criticResults.find((c) => c.criticId === id);
      expect(r, `healthy critic '${id}' must appear in the artifact`).toBeDefined();
      expect(r!.status).toBe("complete");
    }

    // DEGRADE-AND-PASS: the aggregate verdict is APPROVED despite the wedged
    // critic — the proof that one hung adapter no longer dequeues the PR.
    expect(outcome.artifact.gateVerdict).toBe("APPROVED");

    // The evidence artifact (per-SHA JSON) is written to disk.
    expect(existsSync(outcome.paths.jsonPath)).toBe(true);
  });
});
