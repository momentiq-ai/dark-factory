// Cycle 322.7 Phase B — Profile schema validation tests.
//
// `ProfileConfig` lets the same config drive multiple aggregation
// envelopes (local pre-push vs. cloud canonical gate) by mapping a
// profile name → { criticIds, quorum }. The schema validation lives
// in `parseAgentReviewConfig` and enforces:
//
//   1. Each `criticId` in a profile references a real critic in
//      `critics[]` — typos fail at config load time.
//   2. `quorum` is bounded: `1 <= quorum <= criticIds.length`.
//      (Profile quorum can be 1 unlike root `aggregation.quorum`
//      which must be >= 2 — the local profile's 1-of-2 posture is the
//      whole point of Cycle 322.7.)
//   3. A config with `profiles` may omit a root `aggregation.quorum`
//      (each profile carries its own). The runner uses the selected
//      profile's quorum at runtime.
//   4. Safety invariant (Codex P1 on PR #1456): a config with
//      `aggregation.policy: "block-if-any"` AND zero `required: true`
//      critics is rejected at load time with a clear error pointing
//      at the missing required-flag. Under `block-if-any`,
//      `gate.ts:evaluateCommitGate` only blocks pushes on required
//      critics; a `block-if-any` config with all `required: false`
//      critics would silently downgrade blocker findings to warnings.


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
import {
  parseAgentReviewConfig,
  SchemaError,
} from "@momentiq/dark-factory-schemas";

// Base config with TWO critics so quorum tests have a meaningful range.
// `profiles` is intentionally absent — individual tests add it.
const BASE_CONFIG = {
  version: 2,
  critics: [
    {
      id: "cursor-local-chief-engineer",
      name: "Cursor",
      adapter: "cursor-sdk",
      required: true, // required for block-if-any safety invariant baseline
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
  ],
  aggregation: {
    policy: "block-if-any",
    blockingSeverities: ["blocker", "high"],
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

// ---------------------------------------------------------------------------
// (1) Backward compatibility: a config WITHOUT `profiles` continues to parse.

test("parseAgentReviewConfig: config without profiles parses cleanly (back-compat)", () => {
  const cfg = parseAgentReviewConfig(BASE_CONFIG);
  expect_eq(cfg.profiles, undefined);
});

// ---------------------------------------------------------------------------
// (2) Happy path: a config WITH valid profiles parses cleanly.

test("parseAgentReviewConfig: valid profiles parse with criticIds + quorum", () => {
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    profiles: {
      local: { criticIds: ["cursor-local-chief-engineer"], quorum: 1 },
      cloud: {
        criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
        quorum: 2,
      },
    },
  });
  expect_truthy(cfg.profiles, "profiles should be parsed");
  expect_deep(cfg.profiles!["local"], {
    criticIds: ["cursor-local-chief-engineer"],
    quorum: 1,
  });
  expect_deep(cfg.profiles!["cloud"], {
    criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
    quorum: 2,
  });
});

// ---------------------------------------------------------------------------
// (3) Reference integrity: each profile criticId must exist in `critics[]`.

test("parseAgentReviewConfig: profile referencing unknown criticId rejects", () => {
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: {
        criticIds: ["cursor-local-chief-engineer", "nonexistent-critic"],
        quorum: 1,
      },
    },
  };
  expect_throws(
    () => parseAgentReviewConfig(bad),
    /nonexistent-critic|unknown.*critic/i,
  );
});

test("parseAgentReviewConfig: profile referencing only unknown criticIds rejects", () => {
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: { criticIds: ["typo-critic"], quorum: 1 },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), SchemaError);
});

// ---------------------------------------------------------------------------
// (4) Quorum bounds: 1 <= quorum <= criticIds.length.

test("parseAgentReviewConfig: profile quorum < 1 rejects", () => {
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: { criticIds: ["cursor-local-chief-engineer"], quorum: 0 },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /quorum/i);
});

