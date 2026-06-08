// Issue #170 — the `agent-critic` GHA workflow runs `df critic`, which
// (before this fix) never resolved or passed a profile name to
// `runReview()`. With `profileName === undefined` the runner takes the
// back-compat path: every critic runs UNFILTERED and `applyProfileAuth`
// leaves `critic.auth` unset for all of them. Codex is the only
// auth-strict adapter, so it alone errors with
//   `codex critic "…" has no auth source pinned`
// on every CI run — the symptom reported in #170.
//
// The fix is two-part:
//   1. `parseCriticArgs` surfaces `--profile`, and `cmdCritic` resolves
//      it via `resolveProfile()` (flag > AGENT_REVIEW_PROFILE > "local")
//      and threads `profileName` into `runReview()` — so profile `auth`
//      pins actually take effect on the `df critic` path.
//   2. The `agent-critic` workflow selects the `cloud` profile (full
//      quartet; codex pinned to `api` because CI ships only
//      `CODEX_API_KEY`, never an interactive ChatGPT session).
//
// These tests assert (1) the parser/resolver plumbing and (2) that the
// committed repo config resolves the codex critic to `auth: "api"` under
// the `cloud` profile — i.e. it no longer hits the "no auth source
// pinned" path the adapter throws when `critic.auth` is undefined.

import { test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  expect_eq,
  expect_truthy,
} from "./_assert-shim.js";
import { parseCriticArgs } from "../src/cli.js";
import {
  resolveProfile,
  resolveProfileWithConfig,
  applyProfileAuth,
} from "../src/policy/profile.js";
import {
  parseAgentReviewConfig,
  type CriticConfig,
} from "@momentiq/dark-factory-schemas";

const CODEX_CRITIC_ID = "codex-local-chief-engineer";

// Load the REAL committed repo config so this test fails if someone
// removes the cloud-profile codex auth pin or renames the critic.
function loadRepoConfig() {
  const here = dirname(fileURLToPath(import.meta.url));
  // tests/ -> packages/cli -> packages -> <repo root>
  const repoRoot = join(here, "..", "..", "..");
  const raw = readFileSync(
    join(repoRoot, ".agent-review", "config.json"),
    "utf8",
  );
  return parseAgentReviewConfig(JSON.parse(raw));
}

// ---------------------------------------------------------------------------
// (1) Parser plumbing — `df critic --profile <name>` is now honored.

test("parseCriticArgs: surfaces --profile so `df critic` can select a profile", () => {
  const opts = parseCriticArgs(["--profile", "cloud"]);
  expect_eq(opts.profileName, "cloud");
});

test("parseCriticArgs: --profile absent leaves profileName undefined (resolveProfile applies the default)", () => {
  const opts = parseCriticArgs(["--ref", "HEAD"]);
  expect_eq(opts.profileName, undefined);
});

test("resolveProfile: a `df critic` invocation with --profile cloud resolves to 'cloud'", () => {
  // Mirrors how cmdCritic now wires parseCriticArgs.profileName through
  // resolveProfile (flag > AGENT_REVIEW_PROFILE > 'local').
  const opts = parseCriticArgs(["--profile", "cloud"]);
  const resolved = resolveProfile({ profile: opts.profileName }, {});
  expect_eq(resolved, "cloud");
});

test("resolveProfile: `df critic` honors AGENT_REVIEW_PROFILE when no --profile flag", () => {
  const opts = parseCriticArgs([]);
  const resolved = resolveProfile(
    { profile: opts.profileName },
    { AGENT_REVIEW_PROFILE: "cloud" },
  );
  expect_eq(resolved, "cloud");
});

// ---------------------------------------------------------------------------
// (2) End-to-end resolution against the committed repo config — the
//     codex critic resolves to `auth: "api"` under the CI/cloud profile.

test("repo config: cloud profile pins the codex critic to auth='api'", () => {
  const config = loadRepoConfig();
  const resolved = resolveProfileWithConfig(config, "cloud");
  expect_truthy(resolved.profile, "cloud profile must exist in repo config");
  expect_eq(resolved.profile?.auth?.[CODEX_CRITIC_ID], "api");
});

test("repo config: applyProfileAuth resolves codex to auth='api' under cloud (no 'no auth source pinned')", () => {
  const config = loadRepoConfig();
  const resolved = resolveProfileWithConfig(config, "cloud");
  const codex = config.critics.find((c) => c.id === CODEX_CRITIC_ID);
  expect_truthy(codex, "codex critic must exist in repo config");
  const withAuth: CriticConfig = applyProfileAuth(
    codex as CriticConfig,
    resolved.profile,
  );
  // The codex adapter's resolveAuthOrFail() throws "no auth source
  // pinned" iff `critic.auth === undefined`. Proving it is "api" here
  // proves that path is no longer reachable on the cloud/CI profile.
  expect_eq(withAuth.auth, "api");
});

test("repo config: local profile still pins codex to 'chatgpt' (subscription billing preserved — NOT switched to api)", () => {
  // Guard the #170 fix's blast radius: the fix must NOT mutate the local
  // profile's codex auth (local dogfood consumes the ChatGPT
  // subscription via `codex login`, not the API key).
  const config = loadRepoConfig();
  const resolved = resolveProfileWithConfig(config, "local");
  expect_eq(resolved.profile?.auth?.[CODEX_CRITIC_ID], "chatgpt");
});
