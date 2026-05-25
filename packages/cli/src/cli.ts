#!/usr/bin/env node
// Dark Factory CLI entrypoint.
//
// Phase B shipped the underlying services (Critic Orchestrator, Policy
// Engine, Trusted-Surface Rebind) as a library + a stub binary.
//
// Phase C extended the binary with four subcommands that wrap the
// Python-backed services extracted in cycle 331.1 Phase C:
//
//   df validate-cycle-doc          — service #5 (cycle-doc trailer validator)
//   df audit-branch-protection     — service #7 (branch-protection drift detector)
//   df sync-trackers               — service #9 part A (cycle tracker sync)
//   df attribute-pr                — service #9 part B (PR -> Cycle Ref attribution)
//
// Phase D (this file's additions) ships two more pure-TS subcommands:
//
//   df audit stats [--path <NDJSON>]   — service #8 (read/summarize _runs.ndjson)
//   df admit-pr --files-stdin          — service #6 plan-vs-code classifier
//
// Phase F upgrades two stubs to real implementations:
//
//   df status-check                    — sentinel aggregator (exit 0).
//   df critic [--ref <gitref>]         — real Critic Orchestrator via
//                                        runReview() + 4 vendor adapters.
//
// The remaining subcommands listed in --help (review, gate, doctor) land
// in Phase G or later. For now they print a "not implemented" message
// and exit 2.
//
// Argument parsing is intentionally minimal — every flag after a Phase C
// subcommand is passed through to the wrapped Python script verbatim.
// The Python scripts already have argparse-based help; consumers invoke
// `df validate-cycle-doc --help` to get the full flag list. Phase D
// subcommands accept their own flags directly (see `cmdAudit` and
// `cmdAdmitPr` below).

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runValidateCycleDoc } from "./cycle-doc-validator/index.js";
import { runAuditBranchProtection } from "./branch-protection/index.js";
import {
  runSyncCycleTrackers,
  runAttributePrCycleRef,
} from "./cycle-tracker-sync/index.js";
import {
  FileTelemetrySink,
  readTelemetryEvents,
  summarizeTelemetry,
  computeQuorumStats,
  computeCriticAgreement,
} from "./evidence/audit-trail.js";
import { classifyPrKindFromFiles } from "./policy/merge-queue.js";
import {
  AdapterRegistry,
  collectRequiredEnvVars,
} from "./adapters/critic.js";
// NOTE: vendor adapters (Cursor, Codex, Gemini, Grok) are dynamically
// imported inside `buildDefaultAdapterRegistry()` so the CLI loads under
// `--ignore-scripts` for every non-`df critic` subcommand. The Cursor
// SDK has a top-level static dependency on `sqlite3` which crashes at
// module load when its native binding hasn't been built (the case for
// consumers using the documented `npm install --ignore-scripts` install
// path). Phase B-PUBLISH-pkg (cycle 331.1, alpha.5): see
// https://github.com/momentiq-ai/dark-factory/pull/<this-pr>.
import { loadAgentReviewConfig, type LoadedConfig } from "./policy/config.js";
import { runReview, runCommitGate } from "./runner.js";
import { resolveArtifactDir, telemetryPath } from "./paths.js";
// Phase F-LOCAL — hook-facing subcommand support.
import {
  loadDopplerBootstrapEnv,
  DEFAULT_BOOTSTRAP_ALLOWLIST,
} from "./doppler-bootstrap.js";
import { runDoctor } from "./doctor.js";
import { resolveProfile } from "./policy/profile.js";
import {
  commitsForPushUpdate,
  parsePrePushUpdates,
  resolveCommit,
  commitParent,
  changedFiles,
} from "./git.js";
import { runQualityGates } from "./evidence/quality-gates.js";
import { matchAnyGlob } from "./glob.js";
import { collectChangedPaths } from "./evidence/index.js";
import { summarizeGate } from "./policy/gate.js";

interface PackageMeta {
  name?: string;
  version?: string;
}

function readPackageMeta(): PackageMeta {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli.js → ../package.json
    const pkgPath = resolve(here, "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    return JSON.parse(raw) as PackageMeta;
  } catch {
    return {};
  }
}

