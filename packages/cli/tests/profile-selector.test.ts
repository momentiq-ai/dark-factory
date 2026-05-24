// Cycle 322.7 Phase B — Profile selector tests.
//
// `resolveProfile()` is the precedence resolver. The contract:
//   - `--profile <name>` CLI flag wins.
//   - `AGENT_REVIEW_PROFILE` env var wins next.
//   - Default is `"local"` (the local pre-push posture).
// The result is a string; profile name *existence* in the config is
// validated at runtime by the runner (a non-existent profile name is
// a startup error there, not a selector error — the selector just
// tells you what the user asked for).
//
// `resolveProfileWithConfig()` is the runner-side composite that
// applies the resolved profile against the loaded config: it returns
// `{ profileName, profile, criticIds, quorum }` when a profile is
// active, or `{ profileName: <resolved>, profile: undefined, ... }`
// in the no-profiles back-compat path. A non-existent profile name
// when `profiles` is set is a hard error.


import { describe, it, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  expect_eq,
  expect_ne,
  expect_deep,
  expect_match,
  expect_no_match,
  expect_truthy,
  expect_throws,
  expect_rejects,
} from "./_assert-shim.js";
import { resolveProfile, resolveProfileWithConfig } from "../src/policy/profile.js";
import { parseAgentReviewConfig, type AgentReviewConfig } from "@momentiq/dark-factory-schemas";

// ---------------------------------------------------------------------------
// resolveProfile() — precedence rules

test("resolveProfile: flag wins over env (precedence flag > env)", () => {
  const profile = resolveProfile(
    { profile: "cloud" },
    { AGENT_REVIEW_PROFILE: "local" },
  );
  expect_eq(profile, "cloud");
});

test("resolveProfile: env wins over default (precedence env > default)", () => {
  const profile = resolveProfile({}, { AGENT_REVIEW_PROFILE: "cloud" });
  expect_eq(profile, "cloud");
});

test("resolveProfile: default is 'local' when no flag or env", () => {
  const profile = resolveProfile({}, {});
  expect_eq(profile, "local");
});

test("resolveProfile: flag wins even when env is also set", () => {
  const profile = resolveProfile(
    { profile: "ci-replay" },
    { AGENT_REVIEW_PROFILE: "cloud" },
  );
  expect_eq(profile, "ci-replay");
});

test("resolveProfile: empty string flag falls through to env", () => {
  // A bare `--profile` with no value should not paint over the env.
  // The argv parser sets it to `true` (boolean), so we treat empty
  // string and boolean defensively.
  const profile = resolveProfile(
    { profile: "" },
    { AGENT_REVIEW_PROFILE: "cloud" },
  );
  expect_eq(profile, "cloud");
});

test("resolveProfile: boolean true flag (--profile with no value) falls through to env", () => {
  const profile = resolveProfile(
    { profile: true },
    { AGENT_REVIEW_PROFILE: "cloud" },
  );
  expect_eq(profile, "cloud");
});

test("resolveProfile: empty env var falls through to default", () => {
  const profile = resolveProfile({}, { AGENT_REVIEW_PROFILE: "" });
  expect_eq(profile, "local");
});

test("resolveProfile: env var is undefined → default 'local'", () => {
  // Node.js process.env returns undefined for unset vars (string|undefined),
  // so the function must handle that.
  const profile = resolveProfile({}, {});
  expect_eq(profile, "local");
});

test("resolveProfile: flag value is trimmed of whitespace", () => {
  // Defensive: shell quoting can leak whitespace.
  const profile = resolveProfile({ profile: "  cloud  " }, {});
  expect_eq(profile, "cloud");
});

test("resolveProfile: env value is trimmed of whitespace", () => {
  const profile = resolveProfile({}, { AGENT_REVIEW_PROFILE: "  cloud  " });
  expect_eq(profile, "cloud");
});

// ---------------------------------------------------------------------------
// resolveProfileWithConfig() — applies selector against the loaded config.

