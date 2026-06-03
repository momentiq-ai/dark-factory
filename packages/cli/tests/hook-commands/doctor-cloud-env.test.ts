// Consumer issue dark-factory-platform#56 — `df doctor` cloud-env
// detection + subscription-auth skip.
//
// `detectCloudEnv` is pure: reads only `process.env` (or an injected
// `env` map). When detection fires, `runDoctor`:
//   1. emits a top-level `cloud_env` INFO check listing the markers, and
//   2. skips the per-adapter `doctor()` call for any critic whose
//      resolved `auth` is a subscription source (`chatgpt` |
//      `subscription` | `composer`), replacing it with a single
//      `<criticId>.subscription_auth_unavailable_cloud_env` INFO row.
// API-auth critics still run their adapter `doctor()` — API keys are
// expected to be present in cloud envs via Doppler / env vars.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLOUD_ENV_MARKERS,
  detectCloudEnv,
  runDoctor,
} from "../../src/doctor.js";
import { AdapterRegistry } from "../../src/adapters/critic.js";
import type {
  AgentReviewConfig,
  CriticAdapter,
  CriticConfig,
  DoctorCheck,
  ProfileConfig,
} from "@momentiq/dark-factory-schemas";
import type { LoadedConfig } from "../../src/policy/config.js";

class FakeAdapter implements CriticAdapter {
  readonly id = "fake-sdk";
  readonly requiredEnvVars: readonly string[] = [];
  public doctorCalled = 0;
  async review(): Promise<never> {
    throw new Error("FakeAdapter.review should not be called in doctor tests");
  }
  async doctor(_critic: CriticConfig): Promise<DoctorCheck[]> {
    this.doctorCalled++;
    return [
      {
        name: "fake_credentials",
        passed: true,
        detail: "fake adapter probe ran",
      },
    ];
  }
}

