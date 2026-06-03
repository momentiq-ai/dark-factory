// `df doctor` — environment verification for hook-facing critic invocation.
//
// Cycle 331.1 Phase F-LOCAL — ported from sage3c's
// tools/agent-review/src/install.ts (cycle 318.1 / 322.x). The OSS doctor
// is intentionally slimmer than sage3c's:
//
// Dropped (sage-specific):
//   - K8s container-stack-status probe (kubectl against k3d-sage-local).
//   - dist-staleness check (relies on `tools/agent-review/dist/cli.js`
//     path, which doesn't exist in a consumer repo installing
//     `@momentiq/dark-factory-cli` from npm).
//   - CURSOR_API_KEY-specific Doppler probe (sage's first-vendor
//     historical default). The OSS Doppler check is now a thin
//     "is doppler CLI reachable?" probe + the per-adapter doctor()
//     reports adapter-by-adapter.
//
// Kept (OSS-generic):
//   - Node 20+ check
//   - hooks directory + per-hook (post-commit / pre-push) presence +
//     executability
//   - `git config --local core.hooksPath` matches configured hookPath
//   - artifact dir writable
//   - Doppler bootstrap result (when provided by caller)
//   - per-adapter `doctor()` invocation, where subscription-auth
//     verification actually happens (cycle 322.7 issue #2103 +
//     codex 322.7 work). The adapter knows whether `chatgpt` /
//     `subscription` / `api` was pinned by the profile and reports
//     pass/fail accordingly.

import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";

import type { AdapterRegistry } from "./adapters/critic.js";
import type { LoadedConfig } from "./policy/config.js";
import type { BootstrapResult } from "./doppler-bootstrap.js";
import { gitCommonDir, gitDir } from "./git.js";
import {
  applyProfileAuth,
  resolveProfileWithConfig,
} from "./policy/profile.js";
import type {
  AgentReviewConfig,
  DoctorCheck,
} from "@momentiq/dark-factory-schemas";

const HOOK_FILES = ["post-commit", "pre-push"] as const;

export interface DoctorOptions {
  loaded: LoadedConfig;
  registry: AdapterRegistry;
  // Result of the Doppler bootstrap loader. The CLI calls
  // `loadDopplerBootstrapEnv` before dispatching to `df doctor` (so the
  // bootstrap result reflects the same state the critic-running
  // subcommands would see) and threads the BootstrapResult here.
  bootstrap?: BootstrapResult;
  // Resolved profile name (CLI --profile / env / "local" default). When
  // the config has a `profiles` map AND the name resolves to a profile,
  // doctor applies the same `applyProfileAuth` clone the runner does
  // before invoking each adapter's `doctor()`. Adapters that honor
  // `critic.auth` (codex-sdk) then validate ONLY the configured source
  // instead of the legacy "any-source-passes" path.
  profileName?: string;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const { loaded, registry } = options;

  // 1. Node 20+
  checks.push({
    name: "node_version",
    passed: nodeVersionOk(),
    detail: `node ${process.version}`,
    ...(nodeVersionOk()
      ? {}
      : { remediation: "install Node.js 20 or newer (e.g., via nvm/asdf)" }),
  });

  // 2. hooks directory
  const root = loaded.repoRoot;
  const hookDir = resolve(root, loaded.config.git.hookPath);
  const hookDirExists = existsSync(hookDir);
  checks.push({
    name: "hooks_directory_exists",
    passed: hookDirExists,
    detail: `${hookDir} ${hookDirExists ? "found" : "missing"}`,
    ...(hookDirExists
      ? {}
      : {
          remediation: `create ${loaded.config.git.hookPath}/ and add post-commit + pre-push (see README for samples)`,
        }),
  });

  // 3. per-hook presence + executability
  for (const name of HOOK_FILES) {
    const path = resolve(hookDir, name);
    const exists = existsSync(path);
    let executable = false;
    if (exists) {
      try {
        accessSync(path, constants.X_OK);
        executable = true;
      } catch {
        executable = false;
      }
    }
    checks.push({
      name: `hook_${name}`,
      passed: exists && executable,
      detail: exists
        ? executable
          ? `${path} present and executable`
          : `${path} present but not executable`
        : `${path} missing`,
      ...(exists && executable
        ? {}
        : { remediation: `chmod +x ${loaded.config.git.hookPath}/${name}` }),
    });
  }

  // 4. git config --local core.hooksPath matches configured hookPath
  checks.push(await checkGitHooksPath(root, loaded.config.git.hookPath));