test("parseAgentReviewConfig: profile quorum > criticIds.length rejects", () => {
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: {
        criticIds: ["cursor-local-chief-engineer"],
        quorum: 2, // criticIds.length is 1
      },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /quorum.*exceeds|criticIds/i);
});

test("parseAgentReviewConfig: profile quorum=1 is allowed (local 1-of-N posture)", () => {
  // This is the whole point of the local profile: 1-of-2 critics is fine,
  // whereas root `aggregation.quorum` requires >= 2.
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    profiles: {
      local: {
        criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
        quorum: 1,
      },
    },
  });
  expect_eq(cfg.profiles!["local"]!.quorum, 1);
});

test("parseAgentReviewConfig: profile quorum must be integer (rejects 1.5)", () => {
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: { criticIds: ["cursor-local-chief-engineer"], quorum: 1.5 },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /quorum/i);
});

// ---------------------------------------------------------------------------
// (5) Schema shape: criticIds must be non-empty string array.

test("parseAgentReviewConfig: profile with empty criticIds rejects", () => {
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: { criticIds: [], quorum: 1 },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /criticIds/i);
});

test("parseAgentReviewConfig: profile with non-string criticId rejects", () => {
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: { criticIds: [42 as unknown as string], quorum: 1 },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), SchemaError);
});

test("parseAgentReviewConfig: profile with duplicate criticIds rejects", () => {
  // Duplicates would silently double-count toward quorum — a foot-gun.
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: {
        criticIds: [
          "cursor-local-chief-engineer",
          "cursor-local-chief-engineer",
        ],
        quorum: 1,
      },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /duplicate/i);
});

// ---------------------------------------------------------------------------
// (6) Profiles object shape: keys are profile names, values are ProfileConfig.

test("parseAgentReviewConfig: profiles with non-object value rejects", () => {
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: "should-be-object" as unknown as { criticIds: string[]; quorum: number },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), SchemaError);
});

test("parseAgentReviewConfig: profile missing criticIds rejects", () => {
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: { quorum: 1 } as unknown as { criticIds: string[]; quorum: number },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /criticIds/i);
});

test("parseAgentReviewConfig: profile missing quorum rejects", () => {
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: { criticIds: ["cursor-local-chief-engineer"] } as unknown as {
        criticIds: string[];
        quorum: number;
      },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /quorum/i);
});

// ---------------------------------------------------------------------------
// (7) Profiles can coexist with `aggregation.quorum` (each profile overrides
//     at runtime; the root quorum still has to be valid for the policy).

test("parseAgentReviewConfig: profiles + root quorum (min-complete-quorum) parses cleanly", () => {
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    aggregation: {
      policy: "min-complete-quorum",
      blockingSeverities: ["blocker", "high"],
      quorum: 2,
    },
    profiles: {
      local: {
        criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
        quorum: 1,
      },
    },
  });
  expect_eq(cfg.aggregation.quorum, 2);
  expect_eq(cfg.profiles!["local"]!.quorum, 1);
});

test("parseAgentReviewConfig: profiles without root quorum on block-if-any parses cleanly (back-compat)", () => {
  // block-if-any has no root quorum, so the profile-only config makes sense.
  // (Each profile still carries its own quorum, used at runtime by the runner.)
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    profiles: {
      local: { criticIds: ["cursor-local-chief-engineer"], quorum: 1 },
    },
  });
  expect_eq(cfg.aggregation.policy, "block-if-any");
  expect_eq(cfg.profiles!["local"]!.quorum, 1);
});

// ---------------------------------------------------------------------------
// (8) Safety invariant — Codex P1 on PR #1456.
//
// A config with `aggregation.policy: "block-if-any"` MUST have at least
// one critic with `required: true`. Without that, `gate.ts:evaluateCommitGate`
// would silently downgrade blocker findings to warnings (since
// `evaluateCriticResults` only blocks on critics in the required set).
//
// The validation happens at the AgentReviewConfig level — BEFORE profile
// selection — because the on-disk config can't depend on runtime profile
// choice. We validate the full `critics[]` list.

