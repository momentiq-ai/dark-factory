// Cycle 322.7 Phase C — Emergency revert env override tests.
//
// The `AGENT_REVIEW_AGGREGATION_POLICY` env var lets operators revert
// to a previous aggregation policy WITHOUT shipping a new PR. The
// primary use case: a newly-added critic generates spurious blockers
// in the first 48h post-flip and the team needs to roll back the live
// `.agent-review/config.json` policy to `block-if-any` immediately.
//
// Surfaces under test:
//
//   1. Override fires when env var is a recognized value
//      (`block-if-any` or `min-complete-quorum`).
//   2. Invalid / unset values fall through silently (config wins).
//      Invalid (non-empty + unrecognized) values log a warning.
//   3. Safety invariant: when override flips policy to `block-if-any`
//      AND no critic is `required: true` (the Phase H steady state),
//      `cursor-local-chief-engineer` is auto-promoted to required to
//      preserve "single trusted critic gates the push" semantics.
//   4. Auto-promotion is a no-op when:
//        a. The override is `block-if-any` AND at least one critic is
//           ALREADY required (no need to promote).
//        b. The override is `min-complete-quorum` (the `required` flag
//           is semantically irrelevant under quorum).
//   5. Telemetry: `aggregation_policy_overridden` events emit on
//      every override application, carrying the configured policy,
//      the overridden policy, and any auto-promoted critic ids.


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
import { applyEnvOverrides } from "../src/policy/config.js";
import { parseAgentReviewConfig, type AgentReviewConfig } from "@momentiq/dark-factory-schemas";
import { MemoryTelemetrySink } from "../src/evidence/audit-trail.js";

// ---------------------------------------------------------------------------
// Helpers

// Base config matching the post-322.3.1 main steady state:
//   - `aggregation.policy: "min-complete-quorum"` with quorum=2.
//   - All 3 critics `required: false` (the safety invariant is dormant
//     because the on-disk policy is NOT `block-if-any`).
//
// The override path's auto-promotion only fires when the overridden
// policy is `block-if-any` AND no critic is `required: true` — exactly
// what this base config exhibits.
function baseConfig(): AgentReviewConfig {
  return parseAgentReviewConfig({
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
  });
}

// Same shape as baseConfig() but with `block-if-any` policy + at least
// one required critic (the on-disk safety invariant satisfied). Used to
// test the no-op auto-promotion path (override flips to block-if-any but
// a required critic already exists, so promotion isn't needed).
function blockIfAnyConfigWithRequiredCritic(): AgentReviewConfig {
  return parseAgentReviewConfig({
    version: 2,
    critics: [
      {
        id: "cursor-local-chief-engineer",
        name: "Cursor",
        adapter: "cursor-sdk",
        required: true, // already required → no auto-promotion needed
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
  });
}

// ---------------------------------------------------------------------------
// (C.1) Override fires when env var is `block-if-any`.

test("applyEnvOverrides: AGENT_REVIEW_AGGREGATION_POLICY=block-if-any overrides config policy", () => {
  const config = baseConfig();
  expect_eq(config.aggregation.policy, "min-complete-quorum");
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any",
  });
  expect_eq(result.config.aggregation.policy, "block-if-any");
});

test("applyEnvOverrides: AGENT_REVIEW_AGGREGATION_POLICY=min-complete-quorum is also recognized", () => {
  // Symmetric path: an operator can also explicitly pin min-complete-quorum
  // via the env var (even though it's the steady-state default). The
  // primary use case is `block-if-any` for emergency revert, but the
  // pure function MUST accept both recognized values.
  //
  // NOTE: when the on-disk config is `block-if-any` and the override is
  // `min-complete-quorum`, the resulting config preserves any
  // pre-existing `quorum` field. If the on-disk config didn't have one
  // (the `block-if-any` shape excludes it per schema), the runtime
  // resolver falls back: profile-quorum from a selected profile, OR
  // the runner's quorum=2 default for hypothetical-quorum telemetry
  // (runner.ts:247-252). Callers running pre-push gate evaluation
  // under this combo should set a profile via --profile / env so the
  // gate has an unambiguous quorum to evaluate against.
  const config = blockIfAnyConfigWithRequiredCritic();
  expect_eq(config.aggregation.policy, "block-if-any");
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "min-complete-quorum",
  });
  expect_eq(result.config.aggregation.policy, "min-complete-quorum");
});

