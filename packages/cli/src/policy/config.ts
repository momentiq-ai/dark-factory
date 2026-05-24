import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { gitShowFile, repoRoot } from "../git.js";
import {
  AGGREGATION_POLICIES,
  parseAgentReviewConfig,
  type AgentReviewConfig,
  type AggregationPolicy,
} from "@momentiq/dark-factory-schemas";

export const CONFIG_RELATIVE_PATH = ".agent-review/config.json";

// Cycle 322.7 Phase C — Emergency revert env var. When set to a
// recognized AggregationPolicy value (`block-if-any` or
// `min-complete-quorum`), the config-load path overrides
// `aggregation.policy` at runtime so operators can revert the live
// policy WITHOUT shipping a new PR.
//
// Primary use case: a newly-added critic generates spurious blockers
// in the first 48h post-policy-flip; the team needs to roll back to
// the previous policy immediately. Setting this env var in the shell
// (or as part of a single `git push` invocation) accomplishes the
// revert; subsequent telemetry events surface the override as an
// `aggregation_policy_overridden` event for audit traceability.
export const POLICY_OVERRIDE_ENV = "AGENT_REVIEW_AGGREGATION_POLICY";

// Critic id that gets auto-promoted to `required: true` when the env
// override flips policy to `block-if-any` AND the source config has
// zero required critics. The historically-trusted critic (single
// blocker since the pre-multi-critic days) is the cleanest restoration
// of the "single trusted critic gates the push" semantics operators
// expect during an emergency revert. Documented in CONTRIBUTING.md
// "Reverting the agent-review aggregation policy (emergency)".
const AUTO_PROMOTE_CRITIC_ID = "cursor-local-chief-engineer";

export interface LoadedConfig {
  config: AgentReviewConfig;
  repoRoot: string;
  configPath: string;
  // Set when the config was loaded from a parent ref instead of the working
  // tree (because the commit being reviewed modified `.agent-review/**`).
  // Surfaced in telemetry / artifact metadata so operators can see the
  // policy-baseline override happened.
  loadedFromRef?: string;
  // Cycle 322.7 Phase C — populated when `AGENT_REVIEW_AGGREGATION_POLICY`
  // overrode the on-disk policy at load time. Carries the audit record
  // for `aggregation_policy_overridden` telemetry. Absent in the
  // back-compat path (no env var, config policy stands).
  policyOverride?: PolicyOverrideRecord;
}

// Audit record for an emergency revert env override. Returned by
// `applyEnvOverrides` and threaded into `LoadedConfig.policyOverride`
// so the runner can emit the matching `aggregation_policy_overridden`
// telemetry event with the same shape.
export interface PolicyOverrideRecord {
  configured: AggregationPolicy;
  overridden: AggregationPolicy;
  autoPromotedCritics: string[];
}

export interface ApplyEnvOverridesOptions {
  // Called with a human-readable warning string when the env var is set
  // to an unrecognized value (typo guard). The caller decides where to
  // route the warning (stderr in CLI; collected in tests). When omitted,
  // the warning is silently discarded — the override path is best-effort
  // and never throws.
  warn?: (message: string) => void;
}

export interface ApplyEnvOverridesResult {
  // The (possibly-modified) config. Always a fresh object — `applyEnvOverrides`
  // is mutation-free.
  config: AgentReviewConfig;
  // True when the env var was recognized and the override was applied.
  applied: boolean;
  // The on-disk (configured) policy — always set.
  configured: AggregationPolicy;
  // The runtime (overridden) policy — set only when `applied: true`.
  overridden?: AggregationPolicy;
  // Critic ids whose `required` flag was auto-promoted to `true` to
  // preserve the block-if-any safety invariant. Empty array when no
  // promotion was needed (e.g., override TO min-complete-quorum, or
  // override TO block-if-any with a required critic already set).
  autoPromotedCritics: string[];
}

/**
 * Apply environment-variable overrides to a loaded config.
 *
 * Cycle 322.7 Phase C — Emergency revert toggle.
 *
 * Reads `AGENT_REVIEW_AGGREGATION_POLICY` from `env`. When set to a
 * recognized AggregationPolicy value, returns a config with
 * `aggregation.policy` stamped to the overridden value. When unset or
 * unrecognized, returns the config unchanged (and warns on the
 * unrecognized path so a typo doesn't silently fall through).
 *
 * Safety invariant — when the override is `block-if-any` AND no critic
 * has `required: true` in the source config, auto-promote
 * `cursor-local-chief-engineer` to `required: true`. Under `block-if-any`,
 * `gate.ts:evaluateCommitGate` only blocks pushes on required critics;
 * the auto-promotion preserves the "single trusted critic gates the
 * push" semantics that operators expect during an emergency revert.
 * This complements the load-time schema validation (which rejects a
 * config with `policy: "block-if-any"` and zero required critics
 * outright) — the runtime auto-promotion is the safety net for the
 * env-override path specifically.
 *
 * Mutation-free: the returned config is a fresh object; the input is
 * never modified. The returned record is suitable for emitting an
 * `aggregation_policy_overridden` telemetry event when `applied: true`.
 */