test("parseAgentReviewConfig: block-if-any policy with zero required critics REJECTS (safety invariant)", () => {
  const bad = {
    ...BASE_CONFIG,
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
    ],
    aggregation: {
      policy: "block-if-any",
      blockingSeverities: ["blocker", "high"],
    },
  };
  expect_throws(
    () => parseAgentReviewConfig(bad),
    /block-if-any.*required|required.*block-if-any/i,
  );
});

test("parseAgentReviewConfig: block-if-any policy with at least one required critic parses cleanly (safety invariant satisfied)", () => {
  // BASE_CONFIG already has cursor-local-chief-engineer: required:true and
  // policy: block-if-any. This must parse cleanly — it's the steady state
  // on main as of Cycle 322.7 Phase D.
  const cfg = parseAgentReviewConfig(BASE_CONFIG);
  expect_eq(cfg.aggregation.policy, "block-if-any");
  const requiredCritics = cfg.critics.filter((c) => c.required);
  expect_eq(requiredCritics.length, 1, "BASE_CONFIG has 1 required critic");
});

test("parseAgentReviewConfig: min-complete-quorum policy with zero required critics is FINE (safety invariant does NOT apply)", () => {
  // The safety invariant is specifically about block-if-any. Under
  // min-complete-quorum the `required` flag is semantically irrelevant
  // (per gate.ts:160-167) — quorum is what gates the push, and every
  // critic contributes via §11 veto-preserves-quorum. This config matches
  // the 322.3.1 steady state on main today.
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
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
    ],
    aggregation: {
      policy: "min-complete-quorum",
      blockingSeverities: ["blocker", "high"],
      quorum: 2,
    },
  });
  expect_eq(cfg.aggregation.policy, "min-complete-quorum");
  expect_eq(cfg.critics.filter((c) => c.required).length, 0);
});

// ---------------------------------------------------------------------------
// (9) The current production .agent-review/config.json (post-322.3.1) loads.
//     Sanity check: this is what's on main; our changes must not regress it.

test("parseAgentReviewConfig: post-322.3.1 main config shape (min-complete-quorum, quorum=2, zero required) parses", () => {
  // Replicates the live config shape: 3-critic min-complete-quorum with
  // quorum=2 and all critics required: false. Under min-complete-quorum
  // the safety invariant does not apply.
  const cfg = parseAgentReviewConfig({
    version: 2,
    critics: [
      {
        id: "cursor-local-chief-engineer",
        name: "Cursor",
        adapter: "cursor-sdk",
        required: false,
        runtime: "local",
        model: { id: "composer-2", params: [{ id: "fast", value: "false" }] },
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
        model: { id: "grok-4.3", params: [{ id: "reasoning_effort", value: "high" }] },
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
        productionGlobs: ["backend/**/*.py"],
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
  });
  expect_eq(cfg.aggregation.policy, "min-complete-quorum");
  expect_eq(cfg.aggregation.quorum, 2);
  expect_eq(cfg.critics.length, 3);
});

// ---------------------------------------------------------------------------
// (10) Edge cases — combined validation paths.

test("parseAgentReviewConfig: profile referencing valid + duplicate (later) criticId still flags duplicate FIRST", () => {
  // The duplicate check runs BEFORE the reference-integrity check.
  // Both would fail; the error message should mention duplicates.
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      local: {
        criticIds: [
          "cursor-local-chief-engineer",
          "cursor-local-chief-engineer", // duplicate
          "unknown-critic", // also invalid
        ],
        quorum: 1,
      },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /duplicate/i);
});

test("parseAgentReviewConfig: profile with criticIds = full critic list (no narrowing) still parses", () => {
  // A profile that includes every critic is legitimate — used when the
  // only difference between profiles is quorum threshold.
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    profiles: {
      cloud: {
        criticIds: BASE_CONFIG.critics.map((c) => c.id),
        quorum: 2,
      },
    },
  });
  expect_eq(cfg.profiles!["cloud"]!.criticIds.length, BASE_CONFIG.critics.length);
});

