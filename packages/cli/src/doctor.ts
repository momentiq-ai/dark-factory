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
import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
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