function buildLoadedConfig(opts: {
  repoRoot: string;
  critic?: Partial<CriticConfig>;
  profiles?: AgentReviewConfig["profiles"];
}): LoadedConfig {
  const critic: CriticConfig = {
    id: "fake-critic",
    name: "Fake Critic",
    adapter: "fake-sdk",
    required: true,
    runtime: "local",
    model: { id: "fake-model-1", params: [] },
    ...opts.critic,
  };
  const config: AgentReviewConfig = {
    version: 2,
    critics: [critic],
    aggregation: {
      policy: "block-if-any",
      blockingSeverities: ["blocker", "high"],
      quorum: 1,
    },
    git: {
      hookPath: ".husky",
      artifactDir: "agent-reviews",
      artifactScope: "git-common-dir",
    },
    policy: {
      blockOnMissingReview: false,
      blockOnReviewError: false,
      allowEmergencyBypass: true,
      postCommitMode: "async",
    },
    context: {
      guidanceFiles: [],
      promptFragments: [],
      maxChangedFileBytes: 200000,
      includeFullChangedFiles: true,
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
    ...(opts.profiles !== undefined ? { profiles: opts.profiles } : {}),
  };
  return { repoRoot: opts.repoRoot, configSource: "default", config };
}

function buildRegistry(): { registry: AdapterRegistry; fake: FakeAdapter } {
  const registry = new AdapterRegistry();
  const fake = new FakeAdapter();
  registry.register(fake);
  return { registry, fake };
}

function setupFakeRepo(tmp: string): void {
  execFileSync("git", ["init", "-q", tmp], { stdio: "ignore" });
}

describe("detectCloudEnv (pure)", () => {
  it("returns detected=false when no markers are set", () => {
    const result = detectCloudEnv({ env: {} });
    expect(result.detected).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it("detects CODESPACES=true", () => {
    const result = detectCloudEnv({ env: { CODESPACES: "true" } });
    expect(result.detected).toBe(true);
    expect(result.markers).toEqual(["CODESPACES"]);
  });

  it("detects REMOTE_CONTAINERS=1", () => {
    const result = detectCloudEnv({ env: { REMOTE_CONTAINERS: "1" } });
    expect(result.detected).toBe(true);
    expect(result.markers).toEqual(["REMOTE_CONTAINERS"]);
  });

  it("detects CLAUDE_CODE_SANDBOX=yes (case-insensitive)", () => {
    const result = detectCloudEnv({ env: { CLAUDE_CODE_SANDBOX: "YES" } });
    expect(result.detected).toBe(true);
    expect(result.markers).toEqual(["CLAUDE_CODE_SANDBOX"]);
  });

  it("ignores explicitly-falsy markers", () => {
    const result = detectCloudEnv({
      env: { CODESPACES: "false", DEVCONTAINER: "0" },
    });
    expect(result.detected).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it("ignores empty / unrelated values (does not false-positive on presence)", () => {
    const result = detectCloudEnv({
      env: {
        // CODESPACE_NAME is a Codespaces side-effect var — presence-only,
        // NOT a boolean marker. detectCloudEnv must ignore it.
        CODESPACE_NAME: "lyra-fancy-octopus",
        // CODESPACES set to something other than the truthy tokens.
        CODESPACES: "",
      },
    });
    expect(result.detected).toBe(false);
  });

  it("collects multiple markers when several fire", () => {
    const result = detectCloudEnv({
      env: { CODESPACES: "true", REMOTE_CONTAINERS: "true" },
    });
    expect(result.detected).toBe(true);
    expect(result.markers).toEqual(["CODESPACES", "REMOTE_CONTAINERS"]);
  });

  it("exports the marker set so consumers can introspect", () => {
    // Lock the marker order so downstream pre-push hooks can pattern-
    // match on it. Future additions are append-only (Phase 12.x).
    expect([...CLOUD_ENV_MARKERS]).toEqual([
      "CODESPACES",
      "REMOTE_CONTAINERS",
      "CLAUDE_CODE_SANDBOX",
      "DEVCONTAINER",
    ]);
  });
});

describe("runDoctor — cloud-env behavior", () => {
  let tmpRoot: string;
  const savedEnv: Record<string, string | undefined> = {};
  const cloudKeys = [
    "CODESPACES",
    "REMOTE_CONTAINERS",
    "CLAUDE_CODE_SANDBOX",
    "DEVCONTAINER",
  ] as const;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "df-doctor-cloud-env-"));
    setupFakeRepo(tmpRoot);
    for (const k of cloudKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    for (const k of cloudKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("emits a passing cloud_env check when no markers are set", async () => {
    const loaded = buildLoadedConfig({ repoRoot: tmpRoot });
    const { registry } = buildRegistry();
    const checks = await runDoctor({ loaded, registry, profileName: "local" });
    const cloudCheck = checks.find((c) => c.name === "cloud_env");
    expect(cloudCheck).toBeDefined();
    expect(cloudCheck?.passed).toBe(true);
    expect(cloudCheck?.optional).toBeUndefined();
    expect(cloudCheck?.detail).toMatch(/no cloud-env markers detected/);
  });

  it("emits cloud_env INFO + skips subscription-auth adapter probe", async () => {
    process.env["CODESPACES"] = "true";
    const profiles: AgentReviewConfig["profiles"] = {
      local: {
        criticIds: ["fake-critic"],
        quorum: 1,
        auth: { "fake-critic": "chatgpt" },
      } satisfies ProfileConfig,
    };
    const loaded = buildLoadedConfig({ repoRoot: tmpRoot, profiles });
    const { registry, fake } = buildRegistry();
    const checks = await runDoctor({ loaded, registry, profileName: "local" });

    const cloudCheck = checks.find((c) => c.name === "cloud_env");
    expect(cloudCheck?.passed).toBe(true);
    expect(cloudCheck?.optional).toBe(true);
    expect(cloudCheck?.detail).toMatch(/cloud env detected via CODESPACES/);
    expect(cloudCheck?.remediation).toMatch(/AGENT_REVIEW_BYPASS/);

    // Adapter doctor() must NOT have been called for a subscription
    // critic in a cloud env.
    expect(fake.doctorCalled).toBe(0);

    const skipCheck = checks.find(
      (c) => c.name === "fake-critic.subscription_auth_unavailable_cloud_env",
    );
    expect(skipCheck).toBeDefined();
    expect(skipCheck?.passed).toBe(true);
    expect(skipCheck?.optional).toBe(true);
    expect(skipCheck?.remediation).toMatch(/AGENT_REVIEW_BYPASS/);
  });

  it("still runs adapter doctor() for API-auth critics in cloud env", async () => {
    process.env["CLAUDE_CODE_SANDBOX"] = "true";
    const profiles: AgentReviewConfig["profiles"] = {
      local: {
        criticIds: ["fake-critic"],
        quorum: 1,
        auth: { "fake-critic": "api" },
      } satisfies ProfileConfig,
    };
    const loaded = buildLoadedConfig({ repoRoot: tmpRoot, profiles });
    const { registry, fake } = buildRegistry();
    const checks = await runDoctor({ loaded, registry, profileName: "local" });

    // Adapter doctor() must have been called — API keys CAN live in
    // cloud envs (via Doppler / env vars).
    expect(fake.doctorCalled).toBe(1);
    const adapterCheck = checks.find(
      (c) => c.name === "fake-critic.fake_credentials",
    );
    expect(adapterCheck).toBeDefined();
    // No skip row.
    const skipCheck = checks.find(
      (c) => c.name === "fake-critic.subscription_auth_unavailable_cloud_env",
    );
    expect(skipCheck).toBeUndefined();
  });

  it("runs adapter doctor() outside cloud env even when auth=chatgpt", async () => {
    const profiles: AgentReviewConfig["profiles"] = {
      local: {
        criticIds: ["fake-critic"],
        quorum: 1,
        auth: { "fake-critic": "chatgpt" },
      } satisfies ProfileConfig,
    };
    const loaded = buildLoadedConfig({ repoRoot: tmpRoot, profiles });
    const { registry, fake } = buildRegistry();
    const checks = await runDoctor({ loaded, registry, profileName: "local" });

    expect(fake.doctorCalled).toBe(1);
    const adapterCheck = checks.find(
      (c) => c.name === "fake-critic.fake_credentials",
    );
    expect(adapterCheck).toBeDefined();
    const skipCheck = checks.find(
      (c) => c.name === "fake-critic.subscription_auth_unavailable_cloud_env",
    );
    expect(skipCheck).toBeUndefined();
  });
});