  // 5. artifact dir writable
  const scopeDir =
    loaded.config.git.artifactScope === "git-dir"
      ? await gitDir(root)
      : await gitCommonDir(root);
  const artifactDir = resolve(scopeDir, loaded.config.git.artifactDir);
  const artifactDirOk = canCreateDir(artifactDir);
  checks.push({
    name: "artifact_dir_writable",
    passed: artifactDirOk,
    detail: `${artifactDir} ${artifactDirOk ? "writable" : "not writable"}`,
    ...(artifactDirOk
      ? {}
      : { remediation: `mkdir -p ${artifactDir} and ensure write permission` }),
  });

  // 5a. Issue #105 — orphan-lock sweep. Subagent processes killed mid-run
  // leave behind `.git/agent-reviews/<sha>.lock` files that block every
  // subsequent `df review` for that SHA. Walk the dir, parse each
  // lock's PID, and remove locks whose recorded PID is dead.
  checks.push(sweepOrphanLocks(artifactDir));

  // 5b. Cache-tree corruption probe (issue #107). Detects the
  // index-cache-tree-references-missing-object state a killed-mid-write
  // `git commit` leaves the worktree in. Detect-only — the recovery
  // (`git read-tree HEAD`) is destructive and stays operator-driven.
  checks.push(await probeCacheTree(root));

  // 6. Doppler bootstrap visibility (when caller supplied a BootstrapResult).
  // For the OSS doctor, this is informational — a `no-bootstrap-file` status
  // is perfectly fine when the user exports tokens directly in their shell.
  if (options.bootstrap) {
    const b = options.bootstrap;
    checks.push({
      name: "doppler_bootstrap",
      passed: b.status === "ok" || b.status === "no-bootstrap-file",
      detail: b.message,
      ...(b.status === "ok" || b.status === "no-bootstrap-file"
        ? {}
        : { remediation: BOOTSTRAP_REMEDIATION }),
    });
  }

  // 7. Doppler CLI reachable (informational — only emitted when the loaded
  // config declares a `secrets.doppler` scope AND `DOPPLER_TOKEN` is
  // missing AND no per-adapter API key is set directly. Otherwise this
  // check is moot.). This is the generic version of sage3c's
  // `checkDopplerScopeReachable`: we just verify the doppler binary is on
  // PATH; we don't probe a specific env var name (sage hard-coded
  // CURSOR_API_KEY which is non-portable).
  if (loaded.config.secrets?.doppler) {
    checks.push(await checkDopplerOnPath(loaded));
  }

  // 7a. Cloud-env detection (consumer issue dark-factory-platform#56).
  // When this process is running inside a cloud sandbox / dev-container
  // (GitHub Codespaces, dev-container, Claude Code sandbox, etc.) the
  // workstation OAuth flows for subscription-backed critics (`cursor-agent
  // login`, `codex login`) are structurally unavailable — there is no
  // browser to drive the OAuth dance and no Keychain to persist the
  // resulting tokens. Surfacing this as a top-level INFO check (always
  // emitted; not gated on `secrets.doppler` like the doppler probe) gives
  // pre-push hooks a deterministic signal they can read from
  // `df doctor --json` and short-circuit the gate with the documented
  // `AGENT_REVIEW_BYPASS="cloud env — local quorum unavailable; W3
  // critic is the gate"` cooperation pattern instead of churning through
  // a per-critic "CURSOR_API_KEY is not set" failure cascade.
  //
  // The detection is also wired downstream: when `cloudEnv.detected` is
  // true AND the resolved critic is pinned to a subscription auth
  // source (`auth: "chatgpt"`), the per-adapter `doctor()` invocation is
  // skipped and replaced with a `subscription_auth_unavailable_cloud_env`
  // INFO check. API-auth critics (`auth: "api"`, no pin) still run their
  // adapter `doctor()` — API keys ARE expected to be present in cloud
  // envs via Doppler / env vars.
  const cloudEnv = detectCloudEnv();
  checks.push(cloudEnvCheck(cloudEnv));