export function applyEnvOverrides(
  config: AgentReviewConfig,
  env: Record<string, string | undefined>,
  options: ApplyEnvOverridesOptions = {},
): ApplyEnvOverridesResult {
  const configured = config.aggregation.policy;
  const raw = env[POLICY_OVERRIDE_ENV];

  // Unset OR empty-string: silent fall-through. Empty string is the
  // "unset" sentinel in many shell pipelines (e.g., `VAR=${X:-} make`
  // patterns) so we deliberately do NOT warn — that would create noise
  // on every invocation that propagates env vars from a CI runner.
  if (raw === undefined || raw === "") {
    return {
      config,
      applied: false,
      configured,
      autoPromotedCritics: [],
    };
  }

  if (!isAggregationPolicy(raw)) {
    // Unrecognized non-empty value: warn so the operator notices the
    // typo, but never throw. The config policy stands (defense in depth
    // against misconfiguration aborting the pre-commit critic).
    if (options.warn) {
      options.warn(
        `${POLICY_OVERRIDE_ENV}=${raw} is not a recognized aggregation policy; ` +
          `expected one of: ${AGGREGATION_POLICIES.join(", ")}. ` +
          `Falling through to configured policy "${configured}".`,
      );
    }
    return {
      config,
      applied: false,
      configured,
      autoPromotedCritics: [],
    };
  }

  // Recognized override — apply it. Build the new critic list first
  // so the resulting config is fully consistent.
  const autoPromotedCritics: string[] = [];
  let critics = config.critics;
  if (raw === "block-if-any") {
    // Safety invariant: under block-if-any, the gate only blocks pushes
    // on `required: true` critics. Two ways the override path could
    // produce an unsafe runtime:
    //
    //   (a) FULL critic list has zero required critics → gate sees
    //       only optional critics in the artifact → blocker findings
    //       silently demote to warnings.
    //
    //   (b) FULL list HAS a required critic, but the ACTIVE PROFILE
    //       narrows critics to an all-optional subset → same outcome
    //       in the profile-filtered runtime view. Schema validation
    //       (schema.ts:931-965) catches this for the on-disk
    //       `block-if-any` shape, but the env-override path needs its
    //       own runtime guarantee because the on-disk policy may be
    //       `min-complete-quorum` (which has no profile invariant) at
    //       the time of override.
    //
    // Handle (a) by auto-promoting `cursor-local-chief-engineer` (the
    // historically-trusted critic) in the full list. Handle (b) by
    // additionally promoting one critic per all-optional profile so
    // every profile carries at least one required critic. The promoted
    // ids surface in the `aggregation_policy_overridden` telemetry
    // event's `autoPromotedCritics` array — that's the audit trail
    // operators grep `_runs.ndjson` for (CONTRIBUTING.md "Audit trail"
    // section). The stderr `warn` callback fires only on the
    // REFUSED-fail-closed and unrecognized-value paths; successful
    // promotions are observable in telemetry, not stderr (avoiding
    // noise on every push when the override is the normal path).
    // (Codex finding on 7e780bd3 / security §11 is closed by the
    // promotion logic; visibility is via telemetry, not stderr.)
    if (!critics.some((c) => c.required)) {
      critics = critics.map((c) =>
        c.id === AUTO_PROMOTE_CRITIC_ID ? { ...c, required: true } : c,
      );
      if (critics.some((c) => c.id === AUTO_PROMOTE_CRITIC_ID && c.required)) {
        autoPromotedCritics.push(AUTO_PROMOTE_CRITIC_ID);
      }
    }

    // Profile coverage check — required for the case where the on-disk
    // config has a required critic OUTSIDE the active-profile set, or
    // where cursor (the auto-promotion target) isn't in every profile.
    if (config.profiles) {
      const requiredIds = new Set(critics.filter((c) => c.required).map((c) => c.id));
      // Sort profile names for deterministic auto-promotion order
      // (mirrors schema.ts:947 sort for determinism in error messages).
      const profileNames = Object.keys(config.profiles).sort();
      for (const name of profileNames) {
        const profile = config.profiles[name]!;
        const hasRequired = profile.criticIds.some((id) => requiredIds.has(id));
        if (!hasRequired) {
          // Promote the FIRST critic in the profile's `criticIds` list.
          // The profile author defined this ordering; respecting it is
          // less surprising than picking alphabetically or by adapter.
          const promoteTarget = profile.criticIds[0];
          if (promoteTarget !== undefined) {
            critics = critics.map((c) =>
              c.id === promoteTarget ? { ...c, required: true } : c,
            );
            if (!autoPromotedCritics.includes(promoteTarget)) {
              autoPromotedCritics.push(promoteTarget);
            }
            requiredIds.add(promoteTarget);
          }
        }
      }
    }

    // FAIL-CLOSED CHECK — Codex critic HIGH on 33dcb1b9 (security §0).
    //
    // If the override would result in a `block-if-any` config with ZERO
    // required critics (neither the hard-coded cursor target nor any
    // profile-first critic was promotable), refuse the override outright.
    // Without this, the gate would silently downgrade blocker findings
    // to warnings — the exact unsafe runtime state the auto-promotion
    // is meant to prevent. Operators get a clear warning and the on-disk
    // policy stands; they can re-apply after promoting a critic on-disk.
    //
    // This rejection only fires for the no-profiles + no-cursor edge
    // case (the schema's profile-coverage invariant catches the rest at
    // load time). Returning `applied: false` keeps the result type
    // identical to the unset/garbage paths so the caller's audit code
    // doesn't need a new branch.
    if (!critics.some((c) => c.required)) {
      if (options.warn) {
        options.warn(
          `${POLICY_OVERRIDE_ENV}=block-if-any: REFUSED — no critic could be auto-promoted to required. ` +
            `Neither "${AUTO_PROMOTE_CRITIC_ID}" nor any profile-first critic was available in this config. ` +
            `Under block-if-any with zero required critics, the gate would silently downgrade blocker ` +
            `findings to warnings, defeating the revert's safety purpose. ` +
            `Falling through to configured policy "${configured}". ` +
            `Promote a critic on-disk (set \`required: true\`) before re-applying the revert.`,
        );
      }
      return {
        config,
        applied: false,
        configured,
        autoPromotedCritics: [],
      };
    }
  }

  // Build the new aggregation block. Schema invariants (per
  // parseAgentReviewConfig):
  //   - `block-if-any` REJECTS a `quorum` field (a stale quorum after
  //     a policy roll-back would be a silent foot-gun).
  //   - `min-complete-quorum` REQUIRES a quorum integer >= 2.
  //
  // To keep the result config round-trippable through the same schema
  // validation, strip `quorum` on `block-if-any` overrides. For
  // `min-complete-quorum` overrides, preserve a pre-existing valid
  // `quorum` OR synthesize one from the critic count when the source
  // config had `block-if-any` shape (no quorum) — refusing the override
  // would be hostile to operators who actually want to PIN
  // min-complete-quorum during a calibration window. The synthesized
  // value MUST satisfy the schema's `>= 2 && <= critics.length` bounds.
  // (Codex HIGH on c849d47d / schema §0.)
  let newAggregation: AgentReviewConfig["aggregation"];
  if (raw === "block-if-any") {
    newAggregation = {
      policy: raw,
      blockingSeverities: config.aggregation.blockingSeverities,
    };
  } else {
    // raw === "min-complete-quorum"
    const sourceQuorum = config.aggregation.quorum;
    const valid =
      typeof sourceQuorum === "number" &&
      Number.isInteger(sourceQuorum) &&
      sourceQuorum >= 2 &&
      sourceQuorum <= critics.length;
    if (valid) {
      newAggregation = {
        ...config.aggregation,
        policy: raw,
      };
    } else if (critics.length >= 2) {
      // Synthesize a safe quorum: 2 (the schema minimum). The profile
      // selector overrides this at runtime if a profile is active;
      // otherwise the runner uses this for hypothetical-quorum
      // telemetry. Safe per schema: 2 <= critics.length is guaranteed
      // by the branch condition.
      newAggregation = {
        ...config.aggregation,
        policy: raw,
        quorum: 2,
      };
    } else {
      // critics.length < 2 — cannot synthesize a schema-valid quorum.
      // Refuse the override and fall through to configured policy.
      if (options.warn) {
        options.warn(
          `${POLICY_OVERRIDE_ENV}=min-complete-quorum: REFUSED — cannot synthesize a schema-valid quorum ` +
            `(min-complete-quorum requires quorum >= 2 and <= critics.length, but only ${critics.length} ` +
            `critic(s) are configured). Falling through to configured policy "${configured}". ` +
            `Add a second critic to the config or pin quorum on-disk before re-applying the revert.`,
        );
      }
      return {
        config,
        applied: false,
        configured,
        autoPromotedCritics: [],
      };
    }
  }

  const newConfig: AgentReviewConfig = {
    ...config,
    critics,
    aggregation: newAggregation,
  };

  return {
    config: newConfig,
    applied: true,
    configured,
    overridden: raw,
    autoPromotedCritics,
  };
}

