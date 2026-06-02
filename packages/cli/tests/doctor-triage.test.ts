// Issue #51 — `df doctor` 3-state triage classification.
//
// `classifyDoctorState` is the pure helper behind the top-level
// triage line `cmdDoctor` prints BEFORE the per-critic INFO output.
// It distinguishes three states so an operator sees the headline
// failure mode immediately rather than parsing the per-critic block:
//
//   1. "config_missing" — config has no `profiles` block OR the
//      requested profile name is missing from `profiles`.
//   2. "auth_pending" — config + named profile are OK, but the
//      per-critic doctor() checks include unmet auth (no env var,
//      no subscription auth, etc.).
//   3. "ok" — config + named profile both OK AND all required
//      critics have their auth in place.
//
// The classifier is pure: takes only the loaded config + resolved
// profile name + the per-critic DoctorChecks already collected by
// `runDoctor`. No I/O, no env reads, no time dependence.

import { describe, it, expect } from "vitest";
import { classifyDoctorState } from "../src/doctor.js";
import type {
  AgentReviewConfig,
  CriticConfig,
  DoctorCheck,
  ProfileConfig,
} from "@momentiq/dark-factory-schemas";

function critic(overrides: Partial<CriticConfig> = {}): CriticConfig {
  return {
    id: "cursor-local",
    name: "Cursor Local Critic",
    adapter: "cursor-sdk",
    required: false,
    runtime: "local",
    model: { id: "composer-2.5", params: [] },
    ...overrides,
  };
}

function buildConfig(opts: {
  profiles?: AgentReviewConfig["profiles"];
  critics?: CriticConfig[];
} = {}): AgentReviewConfig {
  return {
    version: 2,
    critics: opts.critics ?? [critic()],
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
}

function passingCheck(name: string): DoctorCheck {
  return { name, passed: true, detail: "ok" };
}

function failingCheck(name: string, detail: string): DoctorCheck {
  return { name, passed: false, detail, remediation: "fix it" };
}

const PROFILES_OK: { [name: string]: ProfileConfig } = {
  local: {
    criticIds: ["cursor-local"],
    quorum: 1,
  },
};

describe("classifyDoctorState — config_missing", () => {
  it("returns 'config_missing' when config has no profiles block at all", () => {
    const state = classifyDoctorState({
      config: buildConfig({}),
      profileName: "local",
      perCriticChecks: [passingCheck("cursor-local.cursor_api_key")],
    });
    expect(state.state).toBe("config_missing");
    expect(state.line).toMatch(/config_missing|profiles block missing/);
    // Surfaces the named profile so the operator sees what the
    // CLI was looking for.
    expect(state.line).toMatch(/local/);
  });

  it("returns 'config_missing' when named profile is absent from profiles map", () => {
    const state = classifyDoctorState({
      config: buildConfig({
        profiles: { cloud: { criticIds: ["cursor-local"], quorum: 1 } },
      }),
      profileName: "local",
      perCriticChecks: [passingCheck("cursor-local.cursor_api_key")],
    });
    expect(state.state).toBe("config_missing");
    // The diagnostic surfaces both the requested name AND what's available.
    expect(state.line).toMatch(/local/);
    expect(state.line).toMatch(/cloud/);
  });

  it("'config_missing' takes precedence over per-critic auth failures", () => {
    // When the profile is missing, the per-critic auth check is moot —
    // the missing profile is the more actionable diagnosis.
    const state = classifyDoctorState({
      config: buildConfig({}),
      profileName: "local",
      perCriticChecks: [
        failingCheck("cursor-local.cursor_api_key", "CURSOR_API_KEY missing"),
      ],
    });
    expect(state.state).toBe("config_missing");
  });
});

describe("classifyDoctorState — auth_pending", () => {
  it("returns 'auth_pending' when config is valid but a critic's auth check failed", () => {
    const state = classifyDoctorState({
      config: buildConfig({ profiles: PROFILES_OK }),
      profileName: "local",
      perCriticChecks: [
        failingCheck("cursor-local.cursor_api_key", "CURSOR_API_KEY missing"),
      ],
    });
    expect(state.state).toBe("auth_pending");
    expect(state.line).toMatch(/auth_pending|workstation auth pending/);
  });

  it("auth_pending names the critic that failed so the operator can act", () => {
    const state = classifyDoctorState({
      config: buildConfig({ profiles: PROFILES_OK }),
      profileName: "local",
      perCriticChecks: [
        failingCheck("cursor-local.cursor_api_key", "CURSOR_API_KEY missing"),
      ],
    });
    expect(state.line).toMatch(/cursor-local/);
  });

  it("auth_pending ignores OPTIONAL critic auth failures (shadow mode)", () => {
    // Optional critics are tagged `optional: true` by runDoctor.
    // A failure on an optional critic must NOT downgrade the state
    // to auth_pending — shadow-mode critics are allowed to be unconfigured.
    const optionalFail: DoctorCheck = {
      name: "shadow-critic.api_key",
      passed: false,
      detail: "key missing",
      remediation: "set it",
      optional: true,
    };
    const state = classifyDoctorState({
      config: buildConfig({ profiles: PROFILES_OK }),
      profileName: "local",
      perCriticChecks: [
        passingCheck("cursor-local.cursor_api_key"),
        optionalFail,
      ],
    });
    expect(state.state).toBe("ok");
  });

  it("auth_pending ignores non-critic infra checks (node, hooks, doppler)", () => {
    // Only checks namespaced under `<criticId>.<probe>` count as
    // auth checks — base infra checks live alongside but are not
    // auth signals.
    const state = classifyDoctorState({
      config: buildConfig({ profiles: PROFILES_OK }),
      profileName: "local",
      perCriticChecks: [
        failingCheck("node_version", "node 18"),
        failingCheck("hook_post-commit", "missing"),
        passingCheck("cursor-local.cursor_api_key"),
      ],
    });
    expect(state.state).toBe("ok");
  });
});

describe("classifyDoctorState — ok", () => {
  it("returns 'ok' when profile is present and all required critic auths pass", () => {
    const state = classifyDoctorState({
      config: buildConfig({ profiles: PROFILES_OK }),
      profileName: "local",
      perCriticChecks: [passingCheck("cursor-local.cursor_api_key")],
    });
    expect(state.state).toBe("ok");
    expect(state.line).toMatch(/config \+ auth both OK|ok\b/i);
  });

  it("returns 'ok' when no profile name is given but config has no profiles map (back-compat)", () => {
    // No-profiles configs are allowed (back-compat). The headline
    // state for them is "ok" — there's nothing to triage.
    const state = classifyDoctorState({
      config: buildConfig({}),
      profileName: undefined,
      perCriticChecks: [passingCheck("cursor-local.cursor_api_key")],
    });
    expect(state.state).toBe("ok");
  });
});

describe("classifyDoctorState — output format", () => {
  it("returns a single-line headline (no embedded newlines)", () => {
    const state = classifyDoctorState({
      config: buildConfig({ profiles: PROFILES_OK }),
      profileName: "local",
      perCriticChecks: [passingCheck("cursor-local.cursor_api_key")],
    });
    expect(state.line.includes("\n")).toBe(false);
  });

  it("includes a [STATE-PREFIX] tag so the line is greppable", () => {
    const state = classifyDoctorState({
      config: buildConfig({}),
      profileName: "local",
      perCriticChecks: [],
    });
    // The bracketed tag distinguishes the headline from the
    // per-check `[OK]/[INFO]/[FAIL]` lines that follow.
    expect(state.line).toMatch(/^\[/);
  });
});