  // 8. per-adapter doctor() — this is where subscription-auth verification
  // actually lives. Each adapter's doctor() checks ITS own credentials
  // (env var, ~/.cursor auth, ~/.codex auth, etc.). When a profile is
  // active and pins `auth` for a critic, `applyProfileAuth` clones the
  // critic config with `auth=<chatgpt|api|composer|subscription>` and the
  // adapter validates ONLY that source.
  const resolvedProfile = options.profileName
    ? resolveProfileWithConfig(loaded.config, options.profileName)
    : undefined;
  for (const rawCritic of loaded.config.critics) {
    const critic = applyProfileAuth(rawCritic, resolvedProfile?.profile);
    if (!registry.has(critic.adapter)) {
      checks.push({
        name: `adapter_${critic.adapter}_registered`,
        passed: false,
        detail: `no adapter registered for "${critic.adapter}"`,
        remediation:
          "register the adapter in your CLI wrapper or use the default registry",
      });
      continue;
    }
    // Cloud-env subscription-auth skip (issue #56): when a critic is
    // pinned to a subscription auth source in a cloud env, do NOT call
    // the adapter's `doctor()` — there is no path to authenticate, so
    // the probe would either spuriously fail OR (worse) consult a stale
    // file. Surface the structural gap as a single INFO check whose
    // remediation is the documented bypass.
    if (cloudEnv.detected && isSubscriptionAuth(critic.auth)) {
      checks.push({
        name: `${critic.id}.subscription_auth_unavailable_cloud_env`,
        passed: true,
        optional: true,
        detail: `cloud env detected (${cloudEnv.markers.join(", ")}); subscription auth (auth="${critic.auth ?? "(unset)"}") is structurally unavailable here — adapter doctor() skipped.`,
        remediation: CLOUD_ENV_BYPASS_REMEDIATION,
      });
      continue;
    }
    const adapter = registry.resolve(critic.adapter);
    const adapterChecks = await adapter.doctor(critic);
    // Optional (shadow) critics are tagged `optional: true` so cmdDoctor
    // prints them but does NOT exit non-zero when they fail.
    for (const c of adapterChecks) {
      checks.push({
        ...c,
        name: `${critic.id}.${c.name}`,
        ...(critic.required ? {} : { optional: true }),
      });
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Cloud-env detection (consumer issue dark-factory-platform#56).
//
// Pure: reads only `process.env` (or an injected `env` map for tests).
// No I/O, no time dependence. Returns the structured detection result
// so callers can both render the INFO check AND key behavior off
// `detected: true` (subscription-auth skip in `runDoctor`, fail-fast
// short-circuit in the consumer-side pre-push hook).
//
// Markers (any one triggers detection):
//   - `CODESPACES=true`              GitHub Codespaces native marker
//   - `REMOTE_CONTAINERS=true`       VS Code Dev Containers (local + Codespaces)
//   - `CLAUDE_CODE_SANDBOX=true`     Claude Code web sandbox marker
//   - `DEVCONTAINER=true`            generic devcontainer marker (some images set this)
//
// The marker set is *intentionally minimal* — future cloud-env brands
// add themselves by exporting one of these (or by extending this list
// upstream). The list is exported so consumers (pre-push hooks,
// observability sinks) can introspect what was checked.
// ---------------------------------------------------------------------------

export const CLOUD_ENV_MARKERS = [
  "CODESPACES",
  "REMOTE_CONTAINERS",
  "CLAUDE_CODE_SANDBOX",
  "DEVCONTAINER",
] as const;

export type CloudEnvMarker = (typeof CLOUD_ENV_MARKERS)[number];

export interface CloudEnvDetection {
  detected: boolean;
  /**
   * The subset of `CLOUD_ENV_MARKERS` whose values were truthy in
   * `process.env` at detection time (each one of "true", "1", "yes",
   * case-insensitive; presence-only markers like a non-empty
   * `CODESPACE_NAME` are NOT considered — keep the contract explicit
   * boolean-ish to avoid false positives from generic env-set state).
   */
  markers: CloudEnvMarker[];
}

export interface DetectCloudEnvOptions {
  env?: NodeJS.ProcessEnv;
}

export function detectCloudEnv(
  options: DetectCloudEnvOptions = {},
): CloudEnvDetection {
  const env = options.env ?? process.env;
  const markers: CloudEnvMarker[] = [];
  for (const key of CLOUD_ENV_MARKERS) {
    const raw = env[key];
    if (raw === undefined) continue;
    const v = raw.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes") {
      markers.push(key);
    }
  }
  return { detected: markers.length > 0, markers };
}

const CLOUD_ENV_BYPASS_REMEDIATION =
  'cloud env: local subscription quorum is structurally unavailable. Push with `AGENT_REVIEW_BYPASS="cloud env — local quorum unavailable; W3 critic is the gate" git push`; the hosted W3 critic remains the merge gate via branch protection.';

function cloudEnvCheck(detection: CloudEnvDetection): DoctorCheck {
  if (!detection.detected) {
    return {
      name: "cloud_env",
      passed: true,
      detail: `no cloud-env markers detected (${CLOUD_ENV_MARKERS.join(", ")} all unset / falsy)`,
    };
  }
  return {
    name: "cloud_env",
    passed: true,
    optional: true,
    detail: `cloud env detected via ${detection.markers.join(", ")} — subscription-auth critics will be skipped (use the documented bypass)`,
    remediation: CLOUD_ENV_BYPASS_REMEDIATION,
  };
}

// A critic's `auth` value is "subscription" (chatgpt / subscription /
// composer) when its workstation auth path is OAuth-backed and therefore
// structurally unavailable inside a cloud env. The literal token set
// matches the canonical values the adapters honor (cursor-cli accepts
// only "chatgpt"; codex-sdk accepts "chatgpt" | "api"; future
// subscription tokens added upstream should land here).
function isSubscriptionAuth(auth: string | undefined): boolean {
  if (auth === undefined) return false;
  return auth === "chatgpt" || auth === "subscription" || auth === "composer";
}

// `git config --local core.hooksPath` check. Verifies that the local repo
// is configured to use the configured hookPath. Skipped in CI where
// hooks aren't expected to fire (env `DF_DOCTOR_SKIP_HOOKS=1` or
// `DF_DOCTOR_CI=1`).
async function checkGitHooksPath(
  rootDir: string,
  expectedHookPath: string,
): Promise<DoctorCheck> {
  if (process.env["DF_DOCTOR_SKIP_HOOKS"] === "1") {
    return {
      name: "git_core_hookspath",
      passed: true,
      detail: "skipped via DF_DOCTOR_SKIP_HOOKS=1",
    };
  }
  if (process.env["DF_DOCTOR_CI"] === "1") {
    return {
      name: "git_core_hookspath",
      passed: true,
      detail:
        "skipped via DF_DOCTOR_CI=1 (CI checkouts do not set core.hooksPath)",
    };
  }
  const configuredHookPath = await getGitConfig(rootDir, "core.hooksPath");
  const matches = configuredHookPath === expectedHookPath;
  return {
    name: "git_core_hookspath",
    passed: matches,
    detail: configuredHookPath
      ? `core.hooksPath=${configuredHookPath} (expected ${expectedHookPath})`
      : "core.hooksPath is not set",
    ...(matches
      ? {}
      : {
          remediation: `git config --local core.hooksPath ${expectedHookPath}`,
        }),
  };
}

// Generic Doppler-on-PATH probe. We don't run `doppler run --project
// ... --config ... -- printenv ANY_KEY` because:
//   - The key name is consumer-specific (sage's CURSOR_API_KEY isn't
//     portable to a generic OSS tool).
//   - The adapters' own `doctor()` will probe their own keys (or
//     subscription tokens) anyway.
// The OSS doctor's question is simpler: "is the doppler binary
// reachable so the Doppler re-exec gate can fire?"
async function checkDopplerOnPath(loaded: LoadedConfig): Promise<DoctorCheck> {
  if (process.env["DF_DOCTOR_SKIP_DOPPLER"] === "1") {
    return {
      name: "doppler_cli_on_path",
      passed: true,
      detail: "skipped via DF_DOCTOR_SKIP_DOPPLER=1",
    };
  }
  if (process.env["DF_DOCTOR_CI"] === "1") {
    return {
      name: "doppler_cli_on_path",
      passed: true,
      detail:
        "skipped via DF_DOCTOR_CI=1 (CI uses platform secrets, not Doppler runtime)",
    };
  }
  const dop = loaded.config.secrets?.doppler;
  if (!dop) {
    return {
      name: "doppler_cli_on_path",
      passed: true,
      detail: "no Doppler scope configured — nothing to check",
    };
  }
  return new Promise<DoctorCheck>((resolvePromise) => {
    let settled = false;
    const settle = (check: DoctorCheck): void => {
      if (settled) return;
      settled = true;
      resolvePromise(check);
    };
    let child;
    try {
      child = spawn("doppler", ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      settle({
        name: "doppler_cli_on_path",
        passed: false,
        detail: `failed to spawn doppler: ${(err as Error).message}`,
        remediation:
          "install Doppler (https://docs.doppler.com/docs/install-cli) or set DF_DOCTOR_SKIP_DOPPLER=1",
      });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({
        name: "doppler_cli_on_path",
        passed: false,
        detail: "doppler --version timed out",
        remediation:
          "verify Doppler installation and that the binary is responsive",
      });
    }, 3_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        settle({
          name: "doppler_cli_on_path",
          passed: false,
          detail: "doppler CLI not on PATH",
          remediation:
            "install Doppler (https://docs.doppler.com/docs/install-cli) or set DF_DOCTOR_SKIP_DOPPLER=1",
        });
        return;
      }
      settle({
        name: "doppler_cli_on_path",
        passed: false,
        detail: `doppler --version errored: ${err.message}`,
        remediation: "verify Doppler installation",
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        settle({
          name: "doppler_cli_on_path",
          passed: true,
          detail: `doppler CLI reachable (scope ${dop.project}/${dop.config})`,
        });
      } else {
        settle({
          name: "doppler_cli_on_path",
          passed: false,
          detail: `doppler --version exited ${code}`,
          remediation: "verify Doppler installation and PATH",
        });
      }
    });
  });
}

const BOOTSTRAP_REMEDIATION =
  "set DOPPLER_TOKEN in your shell, or for husky hooks add it (or your service-token alias) to <main-checkout>/.env (the bootstrap loader will hoist it from any worktree).";

function nodeVersionOk(): boolean {
  const major = Number((process.versions.node ?? "0").split(".")[0]);
  return major >= 20;
}

async function getGitConfig(cwd: string, key: string): Promise<string | null> {
  return new Promise<string | null>((resolvePromise) => {
    const child = spawn("git", ["config", "--local", "--get", key], { cwd });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else resolvePromise(null);
    });
    child.on("error", () => resolvePromise(null));
  });
}