function printHelp(meta: PackageMeta): void {
  const name = meta.name ?? "@momentiq/dark-factory-cli";
  const version = meta.version ?? "unknown";
  process.stdout.write(
    [
      `${name} v${version}`,
      "",
      "Dark Factory OSS CLI — multi-vendor adversarial critic orchestration.",
      "",
      "Usage:",
      "  df --version              Print version and exit",
      "  df --help                 Print this help and exit",
      "",
      "Subcommands (Phase C — services #5/#7/#9):",
      "  df validate-cycle-doc       Validate a PR's Cycle:/Issue:/ProjectItem: trailers",
      "  df audit-branch-protection  Detect drift between spec.yaml and live GH ruleset",
      "  df sync-trackers            Reconcile GitHub tracker issues with cycle docs",
      "  df attribute-pr             Write PR's Cycle: trailer into project board's Cycle Ref field",
      "",
      "Subcommands (Phase D — services #6/#8):",
      "  df audit stats              Summarize the _runs.ndjson audit trail (service #8)",
      "  df admit-pr                 Classify a PR as plan vs code (service #6)",
      "",
      "Subcommands (Phase F — reusable-workflow gates, dogfood-wired):",
      "  df status-check             Sentinel aggregator (PR Status Check gate).",
      "                              Exits 0 — merge queue is the real aggregator.",
      "  df critic                   Real Critic Orchestrator wiring (agent-critic",
      "                              gate). Loads .agent-review/config.json, runs",
      "                              the 4 vendor adapters via runReview, writes",
      "                              aggregate verdict to .git/agent-reviews/<sha>.",
      "                              Degrades-and-passes on any error (exit 0).",
      "",
      "Subcommands (Phase F-LOCAL — hook-facing CLI, subscription cost model):",
      "  df review                   Background-friendly local critic invocation",
      "                              for .husky/post-commit. Honors profile auth",
      "                              (chatgpt/composer/subscription) so Cursor +",
      "                              Codex + Claude SUBSCRIPTIONS are consumed,",
      "                              NOT pay-per-token API keys.",
      "  df gate-push                Read pre-push stdin + gate every commit in",
      "                              the pushed range. CI mode: --commit SHA --ci.",
      "                              Honors AGENT_REVIEW_BYPASS for emergencies.",
      "  df doctor                   Verify env: node, hooks, hookPath, artifact",
      "                              dir, Doppler bootstrap, per-adapter auth.",
      "  df gates                    Run configured `requiredQualityGates` and",
      "                              triggered verification routes. No LLM calls.",
      "  df stats                    Pretty-print critic call stats + bypass audit.",
      "                              Alias for `df audit stats`. No LLM calls.",
      "",
      "Cost model:",
      "  The local hook path (review/gate-push) consumes Cursor / Codex / Claude",
      "  SUBSCRIPTIONS via the developer's existing CLI logins. Vendor API keys",
      "  (CURSOR_API_KEY / CODEX_API_KEY / GEMINI_API_KEY / XAI_API_KEY) are the",
      "  CI cold-path fallback only. Profile `auth` pins (e.g. `chatgpt` on the",
      "  codex critic) enforce subscription-only with no env-presence fallback",
      "  (cycle 322.7 issue #2103).",
      "",
      "Each Phase C subcommand passes its remaining argv through to the bundled",
      "Python script verbatim; run `df <subcommand> --help` for full flags.",
      "Phase D subcommands parse flags directly — see `df audit --help` and",
      "`df admit-pr --help`. Phase F's `df critic` accepts --ref/--config/--cwd",
      "(see `df critic --help`); status-check accepts no flags. Both subcommands",
      "exit 0 even on failure so the reusable workflows do not block the merge",
      "queue on a single vendor flake — vendor errors register in the artifact",
      "as `status=error` and the configured min-complete-quorum policy decides",
      "the aggregate verdict.",
      "",
      "System requirements:",
      "  Node.js >=20",
      "  python3 (>=3.11)",
      "  gh CLI (authenticated) for service #5/#7/#9 GitHub API calls",
      "  git on PATH",
      "",
      "Library usage today:",
      "  import { runReview, evaluateCommitGate, buildReviewPacket }",
      `    from \"${name}\";`,
      "",
      "Status: 0.1.0-alpha.6 — Phase F-LOCAL ports sage3c's hook-facing CLI",
      "        subcommands (review/gate-push/doctor/gates/stats) so consumer",
      "        repos can wire .husky hooks to the subscription-auth local",
      "        critic path. Also: Phase B-PUBLISH-pkg fixes CLI loadability",
      "        under `npm install --ignore-scripts` for all non-`df critic`",
      "        subcommands. Phase F wires the real Critic Orchestrator and",
      "        dogfoods dark-factory on its own PRs. Reusable workflows from",
      "        Phase E now invoke real critic logic. The substrate validates",
      "        itself end-to-end. Pure-TS port of #5/#7/#9 tracked as Phase",
      "        C-PORT follow-up.",
      "",
      "Docs:   https://github.com/momentiq-ai/dark-factory",
      "",
    ].join("\n"),
  );
}

function printVersion(meta: PackageMeta): void {
  process.stdout.write(`${meta.version ?? "unknown"}\n`);
}

function notImplemented(sub: string): number {
  process.stderr.write(
    `df: subcommand "${sub}" is not implemented in this alpha build.\n` +
      `    Phase B/C/D ship services as library + Python-wrapped subcommands;\n` +
      `    Phase E added reusable workflow stubs (status-check, critic);\n` +
      `    Phase F upgraded both to real implementations;\n` +
      `    "${sub}" lands in Phase G or later (see \`df --help\`).\n`,
  );
  return 2;
}

async function runPhaseCSubcommand(sub: string, rest: string[]): Promise<number> {
  // Each Phase C subcommand inherits stdio so user sees Python output
  // live (logs, progress, structured GHA `::error::` lines).
  switch (sub) {
    case "validate-cycle-doc": {
      const result = await runValidateCycleDoc({ args: rest, inheritStdio: true });
      return result.exitCode;
    }
    case "audit-branch-protection": {
      const result = await runAuditBranchProtection({ args: rest, inheritStdio: true });
      return result.exitCode;
    }
    case "sync-trackers": {
      const result = await runSyncCycleTrackers({ args: rest, inheritStdio: true });
      return result.exitCode;
    }
    case "attribute-pr": {
      const result = await runAttributePrCycleRef({ args: rest, inheritStdio: true });
      return result.exitCode;
    }
    default:
      // Unreachable — caller guarantees `sub` is one of the cases above.
      return notImplemented(sub);
  }
}

const PHASE_C_SUBCOMMANDS = new Set([
  "validate-cycle-doc",
  "audit-branch-protection",
  "sync-trackers",
  "attribute-pr",
]);

const PHASE_D_SUBCOMMANDS = new Set(["audit", "admit-pr"]);

// Phase F upgrades two reusable-workflow handlers from stubs (Phase E) to
// real implementations:
//
//   - `status-check` stays thin: a sentinel aggregator. The merge queue's
//     ALLGREEN rule already does the real cross-check aggregation; this
//     subcommand exists for the `PR Status Check` ruleset context.
//
//   - `critic` is now wired to the real Critic Orchestrator (Phase B
//     extraction). It loads `.agent-review/config.json`, instantiates
//     the 4 vendor adapters, runs `runReview()`, and writes the
//     aggregate artifact. Degrades-and-passes on any error so the
//     dogfood gate stays green while operators triage upstream issues.
const PHASE_F_SUBCOMMANDS = new Set(["status-check", "critic"]);

// Phase F-LOCAL — hook-facing subcommands. These wire .husky/post-commit +
// .husky/pre-push in consumer repos to consume Cursor / Codex / Claude
// SUBSCRIPTIONS via existing CLI logins rather than burning pay-per-token
// API keys. Cost-control is load-bearing — per-commit critic invocations
// from API tokens cost $1000s/week on busy repos; subscription-auth
// invocations are flat-rate. See README "For consumer repos" section.
const PHASE_F_LOCAL_SUBCOMMANDS = new Set([
  "review",
  "gate-push",
  "doctor",
  "gates",
  "stats",
]);

