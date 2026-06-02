// Issue #29 — `MaxListenersExceededWarning: 11 abort listeners added to
// [AbortSignal]` observed in CI under the agent-critic reusable workflow.
//
// Root cause: `runReview` builds ONE `reviewOptions` with a single shared
// `options.signal` and fans it out to N critic adapters via `Promise.all`.
// Each adapter's SDK call (Cursor, Codex, Gemini, Grok, cursor-cli) attaches
// one or more abort listeners to that signal. With 4 critics × multiple
// retry attempts × SDK-internal listeners, the count crosses the default
// EventTarget cap of 10 and Node emits a process-wide warning. The warning
// itself is informational, BUT it surfaces right at the ~10-minute boundary
// where the workflow's `timeout-minutes: 10` cancels the run — operators
// see it as a flake.
//
// Fix: `runReview` bumps the per-signal max-listeners cap to a bounded
// number that comfortably covers (critics × max-retries × per-attempt
// listeners). The cap is bounded because the critic count comes from the
// config and the retry budget is fixed at RETRY_BACKOFF_MS.length + 1.

import { describe, expect, test } from "vitest";
import { getMaxListeners, setMaxListeners } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  CONFIG_RELATIVE_PATH,
  type LoadedConfig,
} from "../src/policy/config.js";
import {
  AdapterRegistry,
  type CriticAdapter,
  type CriticReviewOptions,
} from "../src/adapters/critic.js";
import { runReview } from "../src/runner.js";
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

// Simulate the production behavior of every SDK adapter call: attach an
// abort listener to the passed-in signal and hold it. Real SDK calls
// (Cursor/Codex/Gemini/Grok internals) do this — the test mimics that
// surface so the leak is reproducible without pulling in the real SDKs.
function makeListenerAttachingAdapter(id: string, listenersPerCall: number): CriticAdapter {
  return {
    id,
    requiredEnvVars: [] as const,
    async review(
      packet: ReviewPacket,
      critic: CriticConfig,
      options: CriticReviewOptions,
    ): Promise<CriticResult> {
      if (options.signal) {
        for (let i = 0; i < listenersPerCall; i++) {
          const noop = (): void => {};
          options.signal.addEventListener("abort", noop);
        }
      }
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

async function setupRepo(): Promise<{ dir: string; sha: string; loaded: LoadedConfig }> {
  const dir = mkdtempSync(join(tmpdir(), "df-runner-leak-"));
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

  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir })
    .stdout.toString()
    .trim();
  return {
    dir,
    sha,
    loaded: { config: cfg, repoRoot: dir, configPath: join(dir, CONFIG_RELATIVE_PATH) },
  };
}

describe("runReview — abort-listener leak guard (issue #29)", () => {
  test("raises the per-signal max-listeners cap so concurrent critics don't trip MaxListenersExceededWarning", async () => {
    const { dir, sha, loaded } = await setupRepo();

    const registry = new AdapterRegistry();
    // 3 listeners per adapter × 4 critics = 12 attachments to the shared
    // signal — comfortably above Node's default cap of 10. Without the fix
    // this would trigger a MaxListenersExceededWarning on the AbortSignal.
    const LISTENERS_PER_ADAPTER = 3;
    for (const id of CRITIC_IDS) {
      registry.register(makeListenerAttachingAdapter(id, LISTENERS_PER_ADAPTER));
    }

    const controller = new AbortController();
    const signal = controller.signal;

    // Pin the signal's cap at Node's `defaultMaxListeners` (10) to model
    // the production posture: undici / SDK internals call
    // `setMaxListeners(10, signal)` on first fetch, after which any 11th
    // listener triggers MaxListenersExceededWarning. Without this priming
    // the EventTarget defaults to 0 (no cap) and the leak symptom from
    // issue #29 is silently invisible to the test.
    setMaxListeners(10, signal);
    expect(getMaxListeners(signal)).toBe(10);

    // Spy on process warnings so a regression (the fix being removed) is
    // caught even if the cap check above is loosened. Any
    // `MaxListenersExceededWarning` originating from an AbortSignal
    // during runReview MUST be absent.
    const warnings: NodeJS.ProcessWarning[] = [];
    const warnHandler = (w: NodeJS.ProcessWarning): void => {
      warnings.push(w);
    };
    process.on("warning", warnHandler);
    try {
      await runReview({
        loaded,
        registry,
        ref: sha,
        cwd: dir,
        signal,
      });
    } finally {
      process.off("warning", warnHandler);
    }

    // Cap is raised above the default 10 — the runner protected the
    // shared signal from listener accumulation across the concurrent
    // adapter fan-out.
    expect(getMaxListeners(signal)).toBeGreaterThan(10);

    // No leak warning ever surfaced — the production symptom (issue #29)
    // is fully closed.
    const leakWarn = warnings.find(
      (w) =>
        w.name === "MaxListenersExceededWarning" &&
        /AbortSignal|abort listeners/i.test(w.message),
    );
    expect(
      leakWarn,
      `unexpected listener-leak warning: ${leakWarn?.message ?? "(none)"}`,
    ).toBeUndefined();
  });
});