test("parseAgentReviewConfig: profile with quorum equal to criticIds length (unanimous) parses", () => {
  // quorum === criticIds.length is the strictest setting: every critic
  // must complete to clear the quorum check. Legitimate for high-risk
  // surfaces.
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    profiles: {
      strict: {
        criticIds: [
          "cursor-local-chief-engineer",
          "gemini-local-chief-engineer",
        ],
        quorum: 2,
      },
    },
  });
  expect_eq(cfg.profiles!["strict"]!.quorum, 2);
});

test("parseAgentReviewConfig: multiple profiles can share criticIds", () => {
  // Two profiles that differ only in quorum threshold (e.g., a
  // graduated-strictness pattern) must parse cleanly.
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    profiles: {
      relaxed: {
        criticIds: [
          "cursor-local-chief-engineer",
          "gemini-local-chief-engineer",
        ],
        quorum: 1,
      },
      strict: {
        criticIds: [
          "cursor-local-chief-engineer",
          "gemini-local-chief-engineer",
        ],
        quorum: 2,
      },
    },
  });
  expect_eq(cfg.profiles!["relaxed"]!.quorum, 1);
  expect_eq(cfg.profiles!["strict"]!.quorum, 2);
});

test("parseAgentReviewConfig: empty profiles map ({}) parses cleanly (no profiles defined)", () => {
  // Edge case: someone could declare `profiles: {}` in config. The
  // resulting parsed config has profiles as an empty object — the
  // runner's no-match path will treat any --profile flag as unknown.
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    profiles: {},
  });
  expect_deep(cfg.profiles, {});
});

// ---------------------------------------------------------------------------
// (11) Block-if-any narrowing safety: every profile under block-if-any must
//     include at least one required critic. Cursor critic finding on PR #1467
//     caught this gap — a profile that excludes the only required critic
//     under block-if-any would yield the same unsafe runtime state that the
//     full-list invariant guards against.

test("parseAgentReviewConfig: block-if-any + profile excludes ALL required critics REJECTS", () => {
  // BASE_CONFIG has cursor-local-chief-engineer: required:true.
  // A profile that selects only gemini (required:false) would narrow
  // the runtime gate set to all-optional, defeating block-if-any.
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      "all-optional": {
        criticIds: ["gemini-local-chief-engineer"],
        quorum: 1,
      },
    },
  };
  expect_throws(
    () => parseAgentReviewConfig(bad),
    /block-if-any.*all-optional|narrow.*all-optional|required.*optional subset/i,
  );
});

test("parseAgentReviewConfig: block-if-any + profile includes the required critic parses cleanly", () => {
  // Symmetric case: the local profile retains cursor (required:true),
  // so block-if-any safety is preserved under the profile.
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    profiles: {
      local: {
        criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
        quorum: 1,
      },
    },
  });
  expect_eq(cfg.profiles!["local"]!.criticIds.length, 2);
});

test("parseAgentReviewConfig: block-if-any + multiple profiles where ONE excludes required REJECTS that profile by name", () => {
  // Diagnostic clarity: the error message names which profile is unsafe.
  const bad = {
    ...BASE_CONFIG,
    profiles: {
      safe: {
        criticIds: ["cursor-local-chief-engineer"],
        quorum: 1,
      },
      "unsafe-profile": {
        criticIds: ["gemini-local-chief-engineer"],
        quorum: 1,
      },
    },
  };
  expect_throws(() => parseAgentReviewConfig(bad), /unsafe-profile/);
});