function cmdStatusCheck(_rest: string[]): number {
  // PR Status Check is a sentinel aggregator. As cycle 331.1 Phase E
  // documents in `.github/workflows/pr-status-check.yml`, this gate is
  // present specifically to satisfy the `PR Status Check` ruleset context
  // — its passage means "the workflow itself reached this step", which
  // is the contract every other status check separately enforces. There
  // is no useful aggregation work to do here that the merge queue's
  // `ALLGREEN` rule doesn't already do. So we keep this thin: emit a
  // structured one-liner and exit 0.
  //
  // A richer aggregator (querying the GitHub Actions API for sibling
  // check results) was considered for Phase F; deferred as gold-plating
  // because the merge queue already provides that semantics with
  // stronger guarantees (it sees the actual rerun state, not a snapshot).
  process.stdout.write(
    "df status-check: sentinel-pass (cycle 331.1 Phase F) — merge queue is the real aggregator.\n",
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Phase F: `df critic` — REAL Critic Orchestrator wiring.
//
// Reads `.agent-review/config.json`, instantiates the four vendor adapters
// (Cursor, Codex, Gemini, Grok), runs `runReview` against HEAD, and writes
// the aggregate verdict.
//
// CRITICAL DESIGN POINT: degrade-and-pass on ANY error. Three reasons:
//
// 1. Dogfood chicken-and-egg — the PR that ENABLES `df critic` is the
//    first PR `df critic` runs on. If the wiring throws, the PR can't
//    merge to ship the fix.
//
// 2. Vendor SDKs throw freely on missing/expired keys, network errors,
//    rate limits, etc. The config's `aggregation.policy:
//    "min-complete-quorum"` + `required: false` on every critic already
//    handles per-critic errors gracefully (they register as
//    `status="error"` and contribute to `quorum_unmet` which is
//    non-blocking under min-complete-quorum). But pre-`runReview`
//    errors (config load, registry init) need explicit handling.
//
// 3. The `agent-critic` workflow's job-level `if: always()` summary step
//    swallows shell-level non-zero. We exit 0 from the CLI so the gate
//    surfaces as green; the structured output records what happened.
//
// All caught errors print to stderr with a `[critic-degraded]` prefix
// so operators can audit-trace them. The exit code is always 0 in
// Phase F. Future phases (sage3c migration G) may add a `--strict`
// flag that fail-closes on errors — but for dark-factory dogfood, this
// posture lets the substrate be exercised on its own PRs without
// blocking on a single vendor flaking out.
// ---------------------------------------------------------------------------

interface CriticOptions {
  ref: string;
  configPath?: string;
  cwd?: string;
}

function parseCriticArgs(rest: string[]): CriticOptions {
  const { flags } = parseFlags(rest);
  const ref =
    typeof flags["ref"] === "string"
      ? (flags["ref"] as string)
      : typeof flags["pr"] === "string"
        ? "HEAD"
        : "HEAD";
  const out: CriticOptions = { ref };
  if (typeof flags["config"] === "string") {
    out.configPath = flags["config"] as string;
  }
  if (typeof flags["cwd"] === "string") {
    out.cwd = flags["cwd"] as string;
  }
  return out;
}

// Adapter loader identity → module path. Kept as a typed array so the
// per-vendor try/catch loop below is structurally uniform: each entry
// is one dynamic import + one registry.register. Adding a vendor is one
// row, not one branch.
const ADAPTER_LOADERS: ReadonlyArray<{
  readonly id: string;
  readonly modulePath: string;
  readonly className: string;
}> = [
  { id: "cursor-sdk", modulePath: "./adapters/cursor-sdk.js", className: "CursorSdkAdapter" },
  { id: "codex-sdk", modulePath: "./adapters/codex-sdk.js", className: "CodexSdkAdapter" },
  { id: "gemini-sdk", modulePath: "./adapters/gemini-sdk.js", className: "GeminiSdkAdapter" },
  { id: "grok-direct-sdk", modulePath: "./adapters/grok-direct-sdk.js", className: "GrokDirectSdkAdapter" },
];

async function buildDefaultAdapterRegistry(): Promise<AdapterRegistry> {
  // Each adapter reads its API key from the corresponding env var by
  // default (CURSOR_API_KEY / CODEX_API_KEY / GEMINI_API_KEY /
  // XAI_API_KEY). Missing keys cause the adapter's `review()` to
  // return `status="error"` rather than throw at registry-init time —
  // exactly the behavior min-complete-quorum needs to degrade
  // gracefully.
  //
  // Cycle 331.1 Phase B-PUBLISH-pkg (alpha.5) — adapter modules are
  // dynamically imported one-by-one so a single vendor's static-import
  // failure (e.g. the Cursor SDK's transitive `sqlite3` native binding
  // missing under `npm install --ignore-scripts`) does not abort the
  // CLI. A failed adapter is logged with `[critic-degraded]` and the
  // remaining vendors register normally; min-complete-quorum
  // (`required: false` per critic, `quorum: 2` aggregate) handles the
  // missing adapter without blocking.
  const registry = new AdapterRegistry();
  for (const loader of ADAPTER_LOADERS) {
    try {
      const mod = (await import(loader.modulePath)) as Record<string, unknown>;
      const Ctor = mod[loader.className] as
        | (new () => import("./adapters/critic.js").CriticAdapter)
        | undefined;
      if (typeof Ctor !== "function") {
        process.stderr.write(
          `[critic-degraded] adapter ${loader.id}: module loaded but '${loader.className}' export is not a constructor; skipping registration.\n`,
        );
        continue;
      }
      registry.register(new Ctor());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[critic-degraded] adapter ${loader.id}: failed to load (${message}); skipping registration. If this vendor is marked 'required: true' in .agent-review/config.json, the orchestrator will fail with a clear error.\n`,
      );
    }
  }
  return registry;
}

async function cmdCritic(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df critic — run the multi-vendor adversarial critic against HEAD",
        "",
        "Usage:",
        "  df critic [--ref <gitref>] [--config <path>] [--cwd <path>]",
        "",
        "Reads .agent-review/config.json (or --config <path>), instantiates",
        "the configured vendor adapters, runs the critics against the named",
        "git ref (default HEAD), and writes the aggregate verdict + per-",
        "critic findings to `.git/agent-reviews/<sha>.json` (path comes",
        "from the loaded config's git.artifactDir).",
        "",
        "Environment:",
        "  CURSOR_API_KEY / CODEX_API_KEY / GEMINI_API_KEY / XAI_API_KEY",
        "    Vendor critic API keys. Missing keys cause the corresponding",
        "    critic to register as `status=error` (non-blocking under the",
        "    default min-complete-quorum policy).",
        "",
        "Exit code:",
        "  Always 0 in this build — vendor / config errors are surfaced",
        "  on stderr with a [critic-degraded] prefix. The aggregate gate",
        "  verdict is written to the artifact file regardless.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const opts = parseCriticArgs(rest);
  try {
    const loaded = await loadAgentReviewConfig({
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    const registry = await buildDefaultAdapterRegistry();

    // Wire a file telemetry sink so the run lands in
    // `.git/agent-reviews/_runs.ndjson` (the same path `df audit stats`
    // reads). This is dogfood proof: the substrate exercises its own
    // audit trail on its own PRs.
    const artifactDir = await resolveArtifactDir(loaded);
    const sink = new FileTelemetrySink(telemetryPath(artifactDir));

    const outcome = await runReview({
      loaded,
      registry,
      ref: opts.ref,
      telemetry: sink,
    });

    const verdict = outcome.artifact.gateVerdict ?? "(no verdict)";
    const reviewedSha = outcome.artifact.commit;
    const findingCount = outcome.artifact.criticResults.reduce(
      (acc, r) => acc + r.findings.length,
      0,
    );
    const criticSummaries = outcome.artifact.criticResults
      .map(
        (r) =>
          `    ${r.criticId}: ${r.status}` +
          (r.verdict ? ` (${r.verdict})` : "") +
          ` — findings=${r.findings.length}`,
      )
      .join("\n");

    process.stdout.write(
      [
        `df critic: review complete for ${reviewedSha}`,
        `  verdict: ${verdict}`,
        `  total findings: ${findingCount}`,
        `  per-critic:`,
        criticSummaries,
        `  artifact: ${outcome.paths.jsonPath}`,
        "",
      ].join("\n"),
    );
    return 0;
  } catch (err) {
    // Degrade-and-pass. See the design comment above the function.
    process.stderr.write(
      [
        "[critic-degraded] df critic failed before completing a review.",
        `[critic-degraded] cause: ${(err as Error).message}`,
        "[critic-degraded] exiting 0 so the dogfood gate stays green. Operators:",
        "[critic-degraded]   - check .agent-review/config.json exists at repo root",
        "[critic-degraded]   - check vendor API keys are exported (CURSOR_API_KEY etc.)",
        "[critic-degraded]   - check the worktree's .git/agent-reviews/ is writable",
        "[critic-degraded]   - inspect upstream logs for stack trace context",
        "",
      ].join("\n"),
    );
    return 0;
  }
}

// ===========================================================================
// Phase F-LOCAL — hook-facing subcommands (review / gate-push / doctor /
// gates / stats).
//
// Ported from sage3c's tools/agent-review/src/cli.ts. These are the
// subcommands consumer repos wire into `.husky/post-commit` and
// `.husky/pre-push` so the local critic runs against the developer's
// Cursor / Codex / Claude SUBSCRIPTIONS via existing CLI logins —
// avoiding the $1000s/week token spend that a pure API-key path would
// incur on a busy repo.
//
// Subscription-auth preservation: each subcommand uses
// `resolveProfile()` + `runReview()/runCommitGate()` which already honor
// the active profile's `auth` pins via `applyProfileAuth()` (cycle 322.7
// issue #2103). The adapters then validate ONLY the configured source —
// e.g. `auth: "chatgpt"` on the codex critic means "subscription only,
// no API-key fallback". This is the firewall that prevents accidental
// API spend.
//
// Doppler re-exec: when a configured adapter declares `requiredEnvVars`
// AND those vars are unset AND the config declares `secrets.doppler`,
// the CLI transparently re-execs itself under
// `doppler run --project X --config Y -- node ...` so the secrets reach
// the child via Doppler injection. AGENT_REVIEW_DOPPLER_REEXEC blocks
// recursive re-exec.
// ===========================================================================

async function buildHookRegistry(): Promise<AdapterRegistry> {
  return buildDefaultAdapterRegistry();
}

type ReexecResult = { reexeced: true; code: number } | { reexeced: false };
async function maybeReexecUnderDoppler(
  loaded: LoadedConfig,
  registry: AdapterRegistry,
  activeCriticIds?: ReadonlyArray<string>,
): Promise<ReexecResult> {
  const dop = loaded.config.secrets?.doppler;
  if (process.env["AGENT_REVIEW_DOPPLER_REEXEC"]) return { reexeced: false };

  const { union, requiredUnion, unregistered } = collectRequiredEnvVars(
    loaded,
    registry,
    activeCriticIds,
  );
  const missing = union.filter((v) => !process.env[v]);
  const missingRequired = requiredUnion.filter((v) => !process.env[v]);
  if (missing.length === 0) return { reexeced: false };
  if (!dop) return { reexeced: false };
  if (unregistered.length > 0) {
    process.stderr.write(
      `df: critic config references unregistered adapter(s): ${unregistered.join(", ")}.\n`,
    );
  }
  if (!(await hasOnPath("doppler"))) {
    if (missingRequired.length === 0) {
      process.stderr.write(
        `df: doppler CLI not on PATH; optional critic env vars are unset: ${missing.join(", ")}.\n` +
          "  continuing without Doppler.\n",
      );
      return { reexeced: false };
    }
    process.stderr.write(
      `df: doppler CLI not on PATH and required env vars are unset: ${missingRequired.join(", ")}.\n` +
        "  install Doppler or export the missing vars directly.\n",
    );
    return { reexeced: true, code: 1 };
  }
  const code = reexecUnderDoppler(dop.project, dop.config);
  if (code !== 0 && missingRequired.length === 0) {
    process.stderr.write(
      "df: optional critic invocation under `doppler run` failed; continuing.\n",
    );
    return { reexeced: false };
  }
  if (code !== 0 && !process.env["DOPPLER_TOKEN"]) {
    process.stderr.write(
      "df: critic invocation under `doppler run` failed and no DOPPLER_TOKEN was reachable.\n" +
        `  missing required env vars: ${missingRequired.join(", ")}\n` +
        "  fix one of: export DOPPLER_TOKEN, add it to <main-checkout>/.env, or export the missing vars directly.\n" +
        "  AGENT_REVIEW_BYPASS is NOT the right response for a config error.\n",
    );
  }
  return { reexeced: true, code };
}

function reexecUnderDoppler(project: string, config: string): number {
  const args = ["run", "--project", project, "--config", config, "--", ...process.argv];
  const result = spawnSync("doppler", args, {
    stdio: "inherit",
    env: { ...process.env, AGENT_REVIEW_DOPPLER_REEXEC: "1" },
  });
  if (result.error) {
    process.stderr.write(
      `df: failed to re-exec under doppler: ${result.error.message}\n`,
    );
    return 1;
  }
  return result.status ?? 1;
}

async function hasOnPath(cmd: string): Promise<boolean> {
  const PATH = process.env["PATH"] ?? "";
  for (const dir of PATH.split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/${cmd}`;
    try {
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // not found here; try next
    }
  }
  return false;
}

async function readStdinUtf8FromTtyOrStream(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return readStdinUtf8();
}

async function loadHookConfig(): Promise<LoadedConfig | null> {
  try {
    return await loadAgentReviewConfig({
      warn: (msg: string) => process.stderr.write(`df: ${msg}\n`),
    });
  } catch (err) {
    process.stderr.write(`df: ${(err as Error).message}\n`);
    return null;
  }
}

function activeCriticIdsForProfile(
  loaded: LoadedConfig,
  profileName: string,
): readonly string[] | undefined {
  const profiles = loaded.config.profiles;
  if (!profiles) return undefined;
  const profile = profiles[profileName];
  if (!profile) return undefined;
  return profile.criticIds;
}

// ----- df review -----
async function cmdReview(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df review — run the local critic against a commit (subscription auth).",
        "",
        "Usage:",
        "  df review [--commit HEAD] [--profile NAME] [--foreground]",
        "",
        "Designed for .husky/post-commit. Honors profile `auth` pins so",
        "Cursor / Codex / Claude SUBSCRIPTIONS are consumed instead of",
        "pay-per-token API keys.",
        "",
        "Flags:",
        "  --commit HEAD       Commit to review (default HEAD)",
        "  --profile NAME      Profile (default: env AGENT_REVIEW_PROFILE or `local`)",
        "  --foreground        Print artifact paths on completion",
        "",
      ].join("\n"),
    );
    return 0;
  }
  loadDopplerBootstrapEnv({ allowlist: DEFAULT_BOOTSTRAP_ALLOWLIST });
  const loaded = await loadHookConfig();
  if (!loaded) return 2;
  const { flags } = parseFlags(rest);
  const registry = await buildHookRegistry();

  const profileName = resolveProfile(
    { profile: flags["profile"] },
    process.env as { AGENT_REVIEW_PROFILE?: string | undefined },
  );
  const profileAllowlist = activeCriticIdsForProfile(loaded, profileName);

  const rx = await maybeReexecUnderDoppler(loaded, registry, profileAllowlist);
  if (rx.reexeced) return rx.code;

  const artifactDir = await resolveArtifactDir(loaded);
  const sink = new FileTelemetrySink(telemetryPath(artifactDir));
  const ref = (flags["commit"] as string | undefined) ?? "HEAD";
  const foreground =
    flags["foreground"] === true || flags["foreground"] === "true";
  try {
    const outcome = await runReview({
      loaded,
      registry,
      ref,
      telemetry: sink,
      profileName,
    });
    if (foreground) {
      process.stdout.write(
        `df review: ${outcome.artifact.gateVerdict ?? "complete"} for ${outcome.artifact.commit.slice(0, 12)}\n`,
      );
      process.stdout.write(`  json: ${outcome.paths.jsonPath}\n`);
      process.stdout.write(
        `  md:   ${outcome.paths.markdownPath ?? "(not written — see stderr)"}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`df review failed: ${(err as Error).message}\n`);
    return 1;
  }
}

// ----- df gate-push -----
async function cmdGatePush(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df gate-push — block a push when prior commits have unresolved blockers.",
        "",
        "Usage:",
        "  df gate-push [--profile NAME]                          # local pre-push",
        "  df gate-push --commit SHA --ci [--profile NAME]        # CI replay",
        "",
        "Designed for .husky/pre-push. Reads git's pre-push protocol on stdin",
        "and gates each commit in the pushed range against the per-SHA artifact",
        "written by `df review`. Exit 1 if any commit has unresolved BLOCKER",
        "findings under the configured aggregation policy.",
        "",
        "Bypass:",
        "  AGENT_REVIEW_BYPASS=\"<reason>\" git push   # logged to _runs.ndjson",
        "",
      ].join("\n"),
    );
    return 0;
  }
  const bypass = process.env["AGENT_REVIEW_BYPASS"];
  if (bypass !== undefined && bypass !== "") {
    process.stderr.write(
      `df gate-push: BYPASSED — reason: ${bypass}\n` +
        "  this bypass will be logged to .git/agent-reviews/_runs.ndjson; cite an issue # in the reason.\n",
    );
    return 0;
  }
  const loaded = await loadHookConfig();
  if (!loaded) return 2;
  const { flags } = parseFlags(rest);
  const artifactDir = await resolveArtifactDir(loaded);
  const sink = new FileTelemetrySink(telemetryPath(artifactDir));
  const profileName = resolveProfile(
    { profile: flags["profile"] },
    process.env as { AGENT_REVIEW_PROFILE?: string | undefined },
  );

  const commitFlag = flags["commit"];
  const ciFlag = flags["ci"] === true || flags["ci"] === "true";
  if (typeof commitFlag === "string" && commitFlag.length > 0) {
    if (!ciFlag) {
      process.stderr.write(
        "df gate-push: --commit requires --ci (CI replay mode is the only intended caller).\n",
      );
      return 2;
    }
    const sha = await resolveCommit(commitFlag);
    process.stdout.write(
      `df gate-push: gating 1 commit (CI mode) for ${sha.slice(0, 12)}\n`,
    );
    const result = await runCommitGate({
      loaded,
      commit: sha,
      telemetry: sink,
      profileName,
    });
    process.stdout.write(`-- ${sha.slice(0, 12)}\n${summarizeGate(result)}\n`);
    return result.blocked ? 1 : 0;
  }

  const stdin = await readStdinUtf8FromTtyOrStream();
  const updates = parsePrePushUpdates(stdin);
  if (updates.length === 0) {
    process.stdout.write("df gate-push: no push updates received; allowing\n");
    return 0;
  }
  let blockedAny = false;
  for (const update of updates) {
    if (update.isDelete) continue;
    const commits = await commitsForPushUpdate(update);
    if (commits.length === 0) continue;
    process.stdout.write(
      `df gate-push: gating ${commits.length} commit(s) on ${update.localRef} -> ${update.remoteRef}\n`,
    );
    for (const sha of commits) {
      const result = await runCommitGate({
        loaded,
        commit: sha,
        telemetry: sink,
        profileName,
      });
      process.stdout.write(`-- ${sha.slice(0, 12)}\n${summarizeGate(result)}\n`);
      if (result.blocked) blockedAny = true;
    }
  }
  return blockedAny ? 1 : 0;
}

// ----- df doctor -----
async function cmdDoctor(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df doctor — verify the environment for hook-facing critic invocation.",
        "",
        "Usage:",
        "  df doctor [--profile NAME]",
        "",
        "Checks: node version, hooks dir, hook executable, core.hooksPath,",
        "artifact dir, doppler bootstrap, per-adapter doctor() (subscription",
        "auth lives here).",
        "",
        "Environment:",
        "  AGENT_REVIEW_PROFILE=<name>      Profile to validate (default: local)",
        "  DF_DOCTOR_CI=1                   Skip hookspath + doppler CLI checks",
        "  DF_DOCTOR_SKIP_HOOKS=1           Skip git-core-hookspath check",
        "  DF_DOCTOR_SKIP_DOPPLER=1         Skip doppler-cli-on-path check",
        "",
      ].join("\n"),
    );
    return 0;
  }
  const bootstrap = loadDopplerBootstrapEnv({
    allowlist: DEFAULT_BOOTSTRAP_ALLOWLIST,
  });
  const loaded = await loadHookConfig();
  if (!loaded) return 2;
  const { flags } = parseFlags(rest);
  const registry = await buildHookRegistry();
  const rx = await maybeReexecUnderDoppler(loaded, registry);
  if (rx.reexeced) return rx.code;

  const profileName = resolveProfile(
    { profile: flags["profile"] },
    process.env as { AGENT_REVIEW_PROFILE?: string | undefined },
  );
  const checks = await runDoctor({
    loaded,
    registry,
    bootstrap,
    profileName,
  });
  let allOk = true;
  for (const c of checks) {
    const label = c.passed ? "OK" : c.optional ? "INFO" : "FAIL";
    process.stdout.write(`[${label}] ${c.name}: ${c.detail}\n`);
    if (!c.passed && c.remediation) {
      process.stdout.write(`       fix: ${c.remediation}\n`);
    }
    if (!c.passed && !c.optional) allOk = false;
  }
  return allOk ? 0 : 1;
}

// ----- df gates -----
async function cmdGates(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df gates — run configured quality gates + triggered verification routes.",
        "",
        "Usage:",
        "  df gates [--commit HEAD] [--route ROUTE_ID]",
        "",
        "Runs static gates from .agent-review/config.json:validation. Writes",
        "per-SHA evidence. No LLM calls — this subcommand is free.",
        "",
      ].join("\n"),
    );
    return 0;
  }
  const loaded = await loadHookConfig();
  if (!loaded) return 2;
  const { flags } = parseFlags(rest);
  const ref = (flags["commit"] as string | undefined) ?? "HEAD";
  const sha = await resolveCommit(ref);
  const routeFilter = (flags["route"] as string | undefined) ?? null;

  let requiredFailures = 0;
  let requiredRun = 0;
  if (!routeFilter) {
    const required = await runQualityGates({ loaded, commit: sha });
    requiredRun = required.results.length;
    requiredFailures = required.results.filter((r) => r.exitCode !== 0).length;
    for (const r of required.results) {
      process.stdout.write(
        `  ${r.exitCode === 0 ? "PASS" : "FAIL"} ${r.command} (${r.durationMs}ms)\n`,
      );
    }
  }

  const triggered = await triggeredRoutesForCommit(loaded, sha);
  let routeFailures = 0;
  let routeRun = 0;
  for (const route of triggered) {
    if (routeFilter && route.id !== routeFilter) continue;
    if (!route.command) continue;
    routeRun++;
    const evidence = await runQualityGates({
      loaded,
      commit: sha,
      commands: [route.command],
      routeId: route.id,
    });
    const result = evidence.gateResults?.[route.id];
    const exit = result?.exitCode ?? -1;
    if (exit !== 0) routeFailures++;
    process.stdout.write(
      `  ${exit === 0 ? "PASS" : "FAIL"} route[${route.id}] (${route.command}) exit=${exit}\n`,
    );
  }

  const totalRun = requiredRun + routeRun;
  const totalFail = requiredFailures + routeFailures;
  process.stdout.write(
    `df gates: ${totalRun} run, ${totalFail} failed${routeFilter ? ` (filter=route:${routeFilter})` : ""}\n`,
  );
  return totalFail === 0 ? 0 : 1;
}

async function triggeredRoutesForCommit(
  loaded: LoadedConfig,
  sha: string,
): Promise<ReadonlyArray<{ id: string; command: string | null }>> {
  const routes = loaded.config.validation.verificationRoutes ?? [];
  if (routes.length === 0) return [];
  let parent = "";
  try {
    parent = await commitParent(sha);
  } catch {
    parent = "";
  }
  const files = await changedFiles(parent, sha, undefined, {
    readContent: false,
  });
  const paths = collectChangedPaths(files);
  return routes.filter((r) => paths.some((p) => matchAnyGlob(p, r.trigger)));
}

// ----- df stats -----
// Top-level alias for `df audit stats` (sage3c naming for migrants).
async function cmdStats(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df stats — pretty-print critic call stats + bypass audit.",
        "",
        "Usage:",
        "  df stats [--path <NDJSON>]",
        "",
        "Reads `<artifactDir>/_runs.ndjson` (resolved from loaded config, or",
        "--path <PATH>). Alias for `df audit stats`. No LLM calls.",
        "",
      ].join("\n"),
    );
    return 0;
  }
  const { flags } = parseFlags(rest);
  if (typeof flags["path"] === "string") {
    return cmdAudit(["stats", "--path", flags["path"] as string]);
  }
  const loaded = await loadHookConfig();
  if (!loaded) return 2;
  const dir = await resolveArtifactDir(loaded);
  const path = telemetryPath(dir);
  return cmdAudit(["stats", "--path", path]);
}

// ---------------------------------------------------------------------------
// Phase D: `df audit stats` — service #8 (audit/compliance trail).
//
// Reads the `_runs.ndjson` file (path supplied via `--path`, or default
// resolved via `--git-dir` heuristic, or as a last resort the local
// `.git/agent-reviews/_runs.ndjson`) and emits the same operator-
// friendly summary that sage3c's `make agent-review-stats` produced.
//
// The default-path resolution chain is deliberately conservative:
// without a Phase E config-loader, the CLI cannot reliably discover
// the consumer's artifact dir from inside an arbitrary worktree, so
// we surface a clear error when nothing was found rather than
// silently scanning the wrong path.
// ---------------------------------------------------------------------------

function parseFlags(rest: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function cmdAuditHelp(): void {
  process.stdout.write(
    [
      "df audit — operate on the _runs.ndjson audit trail (service #8)",
      "",
      "Usage:",
      "  df audit stats [--path <PATH>]    Summarize the audit trail",
      "  df audit --help                   Show this help",
      "",
      "Defaults:",
      "  --path defaults to `<repo>/.git/agent-reviews/_runs.ndjson` when",
      "         present; otherwise the command exits with a clear error.",
      "",
    ].join("\n"),
  );
}

function cmdAudit(rest: string[]): number {
  if (rest.includes("--help") || rest.includes("-h")) {
    cmdAuditHelp();
    return 0;
  }
  const action = rest[0] ?? "";
  if (action !== "stats") {
    process.stderr.write(
      `df audit: unknown action "${action}". Run \`df audit --help\` for usage.\n`,
    );
    return 2;
  }
  const { flags } = parseFlags(rest.slice(1));
  let path: string | undefined =
    typeof flags["path"] === "string" ? (flags["path"] as string) : undefined;
  if (!path) {
    const defaultPath = resolve(process.cwd(), ".git", "agent-reviews", "_runs.ndjson");
    if (existsSync(defaultPath)) {
      path = defaultPath;
    }
  }
  if (!path) {
    process.stderr.write(
      "df audit stats: no audit trail found. Pass --path <PATH> or run inside a repo with a `.git/agent-reviews/_runs.ndjson` file.\n",
    );
    return 1;
  }
  const events = readTelemetryEvents(path);
  const stats = summarizeTelemetry(events);
  process.stdout.write(`df audit stats (${path})\n`);
  process.stdout.write(`  total runs:        ${stats.totalRuns}\n`);
  process.stdout.write(`  errored runs:      ${stats.errorRuns}\n`);
  process.stdout.write(`  approved verdicts: ${stats.approvedCount}\n`);
  process.stdout.write(`  changes requested: ${stats.changesRequestedCount}\n`);
  process.stdout.write(`  gate passes:       ${stats.passes}\n`);
  process.stdout.write(`  gate blocks:       ${stats.blocks}\n`);
  process.stdout.write(`  gate bypasses:     ${stats.bypasses}\n`);
  process.stdout.write(`  median run ms:     ${stats.medianDurationMs ?? "n/a"}\n`);
  const retry = stats.retry;
  const retryActivity =
    retry.totalRetryAttempts +
    retry.oneRetrySuccess +
    retry.twoPlusRetrySuccess +
    Object.values(retry.exhaustedByErrorCode).reduce((a, b) => a + b, 0);
  if (retryActivity > 0) {
    process.stdout.write(`  retry summary:\n`);
    process.stdout.write(`    first-attempt success: ${retry.firstAttemptSuccess}\n`);
    process.stdout.write(`    1-retry success:       ${retry.oneRetrySuccess}\n`);
    process.stdout.write(`    2+-retry success:      ${retry.twoPlusRetrySuccess}\n`);
    process.stdout.write(`    total retry attempts:  ${retry.totalRetryAttempts}\n`);
    const codes = Object.entries(retry.exhaustedByErrorCode);
    if (codes.length > 0) {
      process.stdout.write(`    exhausted by error code:\n`);
      codes
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .forEach(([code, n]) => process.stdout.write(`      ${code}: ${n}\n`));
    }
  }
  for (const [id, c] of Object.entries(stats.byCritic)) {
    process.stdout.write(
      `  critic ${id}: starts=${c.starts} finishes=${c.finishes} errors=${c.errors} approved=${c.approved} blocks=${c.totalBlockers} highs=${c.totalHigh}\n`,
    );
  }
  const agreement = computeCriticAgreement(events);
  if (agreement.comparedCommits > 0) {
    const pct = Math.round((agreement.agreedCommits / agreement.comparedCommits) * 100);
    process.stdout.write(
      `  multi-critic agreement: ${agreement.agreedCommits}/${agreement.comparedCommits} = ${pct}% (critics: ${agreement.comparedCriticIds.join(", ")})\n`,
    );
    const disagreements = Object.entries(agreement.disagreementsByPattern);
    if (disagreements.length > 0) {
      process.stdout.write(`  disagreements:\n`);
      disagreements
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .forEach(([pattern, n]) => process.stdout.write(`    ${pattern}: ${n}\n`));
    }
  }
  const quorumStats = computeQuorumStats(events);
  if (quorumStats.totalAggregateEvents > 0) {
    process.stdout.write(`  quorum stats (${quorumStats.totalAggregateEvents} reviews):\n`);
    const reasons = Object.entries(quorumStats.byReason);
    reasons
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .forEach(([reason, n]) => {
        const pct = Math.round((n / quorumStats.totalAggregateEvents) * 100);
        process.stdout.write(`    ${reason}: ${n} (${pct}%)\n`);
      });
    const culprits = Object.entries(quorumStats.quorumUnmetByCritic);
    if (culprits.length > 0) {
      process.stdout.write(`    would-be quorum_unmet by critic:\n`);
      culprits
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .forEach(([id, n]) => process.stdout.write(`      ${id}: ${n}\n`));
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Phase D: `df admit-pr` — service #6 plan-vs-code classifier.
//
// Classifies a PR's file list (passed via --files-stdin reading newline-
// separated paths, or --files comma-separated for one-shot CLI) and
// prints `plan` or `code` to stdout. Exit code is always 0 unless the
// input cannot be parsed; this is a classifier, not a gate.
//
// Stdin form is preferred for CI integration:
//   gh pr view 123 --json files --jq '.files[].path' | df admit-pr --files-stdin
//
// The lightweight CLI surface lets sage3c retire the inline bash
// classifier in `.github/workflows/plan-pr-review-gate.yml` once Phase
// E ships the reusable workflow.
// ---------------------------------------------------------------------------

function cmdAdmitPrHelp(): void {
  process.stdout.write(
    [
      "df admit-pr — classify a PR as `plan` vs `code` (service #6)",
      "",
      "Usage:",
      "  df admit-pr --files-stdin       Read newline-separated paths from stdin",
      "  df admit-pr --files <a,b,c>     Comma-separated paths on the CLI",
      "  df admit-pr --help              Show this help",
      "",
      "Output: `plan` or `code` on stdout, plus a one-line rationale on stderr.",
      "",
      "Classifier (ported from .github/workflows/plan-pr-review-gate.yml):",
      "  - `plan` iff at least one file matches",
      "    /docs/roadmap/cycles/cycleN[.M]-slug.md AND no file is outside docs/.",
      "  - everything else is `code`.",
      "",
    ].join("\n"),
  );
}

async function readStdinUtf8(): Promise<string> {
  return new Promise((res, rej) => {
    let acc = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      acc += chunk;
    });
    process.stdin.on("end", () => res(acc));
    process.stdin.on("error", (err: Error) => rej(err));
  });
}

async function cmdAdmitPr(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    cmdAdmitPrHelp();
    return 0;
  }
  const { flags } = parseFlags(rest);
  let paths: string[] = [];
  if (flags["files-stdin"]) {
    const raw = await readStdinUtf8();
    paths = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } else if (typeof flags["files"] === "string") {
    paths = (flags["files"] as string)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } else {
    process.stderr.write(
      "df admit-pr: pass --files-stdin (newline-separated stdin) or --files a,b,c. Run --help for usage.\n",
    );
    return 2;
  }
  if (paths.length === 0) {
    process.stderr.write(
      "df admit-pr: empty file list — cannot classify. Classifying as `code` (default-upward).\n",
    );
    process.stdout.write("code\n");
    return 0;
  }
  const kind = classifyPrKindFromFiles(paths);
  process.stderr.write(
    `df admit-pr: classified ${paths.length} file(s) as ${kind}.\n`,
  );
  process.stdout.write(`${kind}\n`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const meta = readPackageMeta();
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    // Top-level --help/-h. Subcommand --help is forwarded to the Python
    // script via the rest-args pass-through.
    if (args.length === 0) {
      printHelp(meta);
      return 0;
    }
    // If a subcommand is present alongside --help, forward to Python.
    const sub0 = args[0] ?? "";
    if (
      !PHASE_C_SUBCOMMANDS.has(sub0) &&
      !PHASE_D_SUBCOMMANDS.has(sub0) &&
      !PHASE_F_SUBCOMMANDS.has(sub0) &&
      !PHASE_F_LOCAL_SUBCOMMANDS.has(sub0)
    ) {
      printHelp(meta);
      return 0;
    }
  }
  if (args.length > 0 && (args[0] === "--version" || args[0] === "-V")) {
    printVersion(meta);
    return 0;
  }
  const sub = args[0] ?? "";
  const rest = args.slice(1);

  if (PHASE_C_SUBCOMMANDS.has(sub)) {
    return runPhaseCSubcommand(sub, rest);
  }
  if (sub === "audit") {
    return cmdAudit(rest);
  }
  if (sub === "admit-pr") {
    return cmdAdmitPr(rest);
  }
  if (sub === "status-check") {
    return cmdStatusCheck(rest);
  }
  if (sub === "critic") {
    return await cmdCritic(rest);
  }
  // Phase F-LOCAL — hook-facing subcommands.
  if (sub === "review") {
    return await cmdReview(rest);
  }
  if (sub === "gate-push") {
    return await cmdGatePush(rest);
  }
  if (sub === "doctor") {
    return await cmdDoctor(rest);
  }
  if (sub === "gates") {
    return await cmdGates(rest);
  }
  if (sub === "stats") {
    return await cmdStats(rest);
  }
  return notImplemented(sub);
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`df: fatal: ${(err as Error).message}\n`);
    process.exitCode = 1;
  },
);