function canCreateDir(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Issue #51 — `df doctor` 3-state triage classification.
//
// `cmdDoctor` today emits a flat list of per-check INFO/OK/FAIL lines.
// When the underlying state is "no profiles block at all" or "profile
// missing", the headline failure is buried under per-critic noise.
// `classifyDoctorState` distinguishes three top-level states the
// caller renders FIRST, before the per-check block:
//
//   1. `config_missing`      — no `profiles` block, OR named profile
//                              missing from `profiles`. ALWAYS takes
//                              precedence over per-critic auth signals
//                              because the missing profile is the more
//                              actionable diagnosis.
//   2. `auth_pending`        — config + named profile are OK, but one
//                              or more REQUIRED critics' auth checks
//                              failed. Optional critics (tagged
//                              `optional: true` by `runDoctor`) and
//                              base-infra checks (node, hooks, doppler)
//                              are intentionally excluded so a
//                              shadow-mode critic doesn't downgrade
//                              the state.
//   3. `ok`                  — everything that COULD be checked passed.
//                              This is the "config + auth both OK"
//                              terminal state.
//
// Pure: takes only the loaded config, the resolved profile name, and
// the per-check DoctorChecks array already collected by `runDoctor`. No
// I/O, no env reads, no time dependence. Unit tests stub the
// per-check array directly.
// ---------------------------------------------------------------------------

export type DoctorTriageState =
  | "config_missing"
  | "auth_pending"
  | "ok";

export interface ClassifyDoctorStateOptions {
  config: AgentReviewConfig;
  /**
   * The resolved profile name the CLI used. `undefined` means the
   * caller invoked `df doctor` without `--profile` AND no
   * `AGENT_REVIEW_PROFILE` was set — only meaningful in back-compat
   * configs that have no `profiles` map at all.
   */
  profileName: string | undefined;
  /**
   * The per-check DoctorCheck array `runDoctor` returns. The
   * classifier inspects only the per-critic auth checks
   * (`<criticId>.<probe>` names) — base-infra checks are intentionally
   * ignored so a missing node binary doesn't masquerade as a
   * subscription-auth failure.
   */
  perCriticChecks: readonly DoctorCheck[];
}

export interface DoctorTriageResult {
  state: DoctorTriageState;
  /**
   * Single-line headline (no embedded newlines). Format: `[<TAG>] ...`
   * where TAG is one of `CONFIG`, `AUTH`, `OK`. The bracketed prefix
   * makes the line greppable AND distinguishes it from the per-check
   * `[OK]/[INFO]/[FAIL]` lines `cmdDoctor` emits underneath.
   */
  line: string;
}

export function classifyDoctorState(
  options: ClassifyDoctorStateOptions,
): DoctorTriageResult {
  const { config, profileName, perCriticChecks } = options;

  // (1) config_missing — checked FIRST. A missing profiles block (or a
  // typo'd profile name) is the most actionable diagnosis; the
  // per-critic auth checks are moot until the profile is resolvable.
  if (profileName !== undefined) {
    if (!config.profiles) {
      return {
        state: "config_missing",
        line: `[CONFIG] config_missing: .agent-review/config.json has no 'profiles' block (requested profile: "${profileName}"). Add a 'profiles' map; mirror sage3c's pattern.`,
      };
    }
    if (!config.profiles[profileName]) {
      const available = Object.keys(config.profiles);
      const availableStr = available.length > 0 ? available.join(", ") : "(none)";
      return {
        state: "config_missing",
        line: `[CONFIG] config_missing: profile "${profileName}" not found in .agent-review/config.json profiles map (available: ${availableStr}).`,
      };
    }
  }

  // (2) auth_pending — config + profile both resolved. Walk the
  // per-critic checks: a failing check whose name starts with
  // `<criticId>.` AND is not flagged `optional: true` means a REQUIRED
  // critic's auth/credentials probe failed.
  const failingCriticAuth = perCriticChecks.filter((c) => {
    if (c.passed) return false;
    if (c.optional) return false;
    return isCriticAuthCheckName(c.name);
  });
  if (failingCriticAuth.length > 0) {
    const criticIds = uniq(
      failingCriticAuth.map((c) => c.name.split(".")[0] ?? c.name),
    );
    return {
      state: "auth_pending",
      line: `[AUTH] auth_pending: config OK but workstation auth pending for ${criticIds.join(", ")} — run \`df doctor --profile <name>\` for per-critic remediation.`,
    };
  }

  // (3) ok — everything passed. Surface a clear all-clear line so an
  // operator who runs `df doctor` after fixing the failure sees an
  // explicit success signal.
  return {
    state: "ok",
    line: `[OK] config + auth both OK${profileName !== undefined ? ` (profile: "${profileName}")` : ""}.`,
  };
}

function isCriticAuthCheckName(name: string): boolean {
  // `runDoctor` namespaces per-critic checks as `<criticId>.<probe>`.
  // Base-infra checks (`node_version`, `hook_post-commit`,
  // `artifact_dir_writable`, `doppler_*`, `git_core_hookspath`) have
  // no `.` in the first half of the name. Treat any name containing
  // a `.` as a per-critic check.
  return name.includes(".");
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

// ---------------------------------------------------------------------------
// Issue #105 — orphan-lock sweep.
//
// `df review` writes `.git/agent-reviews/<sha>.lock` containing its PID
// + an ISO timestamp. When the process is killed mid-run (SIGKILL, OOM,
// container teardown) the lock orphans and blocks every subsequent
// review of that SHA. `sweepOrphanLocks` walks the artifact dir, parses
// each lock's first line as a PID, and removes the lock when
// `process.kill(pid, 0)` reports ESRCH (no such process).
// ---------------------------------------------------------------------------

export function sweepOrphanLocks(artifactDir: string): DoctorCheck {
  if (!existsSync(artifactDir)) {
    return {
      name: "orphan_lock_sweep",
      passed: true,
      detail: `artifact dir not present at ${artifactDir} — no orphan locks to sweep`,
    };
  }
  let entries: string[];
  try {
    entries = readdirSync(artifactDir);
  } catch (err) {
    return {
      name: "orphan_lock_sweep",
      passed: false,
      detail: `failed to enumerate ${artifactDir}: ${(err as Error).message}`,
      remediation: `verify ${artifactDir} is readable`,
    };
  }
  const removed: Array<{ name: string; pid: number | null; reason: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".lock")) continue;
    const path = resolve(artifactDir, entry);
    const parsed = readLockPid(path);
    if (parsed.pid === null) {
      try {
        unlinkSync(path);
        removed.push({ name: entry, pid: null, reason: parsed.reason });
      } catch {
        // best-effort; a racing process may have removed it already
      }
      continue;
    }
    if (isPidAlive(parsed.pid)) continue;
    try {
      unlinkSync(path);
      removed.push({ name: entry, pid: parsed.pid, reason: "dead PID" });
    } catch {
      // best-effort
    }
  }
  if (removed.length === 0) {
    return {
      name: "orphan_lock_sweep",
      passed: true,
      detail: `no orphan locks under ${artifactDir}`,
    };
  }
  const summary = removed
    .map((r) => `${r.name} (pid=${r.pid ?? "unreadable"}: ${r.reason})`)
    .join(", ");
  return {
    name: "orphan_lock_sweep",
    passed: true,
    detail: `${removed.length} orphan lock(s) removed under ${artifactDir}: ${summary}`,
  };
}

