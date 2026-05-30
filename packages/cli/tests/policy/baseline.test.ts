// Issue #56 — caller-injected `loaded` config dropped when the reviewed
// commit touches `.agent-review/**` (the self-modification guard re-reads the
// PARENT git ref and discards the injected config). For a hosted/embedding
// consumer that injects its own authoritative config + a custom `profileName`,
// this throws `unknown profile "<name>"` whenever the PR happens to modify
// `.agent-review/**`.
//
// The fix frames the guard by config *provenance*:
//
//   - Local/CI: the gate config IS the working-tree `.agent-review/config.json`.
//     A commit editing that file edits the gate that judges it → self-
//     modification is real → re-read parent. UNCHANGED.
//   - Authoritative injection: the gate config is supplied out-of-band and is
//     never read from the customer repo. The customer's committed
//     `.agent-review/config.json` is just a file in the diff under review — it
//     has zero authority over the gate. The parent-ref re-read (which exists
//     only to recover working-tree-provenance config) is INAPPLICABLE.
//
// `injectedConfigAuthoritative: true` declares the caller-injected `loaded`
// config authoritative: `resolvePolicyBaseline` returns it verbatim (no
// `baselineRef`, no parent-ref substitution), closing both the crash AND the
// fail-open hazard (a customer who commits their own `profiles.<name>` cannot
// override the embedder's injected gate).

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePolicyBaseline } from "../../src/policy/baseline.js";
import { type LoadedConfig, CONFIG_RELATIVE_PATH } from "../../src/policy/config.js";
import { resolveCommit } from "../../src/git.js";
import { resolveProfileWithConfig } from "../../src/policy/profile.js";
import { runReview, runCommitGate } from "../../src/runner.js";
import { AdapterRegistry } from "../../src/adapters/critic.js";
import { parseAgentReviewConfig, type AgentReviewConfig } from "@momentiq/dark-factory-schemas";

// ---------------------------------------------------------------------------
// Fixtures

interface ConfigShape {
  critics: Array<{ id: string; adapter: string }>;
  profiles?: { [name: string]: { criticIds: string[]; quorum: number } };
}