test("parseAgentReviewConfig: error message enumerates profile names in sorted order (determinism)", () => {
  // Cursor medium finding on Phase B commit: Object.entries() enumeration
  // order varies across engines and config shapes. The validator must
  // sort profile names so multi-profile violations always report the
  // alphabetically-first violator. This test pins that contract.
  //
  // Both "alpha-bad" and "zeta-bad" violate the invariant; the first
  // throw should always reference "alpha-bad", regardless of how the
  // object literal was constructed.
  const bad = {
    ...BASE_CONFIG,
    // Note: declared in z→a order on purpose to defeat any
    // insertion-order matching.
    profiles: {
      "zeta-bad": {
        criticIds: ["gemini-local-chief-engineer"],
        quorum: 1,
      },
      "alpha-bad": {
        criticIds: ["gemini-local-chief-engineer"],
        quorum: 1,
      },
    },
  };
  try {
    parseAgentReviewConfig(bad);
    assert.fail("expected SchemaError");
  } catch (err) {
    const msg = (err as Error).message;
    // Should mention the alphabetically-first violator.
    expect_match(msg, /alpha-bad/);
    // Should NOT short-circuit to zeta-bad first.
    const alphaIdx = msg.indexOf("alpha-bad");
    const zetaIdx = msg.indexOf("zeta-bad");
    if (zetaIdx !== -1) {
      expect_truthy(
        alphaIdx < zetaIdx,
        "alpha-bad should appear BEFORE zeta-bad in the error message",
      );
    }
  }
});

test("parseAgentReviewConfig: required-critic ids in error message are sorted (determinism)", () => {
  // Required critic ids in the "Include at least one of: ..." remediation
  // must also be sorted. Pin the contract with a config that has multiple
  // required critics and one unsafe profile.
  const bad = {
    version: 2,
    critics: [
      {
        // Listed in z→a order to defeat insertion-order accidents.
        id: "zoom-required",
        name: "Zoom",
        adapter: "cursor-sdk",
        required: true,
        runtime: "local",
        model: { id: "composer-2", params: [] },
      },
      {
        id: "alpha-required",
        name: "Alpha",
        adapter: "cursor-sdk",
        required: true,
        runtime: "local",
        model: { id: "composer-2", params: [] },
      },
      {
        id: "middle-optional",
        name: "Middle",
        adapter: "gemini-sdk",
        required: false,
        runtime: "local",
        model: { id: "gemini-2.5-pro", params: [] },
      },
    ],
    aggregation: {
      policy: "block-if-any",
      blockingSeverities: ["blocker", "high"],
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
    profiles: {
      unsafe: {
        criticIds: ["middle-optional"],
        quorum: 1,
      },
    },
  };
  try {
    parseAgentReviewConfig(bad);
    assert.fail("expected SchemaError");
  } catch (err) {
    const msg = (err as Error).message;
    // Required ids in "Include at least one of: ..." should be sorted.
    const alphaIdx = msg.indexOf("alpha-required");
    const zoomIdx = msg.indexOf("zoom-required");
    expect_truthy(alphaIdx !== -1 && zoomIdx !== -1, "both required ids should appear");
    expect_truthy(
      alphaIdx < zoomIdx,
      "alpha-required must appear BEFORE zoom-required in the remediation list",
    );
  }
});

test("parseAgentReviewConfig: min-complete-quorum + profile excludes ALL required critics is FINE (block-if-any check does NOT apply)", () => {
  // Under min-complete-quorum, the `required` flag is semantically
  // irrelevant. A profile that narrows to all-optional is perfectly
  // safe because every critic contributes to the quorum count and
  // §11 veto-preserves-quorum holds.
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    aggregation: {
      policy: "min-complete-quorum",
      blockingSeverities: ["blocker", "high"],
      quorum: 2,
    },
    profiles: {
      "all-optional": {
        criticIds: ["gemini-local-chief-engineer"],
        quorum: 1,
      },
    },
  });
  expect_eq(cfg.aggregation.policy, "min-complete-quorum");
});

// ---------------------------------------------------------------------------
// Issue #2103 — profile auth pinning (parseProfileConfig + schema shape).
//
// `profile.auth` is a per-critic-id map of string values that adapters
// interpret. Schema enforces shape + cross-field rules (criticId MUST be
// in this profile's `criticIds[]`) and refuses empty strings; adapter
// vocabulary validation (which strings each adapter accepts) lives in
// the adapter, not here, so new critic families can ship without
// touching this parser.