function isAggregationPolicy(s: string): s is AggregationPolicy {
  return (AGGREGATION_POLICIES as readonly string[]).includes(s);
}

export interface LoadConfigOptions {
  cwd?: string;
  validateGuidanceFiles?: boolean;
  // Cycle 322.7 Phase C — env source for the policy override. Defaults
  // to `process.env`; tests inject a fixture map. The path-of-least-
  // surprise is "real env reads `process.env`"; explicit injection is
  // for unit tests that want to exercise the override without
  // mutating real env.
  env?: Record<string, string | undefined>;
  // Cycle 322.7 Phase C — destination for the typo-guard warning when
  // `AGENT_REVIEW_AGGREGATION_POLICY` is set to an unrecognized value.
  // Defaults to writing to `process.stderr` via the CLI's caller; tests
  // pass a noop to silence the warning during exercises.
  warn?: (message: string) => void;
}

export async function loadAgentReviewConfig(
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const root = await repoRoot(options.cwd ?? process.cwd());
  const configPath = resolve(root, CONFIG_RELATIVE_PATH);
  if (!existsSync(configPath)) {
    throw new Error(
      `agent-review config not found at ${configPath}. ` +
        "Run from a repository that contains .agent-review/config.json or copy the template.",
    );
  }
  const raw = readFileSync(configPath, "utf8");
  const parsedConfig = parseConfigJson(raw, configPath);

  if (options.validateGuidanceFiles ?? true) {
    const missing: string[] = [];
    for (const rel of parsedConfig.context.guidanceFiles) {
      if (!existsSync(resolve(root, rel))) missing.push(rel);
    }
    for (const rel of parsedConfig.context.promptFragments) {
      if (!existsSync(resolve(root, rel))) missing.push(rel);
    }
    if (missing.length > 0) {
      throw new Error(
        `agent-review config references missing guidance files: ${missing.join(", ")}`,
      );
    }
  }

  // Cycle 322.7 Phase C — apply env-var overrides AFTER schema parse
  // but BEFORE the runner sees the config. The override path is
  // applied here (not deeper) so all consumers of `LoadedConfig`
  // (runReview, runCommitGate, evals) see the overridden policy
  // automatically without needing to re-thread the env source.
  const overrideResult = applyEnvOverrides(parsedConfig, options.env ?? process.env, {
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
  });

  return {
    config: overrideResult.config,
    repoRoot: root,
    configPath,
    ...(overrideResult.applied
      ? {
          policyOverride: {
            configured: overrideResult.configured,
            // `overridden` is guaranteed-set when applied=true; the
            // type system can't see that, so we assert here.
            overridden: overrideResult.overridden!,
            autoPromotedCritics: overrideResult.autoPromotedCritics,
          },
        }
      : {}),
  };
}