function readLockPid(path: string): { pid: number | null; reason: string } {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    return { pid: null, reason: `read failed: ${(err as Error).message}` };
  }
  const firstLine = contents.split("\n")[0]?.trim() ?? "";
  if (firstLine === "") {
    return { pid: null, reason: "empty lock file" };
  }
  const n = Number(firstLine);
  if (!Number.isInteger(n) || n <= 0) {
    return { pid: null, reason: `unparseable PID "${firstLine}"` };
  }
  return { pid: n, reason: "" };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM means the process exists but we lack permission to signal it
    // → still alive from a lock-ownership perspective. ESRCH means no
    // such process → orphan. Any other code: treat as alive to err on
    // the side of NOT removing a possibly-live lock.
    if (e.code === "ESRCH") return false;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Issue #107 — cache-tree corruption probe.
//
// Detects the specific corruption shape `dark-factory-platform#170`
// reproduced: the index's cache-tree references an object (tree or
// blob) that doesn't exist in `.git/objects/`. This is the state a
// killed-mid-write `git commit` leaves the worktree in — the cache-tree
// has been updated to reference the new tree SHA, but the tree object
// itself was never finalised before the process was killed.
//
// Probe shape: `git fsck --no-dangling` with LC_ALL=C / LANG=C, a
// bounded buffer and a timeout. When the cache-tree is dangling, fsck
// emits a line containing `invalid sha1 pointer in cache-tree`
// (git 2.39.x short form) or `invalid sha1 pointer in cache-tree of
// <path>` (git 2.50.x long form) — the regex accepts both. Adjacent
// bad-repo states (broken HEAD ref, missing blob NOT in cache-tree,
// dangling orphan objects) emit different error messages, so the
// probe is specific without being noisy.
//
// Detect-only: the recovery (`git read-tree HEAD`) discards staged
// work. The operator must decide whether to preserve the staged
// changes (re-add them after `read-tree`) or accept the loss. The
// probe surfaces the diagnosis + remediation hint and nothing more.
//
// Async: `git fsck` walks the entire object database and can take
// seconds-to-minutes on large repos. The probe is `async` so it
// doesn't freeze `runDoctor`'s overall event loop.
// ---------------------------------------------------------------------------

