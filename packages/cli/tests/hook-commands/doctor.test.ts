// Cycle 331.1 Phase F-LOCAL — runDoctor unit tests.
//
// The OSS doctor is intentionally slim — k3d/dist-staleness checks
// dropped vs sage3c. Tests verify:
//
//   1. node_version check is always present.
//   2. hooks_directory check correctly reports missing/present.
//   3. artifact_dir_writable check works.
//   4. Per-adapter checks are forwarded with proper id prefixing.
//   5. Optional critics flag `optional: true` so failures don't fail
//      doctor.
//   6. When a profile is active, applyProfileAuth clones critic config
//      with the pinned auth (the subscription-auth verification path).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDoctor } from "../../src/doctor.js";
import { AdapterRegistry } from "../../src/adapters/critic.js";
import type {
  AgentReviewConfig,
  CriticAdapter,
  CriticConfig,
  DoctorCheck,
} from "@momentiq/dark-factory-schemas";
import type { LoadedConfig } from "../../src/policy/config.js";

// --- Minimal fake adapter for testing the doctor wiring ---
class FakeAdapter implements CriticAdapter {
  readonly id = "fake-sdk";
  readonly requiredEnvVars: readonly string[] = [];
  // Capture the last critic passed to doctor() so tests can assert on
  // it (profile-auth verification).
  public lastDoctorCriticAuth: string | undefined;
  async review(): Promise<never> {
    throw new Error("FakeAdapter.review should not be called in doctor tests");
  }
  async doctor(critic: CriticConfig): Promise<DoctorCheck[]> {
    this.lastDoctorCriticAuth = critic.auth;
    return [
      {
        name: "fake_credentials",
        passed: false,
        detail: `fake adapter saw auth=${critic.auth ?? "(undefined)"}`,
      },
    ];
  }
}

function buildLoadedConfig(opts: {
  repoRoot: string;
  hookPath?: string;
  artifactDir?: string;
  profiles?: AgentReviewConfig["profiles"];
}): LoadedConfig {
  const hookPath = opts.hookPath ?? ".husky";
  const artifactDir = opts.artifactDir ?? "agent-reviews";
  const critics: CriticConfig[] = [
    {
      id: "fake-critic",
      name: "Fake Critic",
      adapter: "fake-sdk",
      required: false,
      runtime: "local",
      model: { id: "fake-model-1", params: [] },
    },
  ];
  const config: AgentReviewConfig = {
    version: 2,
    critics,
    aggregation: {
      policy: "block-if-any",
      blockingSeverities: ["blocker", "high"],
      quorum: 1,
    },
    git: {
      hookPath,
      artifactDir,
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
  return {
    repoRoot: opts.repoRoot,
    configSource: "default",
    config,
  };
}

function buildRegistry(): { registry: AdapterRegistry; fake: FakeAdapter } {
  const registry = new AdapterRegistry();
  const fake = new FakeAdapter();
  registry.register(fake);
  return { registry, fake };
}

// Helper: initialize a real (empty) git repo. The doctor walks
// `git rev-parse --git-common-dir` which requires an actual git
// repo — a hand-crafted `.git/HEAD` is not enough.
function setupFakeRepo(tmp: string): void {
  execFileSync("git", ["init", "-q", tmp], { stdio: "ignore" });
  // Suppress trace output during tests.
  writeFileSync(join(tmp, ".git", "HEAD"), "ref: refs/heads/main\n");
}

describe("runDoctor — base shape", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "df-doctor-test-"));
    setupFakeRepo(tmpRoot);
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("always emits node_version, artifact_dir_writable checks", async () => {
    const loaded = buildLoadedConfig({ repoRoot: tmpRoot });
    const { registry } = buildRegistry();
    const checks = await runDoctor({
      loaded,
      registry,
      profileName: "local",
    });
    const names = checks.map((c) => c.name);
    expect(names).toContain("node_version");
    expect(names).toContain("artifact_dir_writable");
    // SAGE-specific checks MUST be absent in the OSS doctor.
    expect(names).not.toContain("container_stack_status");
    expect(names).not.toContain("dist_up_to_date");
  });

  it("reports hooks_directory_exists=false when .husky is missing", async () => {
    const loaded = buildLoadedConfig({ repoRoot: tmpRoot });
    const { registry } = buildRegistry();
    const checks = await runDoctor({ loaded, registry });
    const hookDirCheck = checks.find(
      (c) => c.name === "hooks_directory_exists",
    );
    expect(hookDirCheck).toBeDefined();
    expect(hookDirCheck?.passed).toBe(false);
    expect(hookDirCheck?.detail).toContain("missing");
  });

  it("reports hooks_directory_exists=true when .husky is present", async () => {
    mkdirSync(join(tmpRoot, ".husky"));
    const loaded = buildLoadedConfig({ repoRoot: tmpRoot });
    const { registry } = buildRegistry();
    const checks = await runDoctor({ loaded, registry });
    const hookDirCheck = checks.find(
      (c) => c.name === "hooks_directory_exists",
    );
    expect(hookDirCheck?.passed).toBe(true);
  });

  it("forwards adapter doctor() checks with prefixed names", async () => {
    const loaded = buildLoadedConfig({ repoRoot: tmpRoot });
    const { registry } = buildRegistry();
    const checks = await runDoctor({ loaded, registry });
    const adapterCheck = checks.find(
      (c) => c.name === "fake-critic.fake_credentials",
    );
    expect(adapterCheck).toBeDefined();
  });

  it("tags optional critics' checks with optional: true", async () => {
    const loaded = buildLoadedConfig({ repoRoot: tmpRoot });
    const { registry } = buildRegistry();
    const checks = await runDoctor({ loaded, registry });
    const adapterCheck = checks.find(
      (c) => c.name === "fake-critic.fake_credentials",
    );
    // The fake critic has `required: false` → its checks must carry
    // `optional: true` so doctor doesn't fail-closed on shadow-mode
    // missing auth.
    expect(adapterCheck?.optional).toBe(true);
  });
});