// Load config from a specific git ref (e.g., the parent of the reviewed
// commit). Used by the self-modification guard in `runReview`: if the
// commit being reviewed touches `.agent-review/**`, we refuse to use HEAD's
// (potentially-weakened) policy and instead review against the prior baseline.
//
// Throws if the ref doesn't have the config file, leaving the caller to
// decide how to handle (typically: fall back to working-tree policy with a
// loud warning, since the commit is introducing the config for the first
// time).
export async function loadAgentReviewConfigFromRef(
  rootDir: string,
  ref: string,
  options: { env?: Record<string, string | undefined>; warn?: (message: string) => void } = {},
): Promise<LoadedConfig> {
  const raw = await gitShowFile(ref, CONFIG_RELATIVE_PATH, rootDir);
  if (raw === null) {
    throw new Error(
      `agent-review config not present at ref ${ref}:${CONFIG_RELATIVE_PATH}`,
    );
  }
  const parsedConfig = parseConfigJson(raw, `${ref}:${CONFIG_RELATIVE_PATH}`);
  // Cycle 322.7 Phase C — env override applies to the policy-baseline
  // path too. The self-modification guard wants to evaluate against
  // the parent ref's config, but the operator's emergency revert
  // still applies: if the env says block-if-any, the parent-ref
  // policy is also stamped to block-if-any. Without this, an operator
  // who reverted to block-if-any via env would see the gate run
  // min-complete-quorum against a baseline that triggered the
  // self-modification guard — inconsistent and confusing.
  const overrideResult = applyEnvOverrides(parsedConfig, options.env ?? process.env, {
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
  });
  return {
    config: overrideResult.config,
    repoRoot: rootDir,
    configPath: `${ref}:${CONFIG_RELATIVE_PATH}`,
    loadedFromRef: ref,
    ...(overrideResult.applied
      ? {
          policyOverride: {
            configured: overrideResult.configured,
            overridden: overrideResult.overridden!,
            autoPromotedCritics: overrideResult.autoPromotedCritics,
          },
        }
      : {}),
  };
}

function parseConfigJson(raw: string, source: string): AgentReviewConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `agent-review config at ${source} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return parseAgentReviewConfig(parsed);
}