// Accept BOTH the git-2.39.x short form ("invalid sha1 pointer in
// cache-tree" with a word boundary) AND the git-2.50.x long form
// (suffixed with " of <path>"). Earlier revisions required the
// trailing " of", which silently fail-passed on git 2.39 (Debian 12).
export const CACHE_TREE_CORRUPTION_REGEX =
  /invalid sha1 pointer in cache-tree(?:\b| of)/;

const RECOVERY_REMEDIATION =
  "Run `git read-tree HEAD` in the affected worktree to rebuild the index from HEAD's tree — WARNING: this discards any staged changes; re-add them after recovery if needed.";

// 50 MB stdout/stderr ceiling. Real cache-tree-corruption stderr is
// O(KB); the ceiling exists to bound runaway fsck output on
// pathological repos. ENOBUFS-shape overflow is treated as
// non-passing, NOT silent pass.
const FSCK_BUFFER_BYTES = 50 * 1024 * 1024;
// 30 s wall-clock ceiling. fsck on huge repos can run for minutes; the
// probe is a doctor check, so we'd rather report indeterminate than
// hold up the rest of the doctor run forever. Overridable via
// `DF_CACHE_TREE_PROBE_TIMEOUT_MS` for testing the timeout path
// without making test suites wait 30s.
function fsckTimeoutMs(): number {
  const env = process.env["DF_CACHE_TREE_PROBE_TIMEOUT_MS"];
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 30_000;
}