test("parseAgentReviewConfig: profile.auth parses with valid criticId → string mapping", () => {
  // BASE_CONFIG has cursor + gemini. Auth-value strings are
  // adapter-vocabulary placeholders at the schema level (validation of
  // adapter-specific values like "chatgpt"/"api" lives in the adapter,
  // not here).
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    profiles: {
      local: {
        criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
        quorum: 1,
        auth: { "gemini-local-chief-engineer": "chatgpt" },
      },
      cloud: {
        criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
        quorum: 2,
        auth: { "gemini-local-chief-engineer": "api" },
      },
    },
  });
  expect_deep(cfg.profiles!["local"]!.auth, {
    "gemini-local-chief-engineer": "chatgpt",
  });
  expect_deep(cfg.profiles!["cloud"]!.auth, {
    "gemini-local-chief-engineer": "api",
  });
});

test("parseAgentReviewConfig: profile.auth absent parses cleanly (back-compat / no pin)", () => {
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    profiles: {
      local: {
        criticIds: ["cursor-local-chief-engineer"],
        quorum: 1,
      },
    },
  });
  expect_eq(cfg.profiles!["local"]!.auth, undefined);
});

test("parseAgentReviewConfig: profile.auth referencing criticId not in criticIds[] REJECTS (foot-gun guard)", () => {
  // Mirrors the modelParamOverrides rule — pinning auth on an excluded
  // critic would silently no-op at runtime and mislead the operator
  // who's debugging "why didn't my pin take effect?"
  expect_throws(
    () =>
      parseAgentReviewConfig({
        ...BASE_CONFIG,
        profiles: {
          local: {
            criticIds: ["cursor-local-chief-engineer"],
            quorum: 1,
            auth: {
              "codex-local-chief-engineer": "chatgpt", // not in criticIds[]
            },
          },
        },
      }),
    /codex-local-chief-engineer.*not in this profile/i,
  );
});

test("parseAgentReviewConfig: profile.auth with empty string value REJECTS", () => {
  expect_throws(
    () =>
      parseAgentReviewConfig({
        ...BASE_CONFIG,
        profiles: {
          local: {
            criticIds: ["cursor-local-chief-engineer"],
            quorum: 1,
            auth: { "cursor-local-chief-engineer": "" },
          },
        },
      }),
    /non-empty string/i,
  );
});

test("parseAgentReviewConfig: profile.auth with non-string value REJECTS", () => {
  expect_throws(
    () =>
      parseAgentReviewConfig({
        ...BASE_CONFIG,
        profiles: {
          local: {
            criticIds: ["cursor-local-chief-engineer"],
            quorum: 1,
            auth: { "cursor-local-chief-engineer": 42 as unknown as string },
          },
        },
      }),
    /non-empty string/i,
  );
});

test("parseAgentReviewConfig: profile.auth with empty criticId key REJECTS", () => {
  expect_throws(
    () =>
      parseAgentReviewConfig({
        ...BASE_CONFIG,
        profiles: {
          local: {
            criticIds: ["cursor-local-chief-engineer"],
            quorum: 1,
            auth: { "": "chatgpt" },
          },
        },
      }),
    /non-empty/i,
  );
});

test("parseAgentReviewConfig: profile.auth side-by-side with modelParamOverrides parses cleanly", () => {
  // Both per-critic profile fields can coexist; this is the post-#2103
  // shape of the real .agent-review/config.json profiles. BASE_CONFIG
  // has cursor + gemini; gemini-sdk takes `reasoning_effort` so the
  // composition is realistic.
  const cfg = parseAgentReviewConfig({
    ...BASE_CONFIG,
    profiles: {
      local: {
        criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"],
        quorum: 1,
        modelParamOverrides: {
          "gemini-local-chief-engineer": { reasoning_effort: "high" },
        },
        auth: { "gemini-local-chief-engineer": "chatgpt" },
      },
    },
  });
  expect_deep(cfg.profiles!["local"]!.modelParamOverrides, {
    "gemini-local-chief-engineer": { reasoning_effort: "high" },
  });
  expect_deep(cfg.profiles!["local"]!.auth, {
    "gemini-local-chief-engineer": "chatgpt",
  });
});