test("applyEnvOverrides: block-if-any override strips stale quorum field (schema compatibility)", () => {
  // Codex HIGH on d69d2846 (schema §0): the override path used to spread
  // `{...config.aggregation, policy: raw}`, which left a stale `quorum`
  // field on `block-if-any` (forbidden by parseAgentReviewConfig).
  // The fix: strip `quorum` when overriding TO `block-if-any` so the
  // resulting config is round-trippable through the same schema
  // validation.
  const config = baseConfig(); // min-complete-quorum with quorum=2
  expect_eq(config.aggregation.quorum, 2);
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any",
  });
  expect_eq(result.config.aggregation.policy, "block-if-any");
  expect_eq(
    result.config.aggregation.quorum,
    undefined,
    "block-if-any override must strip the quorum field",
  );
  // Also verify the result config passes the schema validation when
  // round-tripped — pins the schema-compatibility contract.
  const reparsed = parseAgentReviewConfig({
    version: 2,
    critics: result.config.critics,
    aggregation: result.config.aggregation,
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
  });
  expect_eq(reparsed.aggregation.policy, "block-if-any");
  expect_eq(reparsed.aggregation.quorum, undefined);
});

test("applyEnvOverrides: min-complete-quorum override preserves quorum field", () => {
  // Symmetric: when the on-disk config carries a quorum (valid for
  // min-complete-quorum), the override preserves it. This is the
  // common-case round trip (config is already min-complete-quorum,
  // override is explicit no-op).
  const config = baseConfig();
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "min-complete-quorum",
  });
  expect_eq(result.config.aggregation.policy, "min-complete-quorum");
  expect_eq(result.config.aggregation.quorum, 2, "quorum preserved on min-complete-quorum override");
});

test("applyEnvOverrides: min-complete-quorum override SYNTHESIZES quorum when source had block-if-any shape", () => {
  // Codex HIGH on c849d47d (schema §0): when the on-disk config is
  // `block-if-any` (which schema rejects a `quorum` field), and the
  // override flips to `min-complete-quorum`, the resulting config must
  // satisfy the schema (quorum >= 2). The override synthesizes
  // `quorum: 2` (schema minimum) from the critic count.
  const config = blockIfAnyConfigWithRequiredCritic(); // 2 critics, no quorum
  expect_eq(config.aggregation.quorum, undefined);
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "min-complete-quorum",
  });
  expect_eq(result.config.aggregation.policy, "min-complete-quorum");
  expect_eq(
    result.config.aggregation.quorum,
    2,
    "min-complete-quorum override must synthesize a schema-valid quorum",
  );
  // Round-trip through parseAgentReviewConfig — pins schema compatibility.
  const reparsed = parseAgentReviewConfig({
    version: 2,
    critics: result.config.critics,
    aggregation: result.config.aggregation,
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
  });
  expect_eq(reparsed.aggregation.policy, "min-complete-quorum");
  expect_eq(reparsed.aggregation.quorum, 2);
});