interface FsckResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: NodeJS.ErrnoException;
  overflowed: boolean;
  timedOut: boolean;
}

function runGitFsck(repoRoot: string): Promise<FsckResult> {
  return new Promise<FsckResult>((resolvePromise) => {
    let settled = false;
    const settle = (r: FsckResult): void => {
      if (settled) return;
      settled = true;
      resolvePromise(r);
    };
    let child;
    try {
      child = spawn("git", ["fsck", "--no-dangling"], {
        cwd: repoRoot,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      settle({
        stdout: "",
        stderr: "",
        code: null,
        signal: null,
        spawnError: err as NodeJS.ErrnoException,
        overflowed: false,
        timedOut: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let total = 0;
    let overflowed = false;
    const onData = (which: "stdout" | "stderr") => (c: Buffer) => {
      total += c.length;
      if (total > FSCK_BUFFER_BYTES) {
        if (!overflowed) {
          overflowed = true;
          child.kill("SIGKILL");
        }
        return;
      }
      if (which === "stdout") stdout += c.toString("utf8");
      else stderr += c.toString("utf8");
    };
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, fsckTimeoutMs());
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({
        stdout,
        stderr,
        code: null,
        signal: null,
        spawnError: err as NodeJS.ErrnoException,
        overflowed,
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      settle({
        stdout,
        stderr,
        code,
        signal,
        overflowed,
        timedOut,
      });
    });
  });
}

export async function probeCacheTree(repoRoot: string): Promise<DoctorCheck> {
  if (!existsSync(resolve(repoRoot, ".git"))) {
    // `df doctor`'s base-infra checks already cover the
    // "not-a-git-repo" case (artifact_dir_writable + git_core_hookspath
    // both fail). Surface this informationally so the probe doesn't
    // throw / fail-closed on the wrong condition.
    return {
      name: "cache_tree_probe",
      passed: true,
      detail: `${repoRoot} is not a git working tree — cache-tree probe skipped`,
    };
  }
  const result = await runGitFsck(repoRoot);
  const combined = `${result.stdout}\n${result.stderr}`;

  // Inspect captured output for the corruption signature FIRST. A
  // realistic mid-corruption fsck both prints the signature AND exits
  // non-zero — handle the diagnostic path before the generic
  // error-reporting paths so the operator sees the actionable line.
  if (CACHE_TREE_CORRUPTION_REGEX.test(combined)) {
    const matches = combined.matchAll(
      /([0-9a-f]{40}): invalid sha1 pointer in cache-tree(?: of (\S+))?/g,
    );
    const offenders = Array.from(matches).map((m) => ({
      sha: m[1] ?? "(unknown)",
      indexPath: m[2] ?? "(unknown)",
    }));
    const detail =
      offenders.length > 0
        ? `cache-tree references missing object${offenders.length > 1 ? "s" : ""}: ${offenders
            .map((o) => `${o.sha} in ${o.indexPath}`)
            .join("; ")}`
        : `git fsck reported cache-tree corruption: ${combined.trim()}`;
    return {
      name: "cache_tree_probe",
      passed: false,
      detail,
      remediation: RECOVERY_REMEDIATION,
    };
  }

  if (result.overflowed) {
    return {
      name: "cache_tree_probe",
      passed: false,
      detail: `git fsck output exceeded ${FSCK_BUFFER_BYTES} bytes — cannot determine cache-tree state; output was truncated.`,
      remediation:
        "investigate the repo's object database manually (`git fsck --no-dangling 2>&1 | head -50`); cache-tree probe is inconclusive at this output volume",
    };
  }

  if (result.timedOut) {
    return {
      name: "cache_tree_probe",
      passed: false,
      detail: `git fsck exceeded ${fsckTimeoutMs()}ms — cache-tree state indeterminate`,
      remediation:
        "run `git fsck --no-dangling` manually; the probe times out on very large repos",
    };
  }

  if (result.spawnError) {
    // ENOENT (git not on PATH) is genuinely informational — the rest of
    // `df doctor` (which all shells out to git) will surface that
    // diagnostic loudly. Don't double-report. Other spawn errors
    // (EACCES, etc.) ARE surfaced because they indicate environment
    // problems the operator should know about.
    if (result.spawnError.code === "ENOENT") {
      return {
        name: "cache_tree_probe",
        passed: true,
        detail: `git fsck not runnable in ${repoRoot}: ${result.spawnError.message}`,
      };
    }
    return {
      name: "cache_tree_probe",
      passed: false,
      detail: `git fsck failed to spawn in ${repoRoot}: ${result.spawnError.message}`,
      remediation:
        "verify the git binary is installed, on PATH, and executable from the repository working directory",
    };
  }

  // No corruption signature, no overflow, no spawn error. A non-zero
  // fsck exit (broken ref, missing blob NOT in cache-tree, etc.) is
  // out-of-scope for THIS probe — `df doctor` covers ref/object
  // integrity via other surfaces. The cache-tree-specific answer
  // here is "no cache-tree corruption observed".
  return {
    name: "cache_tree_probe",
    passed: true,
    detail: `git fsck reports no cache-tree corruption in ${repoRoot}`,
  };
}
