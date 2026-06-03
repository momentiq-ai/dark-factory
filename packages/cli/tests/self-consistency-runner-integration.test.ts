// Cursor finding (self-consistency-corroboration.test.ts:1) +
// codex finding (cli.ts:560) — the existing test corpus exercises
// pure helpers and aggregator fixtures with mock probes, but no test
// drives `runReview({ selfConsistencyProbe })` end-to-end. Wiring
// mistakes in `cli.ts` / `runner.ts` would not be caught.
//
// This file plugs that gap: a stub probe that always returns
// `inconsistent` is passed to `runReview`; the assertion is that the
// resulting artifact's findings carry `selfInconsistent: true`, the
// aggregate verdict was demoted from CHANGES_REQUESTED to APPROVED
// per the policy, and the telemetry stream includes the expected
// `self_consistency_probe` + `critic_disagreement` events.

import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
import type {
  SelfConsistencyProbeFn,
  SelfConsistencyProbeInput,
} from "../src/self-consistency.js";
import {
  parseAgentReviewConfig,
  type AgentReviewConfig,
  type CriticConfig,
  type CriticResult,
  type DoctorCheck,
  type ReviewFinding,
  type ReviewPacket,
  type TelemetryEvent,
} from "@momentiq/dark-factory-schemas";

// Inline telemetry sink — captures events in-memory so the test
// asserts probe and disagreement signals reached the audit channel.
class CapturingSink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

function buildConfig(withPolicy: boolean): AgentReviewConfig {
  const aggregation: Record<string, unknown> = {
    policy: "min-complete-quorum",
    blockingSeverities: ["blocker", "high"],
    quorum: 2,
  };
  if (withPolicy) {
    aggregation["unilateralVetoRules"] = {
      requireCorroborationFor: ["self_inconsistent"],
      requireCorroborationOnHunkRadius: 5,
    };
  }
  return parseAgentReviewConfig({
    version: 2,
    critics: [
      {
        id: "a",
        name: "a",
        adapter: "a",
        required: false,
        runtime: "local",
        model: { id: "m", params: [] },
      },
      {
        id: "b",
        name: "b",
        adapter: "b",
        required: false,
        runtime: "local",
        model: { id: "m", params: [] },
      },
    ],
    aggregation,
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

// One critic that returns a real blocker finding (the spec's negative
// fixture target: the gemini-style finding that should be demoted by
// the probe). The other critic returns no findings — so the demoted
// blocker has no corroboration and the policy fires.
function makeFindingAdapter(
  id: string,
  findings: ReviewFinding[],
  verdict: "APPROVED" | "CHANGES_REQUESTED",
): CriticAdapter {
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
        verdict,
        requiresHumanJudgment: false,
        reviewer: {
          name: critic.name,
          adapter: critic.adapter,
          model: critic.model,
          runtime: critic.runtime,
        },
        summary: "ok",
        findings,
        validation: { qualityGateResults: [], qualityGatesMissing: [] },
        confidence: "high",
      };
    },
    async doctor(_critic: CriticConfig): Promise<DoctorCheck[]> {
      return [];
    },
  };
}

