// Cycle 322.7 Phase B — Profile selector + applicator.
//
// Selection precedence (highest → lowest):
//   1. CLI `--profile <name>` flag.
//   2. `AGENT_REVIEW_PROFILE` env var.
//   3. Default `"local"`.
//
// The selector is split into two functions so each surface is unit-
// testable in isolation:
//
//   - `resolveProfile(args, env) → name`
//     Pure precedence resolver. Takes the CLI's parsed flags map +
//     env vars, returns the resolved profile NAME (string). Does
//     NOT touch the config — a profile name is just a label.
//
//   - `resolveProfileWithConfig(config, name) → ResolvedProfile`
//     Applies the resolved name against the loaded config. Returns
//     `{ profileName, profile, criticIds, quorum }`. When the config
//     has no `profiles` map (back-compat), `profile` is undefined
//     and the runner falls back to the full critic list + root
//     aggregation.quorum. When the config DOES have `profiles` but
//     the resolved name doesn't match any entry, this throws — a
//     mistyped `--profile cluod` should fail loudly, not silently
//     run with the wrong critic set.

import type { AgentReviewConfig, CriticConfig, ProfileConfig } from "@momentiq/dark-factory-schemas";

/**
 * Pure precedence resolver. The CLI arg map can contain `profile`
 * as a string (the value), `true` (bare `--profile` with no value),
 * or be absent. The env map is `process.env` shape (string|undefined).
 * Whitespace-trimmed; empty strings fall through.
 */
export function resolveProfile(
  args: { profile?: string | boolean | undefined },
  env: { AGENT_REVIEW_PROFILE?: string | undefined },
): string {
  // Flag must be a string with content after trim to be considered set.
  // A bare `--profile` (no value) parses as boolean `true` in our CLI,
  // and an explicit `--profile=""` would be empty; both fall through.
  const flagRaw = args.profile;
  if (typeof flagRaw === "string") {
    const trimmed = flagRaw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const envRaw = env.AGENT_REVIEW_PROFILE;
  if (typeof envRaw === "string") {
    const trimmed = envRaw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "local";
}

/**
 * The result of applying a resolved profile name against the loaded
 * config. Two shapes:
 *
 *   - Back-compat (no `profiles` map in config): `profile`,
 *     `criticIds`, and `quorum` are all undefined. The runner uses
 *     the full critic list and the root `aggregation.quorum`.
 *     `profileName` is still the resolved name — it's informational
 *     for telemetry but does not affect filtering.
 *
 *   - Profile-active (config has `profiles` AND the resolved name
 *     matches an entry): `profile` carries the matched config,
 *     `criticIds` is the filter list, `quorum` is the override.
 *     The runner uses these to narrow the critic set + override
 *     aggregation quorum.
 *
 * If the config HAS `profiles` but the resolved name doesn't match
 * any entry, `resolveProfileWithConfig` throws a clear error — see
 * the "unknown profile" path.
 */
export interface ResolvedProfile {
  profileName: string;
  profile?: ProfileConfig;
  criticIds?: string[];
  quorum?: number;
}

/**
 * Apply the resolved name against the loaded config. Throws on
 * "name exists in caller but not in config.profiles" — a typo
 * should fail loudly so the operator doesn't silently run with
 * the wrong critic set.
 *
 * If the config has no `profiles` map, this is a no-op: the
 * profile name passes through informationally but doesn't filter
 * anything.
 */
export function resolveProfileWithConfig(
  config: AgentReviewConfig,
  profileName: string,
): ResolvedProfile {
  if (!config.profiles) {
    // No profiles map → back-compat path. The profile name is
    // informational; the runner uses the full critic list.
    return { profileName };
  }
  const profile = config.profiles[profileName];
  if (!profile) {
    const available = Object.keys(config.profiles);
    throw new Error(
      `agent-review: unknown profile "${profileName}". ` +
        `Available profiles: ${available.length > 0 ? available.join(", ") : "(none)"}. ` +
        `Set via --profile <name> or AGENT_REVIEW_PROFILE=<name>; ` +
        `default is "local".`,
    );
  }
  return {
    profileName,
    profile,
    criticIds: profile.criticIds,
    quorum: profile.quorum,
  };
}

/**
 * Cycle 322.8 — apply a profile's `modelParamOverrides` to a critic config.
 *
 * The runner calls this between `activeCritics` filtering (profile-based
 * critic narrowing) and `Promise.all(critics.map(adapter.review))`. The
 * adapter sees the cloned critic through its existing `critic.model.params`
 * surface — for Codex, that's `tools/agent-review/src/adapters/codex-sdk.ts`
 * `resolveCodexReasoningEffort(critic)` reading
 * `critic.model.params.find((p) => p.id === "reasoning_effort")`. No
 * adapter-side change required.
 *
 * Behavior:
 * - No profile, no profile overrides, or no override for this critic →
 *   returns the input critic by reference (identity, no allocation).
 * - Otherwise clones the critic; for each (paramId, value) in the
 *   override, REPLACES an existing param with the same id, or APPENDS
 *   a new entry. The order of existing params is preserved; new params
 *   are appended after existing params in the order they appear in the
 *   override object.
 * - The on-disk critic config is NOT mutated. The clone is independent.
 *
 * Pure and synchronous; safe to call inside `Promise.all` mappings.
 */
export function applyProfileParamOverrides(
  critic: CriticConfig,
  profile: ProfileConfig | undefined,
): CriticConfig {
  if (!profile?.modelParamOverrides) return critic;
  const overrides = profile.modelParamOverrides[critic.id];
  if (!overrides) return critic;

  // Replace or append each override; preserve existing param order.
  const existingIds = new Set(critic.model.params.map((p) => p.id));
  const updatedParams = critic.model.params.map((p) =>
    overrides[p.id] !== undefined ? { id: p.id, value: overrides[p.id]! } : p,
  );
  for (const [paramId, value] of Object.entries(overrides)) {
    if (!existingIds.has(paramId)) {
      updatedParams.push({ id: paramId, value });
    }
  }
  return {
    ...critic,
    model: {
      ...critic.model,
      params: updatedParams,
    },
  };
}

/**
 * Issue #2103 — apply a profile's `auth` pinning to a critic config.
 *
 * Mirrors {@link applyProfileParamOverrides}: pure, synchronous, returns
 * the input critic by reference when no auth is pinned for this critic.
 * The runner calls this in the same pre-dispatch pipeline so adapters
 * receive a critic with `auth` already set; adapter contract is to
 * honor `critic.auth` STRICTLY (no env-presence fallback) when present
 * and ignore it when absent.
 *
 * The on-disk critic config never carries `auth` directly — it lives at
 * the profile level (`profiles.<name>.auth[critic.id]`) so the choice
 * is profile-policy, not critic-identity. This function is the bridge.
 *
 * Behavior:
 * - No profile, no profile auth map, or no auth entry for this critic
 *   → returns the input critic by reference (identity, no allocation).
 *   Adapters that honor `auth` will throw at attemptReview() time when
 *   they see `critic.auth === undefined` — the failure surfaces at the
 *   adapter, with a clear error pointing back to the profile config.
 * - Otherwise clones the critic with `auth` set to the profile-supplied
 *   string. The on-disk config is NOT mutated; the clone is independent.
 */
export function applyProfileAuth(
  critic: CriticConfig,
  profile: ProfileConfig | undefined,
): CriticConfig {
  if (!profile?.auth) return critic;
  const auth = profile.auth[critic.id];
  if (auth === undefined) return critic;
  return { ...critic, auth };
}