// Build a schema-valid AgentReviewConfig with the given critics + profiles.
// Root aggregation is min-complete-quorum/quorum=2 (steady-state shape).
function makeConfig(shape: ConfigShape): AgentReviewConfig {
  return parseAgentReviewConfig({
    version: 2,
    critics: shape.critics.map((c) => ({
      id: c.id,
      name: c.id,
      adapter: c.adapter,
      required: false,
      runtime: "local",
      model: { id: "m", params: [] },
    })),
    aggregation: { policy: "min-complete-quorum", blockingSeverities: ["blocker", "high"], quorum: 2 },
    ...(shape.profiles ? { profiles: shape.profiles } : {}),
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

// The customer's COMMITTED config: profiles {local, cloud}; critics cursor+gemini.
// `customerHostedProfile` optionally adds a WEAK `hosted` profile (the fail-open
// scenario — a customer who commits their own `profiles.hosted`).
function customerConfig(customerHostedProfile = false): AgentReviewConfig {
  return makeConfig({
    critics: [
      { id: "cursor-local-chief-engineer", adapter: "cursor-sdk" },
      { id: "gemini-local-chief-engineer", adapter: "gemini-sdk" },
    ],
    profiles: {
      local: { criticIds: ["cursor-local-chief-engineer"], quorum: 1 },
      cloud: { criticIds: ["cursor-local-chief-engineer", "gemini-local-chief-engineer"], quorum: 2 },
      // The customer's "weak" hosted profile (only when exercising the
      // fail-open regression): a single critic, distinct from the real
      // hosted critic set below.
      ...(customerHostedProfile
        ? { hosted: { criticIds: ["gemini-local-chief-engineer"], quorum: 1 } }
        : {}),
    },
  });
}

// The hosted worker's INJECTED config: the REAL hosted profile carries
// {codex, cursor} — deliberately a different critic set than the customer's
// weak `hosted` profile above, so "injected wins" is unambiguous.
const HOSTED_CRITIC_IDS = ["codex-local-chief-engineer", "cursor-local-chief-engineer"];
function hostedConfig(): AgentReviewConfig {
  return makeConfig({
    critics: [
      { id: "codex-local-chief-engineer", adapter: "codex-sdk" },
      { id: "cursor-local-chief-engineer", adapter: "cursor-sdk" },
    ],
    profiles: {
      hosted: { criticIds: HOSTED_CRITIC_IDS, quorum: 2 },
    },
  });
}

// A temp git repo whose PARENT commit holds `customerCfg` at
// `.agent-review/config.json`, and whose HEAD commit MODIFIES that file (so the
// self-modification guard's changed-file scan triggers). Returns the repo dir,
// HEAD sha, and a LoadedConfig wrapping the INJECTED hosted config (rooted at
// the repo) — exactly what the hosted worker passes as `options.loaded`.
async function setupSelfModRepo(customerCfg: AgentReviewConfig): Promise<{
  dir: string;
  sha: string;
  injected: LoadedConfig;
}> {
  const dir = mkdtempSync(join(tmpdir(), "df-baseline-injected-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir], { cwd: process.cwd() });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  // PARENT commit: the customer's committed config.
  writeFileSync(join(dir, CONFIG_RELATIVE_PATH), JSON.stringify(customerCfg, null, 2) + "\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "customer config"], { cwd: dir });

  // HEAD commit: the customer edits their own `.agent-review/config.json` in the
  // PR (any modification — here a trivial blockingSeverities tweak — is enough
  // to make the path show up in changedFiles(parent, HEAD) and trip the guard).
  const edited = { ...customerCfg, aggregation: { ...customerCfg.aggregation, blockingSeverities: ["blocker"] } };
  writeFileSync(join(dir, CONFIG_RELATIVE_PATH), JSON.stringify(edited, null, 2) + "\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "customer edits .agent-review/config.json"], { cwd: dir });

  const sha = await resolveCommit("HEAD", dir);
  const injected: LoadedConfig = {
    config: hostedConfig(),
    repoRoot: dir,
    configPath: join(dir, CONFIG_RELATIVE_PATH),
  };
  return { dir, sha, injected };
}

// A temp git repo whose PARENT commit has NO `.agent-review/config.json` and
// whose HEAD commit ADDS it (the "config introduced for the first time" case).
// The self-mod guard triggers (the path changed) but the parent-ref load throws
// → the fallback `warn`-level notice fires. Returns a LoadedConfig wrapping the
// committed config so the (non-authoritative) caller has something to fall back
// to.
async function setupFirstConfigRepo(): Promise<{ dir: string; sha: string; loaded: LoadedConfig }> {
  const dir = mkdtempSync(join(tmpdir(), "df-baseline-firstcfg-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir], { cwd: process.cwd() });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });

  // PARENT commit: README only, NO config.
  writeFileSync(join(dir, "README.md"), "# r\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init (no config)"], { cwd: dir });

  // HEAD commit: introduce `.agent-review/config.json` for the first time.
  const cfg = customerConfig(false);
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, CONFIG_RELATIVE_PATH), JSON.stringify(cfg, null, 2) + "\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "introduce .agent-review/config.json"], { cwd: dir });

  const sha = await resolveCommit("HEAD", dir);
  const loaded: LoadedConfig = { config: cfg, repoRoot: dir, configPath: join(dir, CONFIG_RELATIVE_PATH) };
  return { dir, sha, loaded };
}

// ---------------------------------------------------------------------------
// #56 — injected config authority

describe("resolvePolicyBaseline — injected config authority (#56)", () => {
  test("injectedConfigAuthoritative honors the injected hosted profile (commit touches .agent-review/**)", async () => {
    // The PR modifies `.agent-review/config.json`; the customer's committed
    // config has NO `hosted` profile (only {local, cloud}). With the flag, the
    // injected hosted config must win — `resolveProfileWithConfig(.., "hosted")`
    // must resolve, not throw "unknown profile".
    const { sha, injected } = await setupSelfModRepo(customerConfig(/* customerHostedProfile */ false));

    const baseline = await resolvePolicyBaseline({
      loaded: injected,
      sha,
      cwd: injected.repoRoot,
      injectedConfigAuthoritative: true,
    });

    // Injected config returned verbatim — no parent-ref substitution, no rebind.
    expect(baseline.loaded).toBe(injected);
    expect(baseline.baselineRef).toBeUndefined();
    expect(baseline.triggeredBy).toEqual([]);

    // The whole point: the hosted profile resolves against the baseline config.
    const resolved = resolveProfileWithConfig(baseline.loaded.config, "hosted");
    expect(resolved.criticIds).toEqual(HOSTED_CRITIC_IDS);
  });

  test("fail-open guard: a customer-committed weak `hosted` profile does NOT override the injected hosted config", async () => {
    // The customer commits their OWN `profiles.hosted` (weak: just gemini). The
    // parent ref now has a matching profile NAME, so the un-fixed path would
    // silently run the CUSTOMER's weak critic set as the hosted gate. With the
    // flag, the injected config's hosted set ({codex, cursor}) MUST win.
    const { sha, injected } = await setupSelfModRepo(customerConfig(/* customerHostedProfile */ true));

    const baseline = await resolvePolicyBaseline({
      loaded: injected,
      sha,
      cwd: injected.repoRoot,
      injectedConfigAuthoritative: true,
    });

    expect(baseline.loaded).toBe(injected);
    const resolved = resolveProfileWithConfig(baseline.loaded.config, "hosted");
    // Injected set, NOT the customer's weak {gemini}.
    expect(resolved.criticIds).toEqual(HOSTED_CRITIC_IDS);
    expect(resolved.criticIds).not.toContain("gemini-local-chief-engineer");
  });

  test("default (flag off): ordinary self-modification protection re-reads the parent baseline", async () => {
    // No flag → the guard fires exactly as before: the parent-ref customer
    // config ({local, cloud}, NO hosted) becomes the baseline, with baselineRef
    // pointing at the parent. The injected hosted config is (correctly) ignored
    // for a non-injecting caller. This is the behavior that stops a local/CI PR
    // from weakening its own gate.
    const { sha, injected, dir } = await setupSelfModRepo(customerConfig(false));
    const parent = spawnSync("git", ["rev-parse", "HEAD~1"], { cwd: dir }).stdout.toString().trim();

    const baseline = await resolvePolicyBaseline({
      loaded: injected,
      sha,
      cwd: injected.repoRoot,
      // injectedConfigAuthoritative omitted (default false)
    });

    // Parent-ref customer config is the baseline — NOT the injected hosted one.
    expect(baseline.loaded).not.toBe(injected);
    expect(Object.keys(baseline.loaded.config.profiles ?? {}).sort()).toEqual(["cloud", "local"]);
    expect(baseline.loaded.config.profiles?.hosted).toBeUndefined();
    expect(baseline.baselineRef).toBe(parent);
    expect(baseline.triggeredBy).toContain(CONFIG_RELATIVE_PATH);
    // Resolving "hosted" against the parent config throws — the exact symptom
    // issue #56 reports for the un-fixed hosted path.
    expect(() => resolveProfileWithConfig(baseline.loaded.config, "hosted")).toThrow(/unknown profile/);
  });
});

// ---------------------------------------------------------------------------
// #56 — the option is threaded through BOTH entrypoints (the hosted worker
// calls `runReview`; `runCommitGate` is the symmetric pre-push path). These
// reproduce the original symptom end-to-end: a commit touching
// `.agent-review/**` + `profileName: "hosted"` threw `unknown profile "hosted"`
// because the entrypoint re-read the customer's parent-ref config. With the
// flag the injected hosted profile is honored.

describe("runReview / runCommitGate thread injectedConfigAuthoritative (#56)", () => {
  test("runReview honors the injected hosted profile (no 'unknown profile' throw)", async () => {
    const { sha, injected, dir } = await setupSelfModRepo(customerConfig(false));

    // Empty registry → each hosted critic yields a "no adapter registered"
    // result. That is irrelevant here: the bug threw at PROFILE RESOLUTION,
    // before any adapter ran. We assert the run completes AND the active critic
    // set is the injected hosted set ({codex, cursor}), proving the injected
    // config — not the customer's parent-ref {local, cloud} — drove the run.
    const outcome = await runReview({
      loaded: injected,
      registry: new AdapterRegistry(),
      ref: sha,
      cwd: dir,
      profileName: "hosted",
      injectedConfigAuthoritative: true,
    });

    expect(outcome.artifact.criticResults.map((r) => r.criticId).sort()).toEqual(
      [...HOSTED_CRITIC_IDS].sort(),
    );
  });

  test("runCommitGate honors the injected hosted profile (no 'unknown profile' throw)", async () => {
    const { sha, injected, dir } = await setupSelfModRepo(customerConfig(false));

    // Without the flag this rejects with `unknown profile "hosted"` (the
    // parent-ref customer config has only {local, cloud}). With it, the gate
    // evaluates and returns a normal GateResult (blocked on the missing review
    // artifact — but crucially NOT a throw).
    const result = await runCommitGate({
      loaded: injected,
      commit: sha,
      cwd: dir,
      profileName: "hosted",
      injectedConfigAuthoritative: true,
    });

    expect(result).toBeDefined();
    expect(typeof result.blocked).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// #57 — the trusted-surface self-modification notices carry an explicit
// severity so a consuming runtime's severity-based alerting (GKE/Cloud Logging
// in dark-factory-platform#81) isn't polluted. The benign "reviewing against
// parent baseline" line is INFO; the "parent policy unavailable" fallback is
// WARN. The default sink still writes to stderr (CLI back-compat); a library
// embedder injects a sink that maps level → its own structured logger.

interface CollectedNotice {
  level: "info" | "warn";
  message: string;
}

describe("resolvePolicyBaseline — notice severity (#57)", () => {
  test("the benign 'reviewing against parent baseline' notice is emitted at info level", async () => {
    // Commit touches `.agent-review/**`, parent HAS config → the guard reloads
    // the parent baseline and emits the benign, working-as-designed notice.
    const { sha, injected, dir } = await setupSelfModRepo(customerConfig(false));
    const notices: CollectedNotice[] = [];

    await resolvePolicyBaseline({
      loaded: injected,
      sha,
      cwd: dir,
      notify: (n) => notices.push(n),
    });

    const info = notices.filter((n) => n.level === "info");
    expect(info.length).toBe(1);
    expect(info[0]!.message).toMatch(/reviewing against parent baseline/);
    // The benign path must NOT emit a warn-level notice (that would re-pollute
    // severity>=ERROR alerting — the exact bug #57 closes).
    expect(notices.some((n) => n.level === "warn")).toBe(false);
  });

  test("the 'parent policy unavailable' fallback notice is emitted at warn level", async () => {
    // Parent has no config (the commit introduces it for the first time) → the
    // parent-ref load throws → the fallback fires. This is a genuine warning
    // (self-mod check skipped), distinct from the benign info notice.
    const { sha, loaded, dir } = await setupFirstConfigRepo();
    const notices: CollectedNotice[] = [];

    await resolvePolicyBaseline({
      loaded,
      sha,
      cwd: dir,
      notify: (n) => notices.push(n),
    });

    const warns = notices.filter((n) => n.level === "warn");
    expect(warns.length).toBe(1);
    expect(warns[0]!.message).toMatch(/parent policy is unavailable|falling back to HEAD policy/);
  });

  test("runReview forwards the policy notice to onPolicyNotice (info level)", async () => {
    // The hosted worker consumes the library API. Prove the benign notice is
    // reachable (with its info level intact) through runReview's option, so the
    // embedder can route it away from stderr/severity:ERROR. No profileName →
    // no profile resolution; flag off → the self-mod guard fires normally.
    const { sha, injected, dir } = await setupSelfModRepo(customerConfig(false));
    const notices: CollectedNotice[] = [];

    await runReview({
      loaded: injected,
      registry: new AdapterRegistry(),
      ref: sha,
      cwd: dir,
      onPolicyNotice: (n) => notices.push(n),
    });

    expect(notices.some((n) => n.level === "info" && /reviewing against parent baseline/.test(n.message))).toBe(true);
  });
});