async function setupRepo(
  withPolicy: boolean,
): Promise<{ dir: string; sha: string; loaded: LoadedConfig }> {
  const dir = mkdtempSync(join(tmpdir(), "df-probe-int-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir]);
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const cfg = buildConfig(withPolicy);
  writeFileSync(join(dir, CONFIG_RELATIVE_PATH), JSON.stringify(cfg, null, 2) + "\n");
  writeFileSync(join(dir, "scripts/check-df-pin.sh"), "#!/bin/sh\necho ok\n");
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

describe("runReview — self-consistency probe integration", () => {
  test("probe-tagged uncorroborated blocker is demoted; verdict flips to APPROVED; telemetry emitted", async () => {
    const { dir, sha, loaded } = await setupRepo(/*withPolicy*/ true);
    const registry = new AdapterRegistry();

    // Critic "a" finds the blocker on a file the probe will judge
    // inconsistent. Critic "b" approves with no findings — leaving the
    // critic-a blocker uncorroborated.
    const blockerFinding: ReviewFinding = {
      severity: "blocker",
      category: "tests",
      file: "scripts/check-df-pin.sh",
      line: 1,
      evidence: "the script does X (claim refuted by the file content)",
      impact: "breaks CI",
      requiredFix: "do Y instead",
    };
    registry.register(makeFindingAdapter("a", [blockerFinding], "CHANGES_REQUESTED"));
    registry.register(makeFindingAdapter("b", [], "APPROVED"));

    const captured: SelfConsistencyProbeInput[] = [];
    const probe: SelfConsistencyProbeFn = async (input) => {
      captured.push(input);
      return { consistent: false, reason: "probe judged claim refuted" };
    };

    const sink = new CapturingSink();
    const outcome = await runReview({
      loaded,
      registry,
      ref: sha,
      cwd: dir,
      telemetry: sink,
      selfConsistencyProbe: probe,
    });

    // The probe was invoked exactly once (one blocking finding on a
    // critic, the other critic produced no findings).
    expect(captured.length).toBe(1);
    expect(captured[0]?.finding.file).toBe("scripts/check-df-pin.sh");
    expect(captured[0]?.fileContent).toContain("echo ok");

    // The artifact's critic-a finding now carries selfInconsistent.
    const critA = outcome.artifact.criticResults.find((r) => r.criticId === "a");
    expect(critA?.findings[0]?.selfInconsistent).toBe(true);

    // Verdict flipped from CHANGES_REQUESTED to APPROVED because the
    // demoted blocker had no corroboration on the same file within 5
    // lines (the policy's safety net for uncorroborated probe-flagged
    // findings).
    expect(outcome.artifact.gateVerdict).toBe("APPROVED");

    // Persisted disagreements surface on the artifact (cursor finding
    // #4 — operators inspecting the JSON must see the demotion).
    expect(outcome.artifact.disagreements?.length).toBe(1);
    expect(outcome.artifact.disagreements?.[0]?.file).toBe("scripts/check-df-pin.sh");

    // Telemetry — both probe and disagreement events were emitted.
    const probeEvents = sink.events.filter(
      (e) => e.event === "self_consistency_probe",
    );
    expect(probeEvents.length).toBe(1);
    expect(probeEvents[0]?.status).toBe("probe_inconsistent");
    expect(probeEvents[0]?.criticId).toBe("a");

    const disagreementEvents = sink.events.filter(
      (e) => e.event === "critic_disagreement",
    );
    expect(disagreementEvents.length).toBeGreaterThanOrEqual(1);
    expect(disagreementEvents[0]?.criticId).toBe("a");

    // The on-disk markdown surfaces the demotion (cursor finding
    // #4 — renderMarkdown must surface selfInconsistent + a demoted
    // section).
    if (outcome.paths.markdownPath) {
      const md = readFileSync(outcome.paths.markdownPath, "utf8");
      expect(/self.?inconsistent/i.test(md)).toBe(true);
      expect(/demoted findings/i.test(md)).toBe(true);
    }
  });

  test("probe never runs when the policy doesn't list self_inconsistent (no tokens spent)", async () => {
    const { dir, sha, loaded } = await setupRepo(/*withPolicy*/ false);
    const registry = new AdapterRegistry();
    registry.register(
      makeFindingAdapter(
        "a",
        [
          {
            severity: "blocker",
            category: "tests",
            file: "scripts/check-df-pin.sh",
            line: 1,
            evidence: "x",
            impact: "y",
            requiredFix: "z",
          },
        ],
        "CHANGES_REQUESTED",
      ),
    );
    registry.register(makeFindingAdapter("b", [], "APPROVED"));

    let probeCalls = 0;
    const probe: SelfConsistencyProbeFn = async () => {
      probeCalls++;
      return { consistent: false, reason: "shouldn't be called" };
    };

    await runReview({
      loaded,
      registry,
      ref: sha,
      cwd: dir,
      selfConsistencyProbe: probe,
    });

    // No probe call — the runner skips the pass entirely when the
    // policy doesn't list self_inconsistent. Pure additive feature.
    expect(probeCalls).toBe(0);
  });
});