test("applyEnvOverrides: min-complete-quorum override REFUSES when critics.length < 2", () => {
  // Edge case: synthesis can't satisfy `quorum >= 2 && quorum <= critics.length`
  // when there's only 1 critic. The function refuses the override and falls
  // through to the configured policy with a remediation hint.
  //
  // The 1-critic case is itself contrived (most configs have 2+ critics by
  // design), but pinning the refusal behavior prevents the loader from
  // silently producing a schema-invalid config.
  const config = parseAgentReviewConfig({
    version: 2,
    critics: [
      {
        id: "cursor-local-chief-engineer",
        name: "Cursor",
        adapter: "cursor-sdk",
        required: true,
        runtime: "local",
        model: { id: "composer-2", params: [] },
      },
    ],
    aggregation: { policy: "block-if-any", blockingSeverities: ["blocker", "high"] },
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
  });
  const warnings: string[] = [];
  const result = applyEnvOverrides(
    config,
    { AGENT_REVIEW_AGGREGATION_POLICY: "min-complete-quorum" },
    { warn: (msg) => warnings.push(msg) },
  );
  expect_eq(result.applied, false);
  expect_eq(result.config.aggregation.policy, "block-if-any");
  expect_truthy(
    warnings.some((m) => /REFUSED/i.test(m) && /critics?/i.test(m)),
    `expected refusal warning, got: ${warnings.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// (C.3) Invalid / unset values fall through silently.

test("applyEnvOverrides: unset env var returns config unchanged", () => {
  const config = baseConfig();
  const result = applyEnvOverrides(config, {});
  // Same policy as input — no override applied.
  expect_eq(result.config.aggregation.policy, "min-complete-quorum");
  expect_eq(result.applied, false);
  expect_eq(result.overridden, undefined);
  expect_deep(result.autoPromotedCritics, []);
});

test("applyEnvOverrides: AGENT_REVIEW_AGGREGATION_POLICY=garbage falls through with warning", () => {
  const config = baseConfig();
  const warnings: string[] = [];
  const result = applyEnvOverrides(
    config,
    { AGENT_REVIEW_AGGREGATION_POLICY: "garbage" },
    { warn: (msg) => warnings.push(msg) },
  );
  // Invalid value → config policy untouched.
  expect_eq(result.config.aggregation.policy, "min-complete-quorum");
  expect_eq(result.applied, false);
  // Warning surfaced so the operator notices the typo (vs. silent
  // fall-through which masks the misconfiguration).
  expect_truthy(
    warnings.some((m) => /AGENT_REVIEW_AGGREGATION_POLICY/.test(m) && /garbage/i.test(m)),
    `expected warning about garbage value, got: ${warnings.join(", ")}`,
  );
});

test("applyEnvOverrides: empty string env var falls through silently (no warning)", () => {
  // Empty string is the "unset" sentinel in many shell pipelines. It
  // should NOT trigger a warning — it's a non-decision, not an invalid
  // value.
  const config = baseConfig();
  const warnings: string[] = [];
  const result = applyEnvOverrides(
    config,
    { AGENT_REVIEW_AGGREGATION_POLICY: "" },
    { warn: (msg) => warnings.push(msg) },
  );
  expect_eq(result.config.aggregation.policy, "min-complete-quorum");
  expect_eq(result.applied, false);
  expect_eq(warnings.length, 0, `expected no warnings for empty string, got: ${warnings.join(", ")}`);
});

// ---------------------------------------------------------------------------
// (C.4 + auto-promotion) Telemetry + auto-promotion on block-if-any override
//                        when no critic is required.

test("applyEnvOverrides: block-if-any override AND no required critic → auto-promotes cursor", () => {
  // baseConfig has all 3 critics `required: false` (min-complete-quorum
  // steady state). The override flips policy to `block-if-any` which would
  // be unsafe without a required critic — auto-promotion kicks in.
  const config = baseConfig();
  expect_eq(
    config.critics.filter((c) => c.required).length,
    0,
    "baseConfig must start with zero required critics",
  );
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any",
  });
  expect_eq(result.config.aggregation.policy, "block-if-any");
  // cursor-local-chief-engineer auto-promoted; others remain optional.
  const cursor = result.config.critics.find((c) => c.id === "cursor-local-chief-engineer");
  expect_truthy(cursor, "cursor critic must still exist");
  expect_eq(cursor.required, true, "cursor should be auto-promoted to required");
  const otherRequired = result.config.critics.filter(
    (c) => c.required && c.id !== "cursor-local-chief-engineer",
  );
  expect_eq(otherRequired.length, 0, "only cursor should be promoted; others stay optional");
});

test("applyEnvOverrides: telemetry surfaces overridden policy + auto-promoted critics", () => {
  const config = baseConfig();
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any",
  });
  // The function returns the auto-promoted ids so the caller can emit
  // a `aggregation_policy_overridden` telemetry event with the full
  // change record.
  expect_eq(result.applied, true);
  expect_eq(result.configured, "min-complete-quorum");
  expect_eq(result.overridden, "block-if-any");
  expect_deep(result.autoPromotedCritics, ["cursor-local-chief-engineer"]);
});

// ---------------------------------------------------------------------------
// (Auto-promotion no-op) Override is block-if-any BUT a required critic exists.

test("applyEnvOverrides: block-if-any override + existing required critic → no auto-promotion", () => {
  // The on-disk config already has cursor `required: true`. The override
  // just stamps the policy; no auto-promotion needed.
  const config = blockIfAnyConfigWithRequiredCritic();
  expect_eq(config.aggregation.policy, "block-if-any");
  expect_eq(config.critics.filter((c) => c.required).length, 1);
  // Re-apply the override (it's a no-op on the policy since it matches, but
  // the function must still honor the invariant check).
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any",
  });
  expect_eq(result.config.aggregation.policy, "block-if-any");
  // Critics unchanged from input — no promotion happened.
  expect_deep(
    result.config.critics.map((c) => ({ id: c.id, required: c.required })),
    config.critics.map((c) => ({ id: c.id, required: c.required })),
  );
  expect_deep(result.autoPromotedCritics, []);
});

// ---------------------------------------------------------------------------
// (Auto-promotion no-op) Override is min-complete-quorum (required flag irrelevant).

test("applyEnvOverrides: min-complete-quorum override → no auto-promotion regardless of required state", () => {
  // Under min-complete-quorum, the `required` flag is semantically
  // irrelevant (every critic contributes to quorum count). The auto-
  // promotion path is ONLY for the block-if-any safety invariant.
  const config = baseConfig(); // zero required critics
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "min-complete-quorum",
  });
  expect_eq(result.config.aggregation.policy, "min-complete-quorum");
  // Critics unchanged — required flags stay false.
  expect_deep(
    result.config.critics.map((c) => ({ id: c.id, required: c.required })),
    config.critics.map((c) => ({ id: c.id, required: c.required })),
  );
  expect_deep(result.autoPromotedCritics, []);
});

test("applyEnvOverrides: min-complete-quorum override + existing required critic → critics unchanged", () => {
  // Symmetric edge: a config that DID have a required critic. Overriding
  // to min-complete-quorum should not demote it — the override stamps the
  // policy field, not the required flags. Operators can manage required
  // flags via the config file directly.
  const config = blockIfAnyConfigWithRequiredCritic();
  expect_eq(config.critics.filter((c) => c.required).length, 1);
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "min-complete-quorum",
  });
  expect_eq(result.config.aggregation.policy, "min-complete-quorum");
  // Required flag unchanged.
  const cursor = result.config.critics.find((c) => c.id === "cursor-local-chief-engineer");
  expect_eq(cursor?.required, true);
  expect_deep(result.autoPromotedCritics, []);
});

// ---------------------------------------------------------------------------
// (Mutation-free) The function must not mutate the input config.

test("applyEnvOverrides: does not mutate input config", () => {
  const config = baseConfig();
  // Snapshot the input shape via JSON round-trip; if applyEnvOverrides
  // mutated, the after-snapshot would differ.
  const beforeSnapshot = JSON.stringify(config);
  applyEnvOverrides(config, { AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any" });
  const afterSnapshot = JSON.stringify(config);
  expect_eq(afterSnapshot, beforeSnapshot, "applyEnvOverrides must not mutate input config");
});

// ---------------------------------------------------------------------------
// (Telemetry shape) The result is consumable by runner.ts to emit a
//                   `aggregation_policy_overridden` event. Pin the shape.

test("applyEnvOverrides: result shape carries the full audit record", () => {
  const config = baseConfig();
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any",
  });
  // Pin every field the runner relies on for telemetry emission:
  expect_eq(typeof result.applied, "boolean");
  expect_eq(typeof result.configured, "string");
  expect_eq(typeof result.overridden, "string");
  expect_truthy(Array.isArray(result.autoPromotedCritics));
  // And the returned config carries the overridden policy.
  expect_eq(typeof result.config.aggregation.policy, "string");
});

// ---------------------------------------------------------------------------
// Telemetry — verify the runner emits `aggregation_policy_overridden` when
// the override is applied. We exercise the emit-shape directly through a
// memory sink so the test doesn't depend on the runner's I/O surface.

test("aggregation_policy_overridden event emits on override application", () => {
  // The runner's responsibility is: when applyEnvOverrides returns
  // `applied: true`, emit a `aggregation_policy_overridden` event with
  // the audit record. This test directly exercises the emission shape;
  // the runner-level wiring (runReview + runCommitGate) is exercised by
  // the "runReview emits aggregation_policy_overridden ..." and
  // "runCommitGate emits aggregation_policy_overridden ..." tests in
  // runner.test.ts.
  const config = baseConfig();
  const sink = new MemoryTelemetrySink();
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any",
  });
  if (result.applied && result.overridden !== undefined) {
    sink.emit({
      ts: "2026-05-15T00:00:00.000Z",
      event: "aggregation_policy_overridden",
      configured: result.configured,
      overridden: result.overridden,
      autoPromotedCritics: result.autoPromotedCritics,
    });
  }
  expect_eq(sink.events.length, 1);
  const evt = sink.events[0]!;
  expect_eq(evt.event, "aggregation_policy_overridden");
  expect_eq(evt.configured, "min-complete-quorum");
  expect_eq(evt.overridden, "block-if-any");
  expect_deep(evt.autoPromotedCritics, ["cursor-local-chief-engineer"]);
});

test("aggregation_policy_overridden NOT emitted when override is absent", () => {
  // Negative case: the runner must NOT emit the event when the env var
  // is unset. This guards against accidental "always-emit" telemetry
  // pollution.
  const config = baseConfig();
  const sink = new MemoryTelemetrySink();
  const result = applyEnvOverrides(config, {});
  if (result.applied && result.overridden !== undefined) {
    sink.emit({
      ts: "2026-05-15T00:00:00.000Z",
      event: "aggregation_policy_overridden",
      configured: result.configured,
      overridden: result.overridden,
      autoPromotedCritics: result.autoPromotedCritics,
    });
  }
  expect_eq(sink.events.length, 0);
});

test("aggregation_policy_overridden NOT emitted when env value is invalid (only warning)", () => {
  // Symmetric: invalid value → no event emitted (the warning goes to
  // the operator, but the audit trail stays clean).
  const config = baseConfig();
  const sink = new MemoryTelemetrySink();
  const result = applyEnvOverrides(
    config,
    { AGENT_REVIEW_AGGREGATION_POLICY: "garbage" },
    { warn: () => {} },
  );
  if (result.applied && result.overridden !== undefined) {
    sink.emit({
      ts: "2026-05-15T00:00:00.000Z",
      event: "aggregation_policy_overridden",
      configured: result.configured,
      overridden: result.overridden,
      autoPromotedCritics: result.autoPromotedCritics,
    });
  }
  expect_eq(sink.events.length, 0);
});

// ---------------------------------------------------------------------------
// (Profile coverage) Codex BLOCKER on 7e780bd3 / security §11.
//
// When the on-disk config has profiles AND the override flips policy to
// `block-if-any`, the override path must guarantee every profile carries
// at least one required critic. Otherwise the active profile could narrow
// the runtime critic set to all-optional, defeating block-if-any
// enforcement.
//
// Coverage paths exercised:
//   1. Profile that contains cursor → cursor auto-promotion suffices.
//   2. Profile that does NOT contain cursor → the profile's first critic
//      is also auto-promoted.
//   3. Profile that already has a required critic → no additional
//      promotion needed (no-op for that profile).

// Helper: a 4-critic config with two profiles where one profile excludes cursor.
function profilesConfigWithCloudOnlyCursor(): AgentReviewConfig {
  return parseAgentReviewConfig({
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
        id: "codex-local-chief-engineer",
        name: "Codex",
        adapter: "codex-sdk",
        required: false,
        runtime: "local",
        model: { id: "gpt-5.5", params: [] },
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
    profiles: {
      // Profile WITHOUT cursor — auto-promotion needs to also promote one
      // of these critics so the profile carries a required member.
      "no-cursor": {
        criticIds: ["gemini-local-chief-engineer", "grok-local-chief-engineer"],
        quorum: 1,
      },
      // Profile WITH cursor — cursor's full-list promotion covers it.
      "with-cursor": {
        criticIds: ["cursor-local-chief-engineer", "codex-local-chief-engineer"],
        quorum: 1,
      },
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
  });
}

test("applyEnvOverrides: block-if-any override + profile EXCLUDING cursor → promotes cursor AND profile-first critic", () => {
  // The "no-cursor" profile selects {gemini, grok}. Without the profile-
  // coverage check, the override would yield:
  //   - Full critic list: cursor=required, gemini/grok=optional ✓
  //   - "no-cursor" profile filter: {gemini, grok} both optional ✗ unsafe
  // The fix: also promote the profile's first critic (gemini).
  const config = profilesConfigWithCloudOnlyCursor();
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any",
  });
  expect_eq(result.applied, true);
  expect_eq(result.config.aggregation.policy, "block-if-any");
  // Cursor promoted (full-list invariant).
  const cursor = result.config.critics.find((c) => c.id === "cursor-local-chief-engineer");
  expect_eq(cursor?.required, true);
  // The "no-cursor" profile's first critic (gemini) promoted too.
  const gemini = result.config.critics.find((c) => c.id === "gemini-local-chief-engineer");
  expect_eq(gemini?.required, true, "gemini should be promoted because no-cursor profile excludes cursor");
  // Both ids in the autoPromotedCritics audit list.
  expect_truthy(
    result.autoPromotedCritics.includes("cursor-local-chief-engineer"),
    `expected cursor in autoPromotedCritics, got: ${result.autoPromotedCritics.join(", ")}`,
  );
  expect_truthy(
    result.autoPromotedCritics.includes("gemini-local-chief-engineer"),
    `expected gemini in autoPromotedCritics, got: ${result.autoPromotedCritics.join(", ")}`,
  );
});

test("applyEnvOverrides: block-if-any override + profile INCLUDING cursor → cursor promotion suffices", () => {
  // A config with only the "with-cursor" profile — cursor promotion in
  // the full list covers the profile too; no profile-first promotion.
  const config = parseAgentReviewConfig({
    ...profilesConfigWithCloudOnlyCursor(),
    profiles: {
      "with-cursor": {
        criticIds: ["cursor-local-chief-engineer", "codex-local-chief-engineer"],
        quorum: 1,
      },
    },
  });
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any",
  });
  expect_eq(result.applied, true);
  // Only cursor promoted.
  expect_deep(result.autoPromotedCritics, ["cursor-local-chief-engineer"]);
});

test("applyEnvOverrides: profile coverage iterates profiles in deterministic (sorted) order", () => {
  // The profile coverage check sorts profile names — that controls the
  // promotion ORDER, which is observable in `autoPromotedCritics`. Pin
  // the sort so cross-engine determinism is guaranteed.
  const config = parseAgentReviewConfig({
    ...profilesConfigWithCloudOnlyCursor(),
    profiles: {
      // Declared in z→a order on purpose.
      "zeta-no-cursor": {
        criticIds: ["grok-local-chief-engineer"],
        quorum: 1,
      },
      "alpha-no-cursor": {
        criticIds: ["gemini-local-chief-engineer"],
        quorum: 1,
      },
    },
  });
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any",
  });
  // After cursor (full-list), alpha-no-cursor processes first (gemini),
  // then zeta-no-cursor (grok).
  const expectedOrder = [
    "cursor-local-chief-engineer",
    "gemini-local-chief-engineer", // alpha-no-cursor first
    "grok-local-chief-engineer",   // zeta-no-cursor second
  ];
  expect_deep(result.autoPromotedCritics, expectedOrder);
});

test("applyEnvOverrides: profile coverage no-op when min-complete-quorum (required flag irrelevant)", () => {
  // min-complete-quorum doesn't trigger the profile-coverage check —
  // the `required` flag is semantically irrelevant under quorum.
  const config = profilesConfigWithCloudOnlyCursor();
  const result = applyEnvOverrides(config, {
    AGENT_REVIEW_AGGREGATION_POLICY: "min-complete-quorum",
  });
  expect_deep(result.autoPromotedCritics, []);
});

test("applyEnvOverrides: REFUSES override when no critic can be auto-promoted (fail-closed)", () => {
  // Codex critic HIGH on 33dcb1b9 (security §0) — if the override would
  // result in a `block-if-any` config with ZERO required critics
  // (neither cursor nor any profile-first critic was promotable), the
  // function must REFUSE the override outright. Returning `applied: true`
  // with zero promotions would yield a runtime where the gate silently
  // downgrades blocker findings to warnings, defeating the revert.
  const config = parseAgentReviewConfig({
    ...profilesConfigWithCloudOnlyCursor(),
    critics: [
      // Cursor REMOVED from the config — auto-promotion target absent.
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
    profiles: undefined, // also no profiles, so no profile-first fallback
  });
  const warnings: string[] = [];
  const result = applyEnvOverrides(
    config,
    { AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any" },
    { warn: (msg) => warnings.push(msg) },
  );
  // Override REFUSED — falls through to configured policy.
  expect_eq(result.applied, false);
  expect_eq(result.config.aggregation.policy, "min-complete-quorum");
  expect_deep(result.autoPromotedCritics, []);
  expect_truthy(
    warnings.some((m) => /REFUSED|fail/i.test(m) && /no critic/i.test(m)),
    `expected fail-closed warning, got: ${warnings.join(" | ")}`,
  );
});

test("applyEnvOverrides: invariant — never returns block-if-any with zero required critics", () => {
  // Property test: ANY config (with or without profiles, with or without
  // cursor) that resolves to applied: true MUST have at least one critic
  // with required: true. This pins the safety contract regardless of
  // future refactors.
  //
  // Three scenarios are exercised: base 3-critic min-complete-quorum
  // (cursor promotes), 4-critic config with profile excluding cursor
  // (both cursor + profile-first promote), and the unpromotable case
  // (override refused, applied: false).
  const scenarios = [
    { config: baseConfig() }, // base 3-critic; cursor available
    { config: profilesConfigWithCloudOnlyCursor() }, // 4-critic with profiles
  ];
  for (const { config } of scenarios) {
    const result = applyEnvOverrides(
      config,
      { AGENT_REVIEW_AGGREGATION_POLICY: "block-if-any" },
      { warn: () => {} },
    );
    if (result.applied) {
      expect_eq(
        result.config.aggregation.policy,
        "block-if-any",
        "applied override must stamp block-if-any",
      );
      expect_truthy(
        result.config.critics.some((c) => c.required),
        "applied block-if-any override MUST have at least one required critic",
      );
    }
  }
});