const BASE_CONFIG_RAW = {
  version: 2,
  critics: [
    {
      id: "cursor-local-chief-engineer",
      name: "Cursor",
      adapter: "cursor-sdk",
      required: false,
      runtime: "local",
      model: { id: "composer-2", params: [] },
    },
    {
      id: "gemini-local-chief-engineer",
      name: "Gemini",
      adapter: "gemini-sdk",
      required: false,
      runtime: "local",
      model: { id: "gemini-2.5-pro", params: [] },
    },
    {
      id: "grok-local-chief-engineer",
      name: "Grok",
      adapter: "grok-direct-sdk",
      required: false,
      runtime: "local",
      model: { id: "grok-4.3", params: [] },
    },
  ],
  aggregation: {
    policy: "min-complete-quorum",
    blockingSeverities: ["blocker", "high"],
    quorum: 2,
  },
  git: { hookPath: ".husky", artifactDir: "agent-reviews", artifactScope: "git-common-dir" },
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
  security: { redactSecretsInDiagnostics: true, treatDiffAsUntrustedInput: true },
};

function configWith(profiles: Record<string, { criticIds: string[]; quorum: number }> | undefined): AgentReviewConfig {
  const raw = profiles
    ? { ...BASE_CONFIG_RAW, profiles }
    : BASE_CONFIG_RAW;
  return parseAgentReviewConfig(raw);
}

test("resolveProfileWithConfig: no profiles in config → no-filter back-compat (profile undefined)", () => {
  const cfg = configWith(undefined);
  const result = resolveProfileWithConfig(cfg, "local");
  expect_eq(result.profileName, "local");
  expect_eq(result.profile, undefined);
  expect_eq(result.criticIds, undefined);
  expect_eq(result.quorum, undefined);
});

test("resolveProfileWithConfig: profiles in config + matching profile name → filtered + quorum override", () => {
  const cfg = configWith({
    local: {
      criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
      quorum: 1,
    },
    cloud: {
      criticIds: [
        "cursor-local-chief-engineer",
        "gemini-local-chief-engineer",
        "grok-local-chief-engineer",
      ],
      quorum: 2,
    },
  });
  const result = resolveProfileWithConfig(cfg, "local");
  expect_eq(result.profileName, "local");
  expect_deep(result.profile, {
    criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
    quorum: 1,
  });
  expect_deep(result.criticIds, [
    "cursor-local-chief-engineer",
    "gemini-local-chief-engineer",
  ]);
  expect_eq(result.quorum, 1);
});

test("resolveProfileWithConfig: cloud profile selects all 3 critics with quorum=2", () => {
  const cfg = configWith({
    local: {
      criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
      quorum: 1,
    },
    cloud: {
      criticIds: [
        "cursor-local-chief-engineer",
        "gemini-local-chief-engineer",
        "grok-local-chief-engineer",
      ],
      quorum: 2,
    },
  });
  const result = resolveProfileWithConfig(cfg, "cloud");
  expect_eq(result.profileName, "cloud");
  expect_eq(result.criticIds?.length, 3);
  expect_eq(result.quorum, 2);
});

test("resolveProfileWithConfig: profiles in config + non-existent profile name → throws clear error", () => {
  const cfg = configWith({
    local: {
      criticIds: ["cursor-local-chief-engineer"],
      quorum: 1,
    },
  });
  expect_throws(
    () => resolveProfileWithConfig(cfg, "cloud"),
    /unknown profile|profile.*not found|available profiles/i,
  );
});

test("resolveProfileWithConfig: profiles in config + non-existent profile → error lists available profiles", () => {
  const cfg = configWith({
    local: { criticIds: ["cursor-local-chief-engineer"], quorum: 1 },
    cloud: {
      criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
      quorum: 2,
    },
  });
  expect_throws(() => resolveProfileWithConfig(cfg, "ci-replay"), /local.*cloud|cloud.*local/i);
});

test("resolveProfileWithConfig: no profiles + arbitrary profile name → back-compat no-filter (informational name)", () => {
  // Phase B back-compat: if the config has no `profiles` map, the
  // profile name from --profile/env is informational only. The runner
  // uses the full critic set.
  const cfg = configWith(undefined);
  const result = resolveProfileWithConfig(cfg, "ci-replay");
  expect_eq(result.profileName, "ci-replay");
  expect_eq(result.profile, undefined);
});