describe("runDoctor — subscription-auth verification (profile.auth)", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "df-doctor-test-"));
    setupFakeRepo(tmpRoot);
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("applies profile.auth to the critic seen by adapter.doctor()", async () => {
    const loaded = buildLoadedConfig({
      repoRoot: tmpRoot,
      profiles: {
        local: {
          criticIds: ["fake-critic"],
          quorum: 1,
          auth: { "fake-critic": "chatgpt" },
        },
      },
    });
    const { registry, fake } = buildRegistry();
    await runDoctor({
      loaded,
      registry,
      profileName: "local",
    });
    // The adapter's doctor() must have seen `critic.auth: "chatgpt"`.
    // This is the firewall against accidental API-key fallback — the
    // profile pins the auth source, and the adapter validates ONLY
    // that source.
    expect(fake.lastDoctorCriticAuth).toBe("chatgpt");
  });

  it("does NOT apply profile.auth when no profile name given", async () => {
    const loaded = buildLoadedConfig({
      repoRoot: tmpRoot,
      profiles: {
        local: {
          criticIds: ["fake-critic"],
          quorum: 1,
          auth: { "fake-critic": "chatgpt" },
        },
      },
    });
    const { registry, fake } = buildRegistry();
    // No profileName argument → resolvedProfile is undefined →
    // applyProfileAuth is a no-op → critic.auth stays undefined.
    await runDoctor({ loaded, registry });
    expect(fake.lastDoctorCriticAuth).toBeUndefined();
  });

  it("does NOT apply profile.auth when the config has no profiles map", async () => {
    const loaded = buildLoadedConfig({ repoRoot: tmpRoot });
    const { registry, fake } = buildRegistry();
    await runDoctor({
      loaded,
      registry,
      profileName: "local",
    });
    // No profiles map → resolvedProfile is undefined → no auth pinning.
    expect(fake.lastDoctorCriticAuth).toBeUndefined();
  });
});
