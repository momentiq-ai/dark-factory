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
  appendFileSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  realpathSync,
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
import { buildCriticReport, buildZeroEvidenceDiagnostic } from "./report.js";
import { runReview, runCommitGate } from "./runner.js";
import { finalizeExit } from "./exit.js";
import {
  buildDefaultSelfConsistencyProbe,
  type SelfConsistencyProbeFn,
} from "./self-consistency.js";
import { resolveArtifactDir, telemetryPath } from "./paths.js";
// Phase F-LOCAL — hook-facing subcommand support.
import {
  loadDopplerBootstrapEnv,
  DEFAULT_BOOTSTRAP_ALLOWLIST,
} from "./doppler-bootstrap.js";
import {
  classifyDoctorState,
  detectCloudEnv,
  runDoctor,
  probeCacheTree,
} from "./doctor.js";
import {
  ensureGcAutoDisabled,
  recoverCacheTree,
} from "./worktree-safety.js";
import type { DoctorReportV1 } from "@momentiq/dark-factory-schemas";
import { resolveProfile } from "./policy/profile.js";
import {
  commitsForPushUpdate,
  parsePrePushUpdates,
  resolveCommit,
  commitParent,
  changedFiles,
  commitDiff,
  diffHash,
} from "./git.js";
import { runQualityGates } from "./evidence/quality-gates.js";
import { collectChangedPaths, runRoutes } from "./evidence/index.js";
import { summarizeGate } from "./policy/gate.js";
// Cycle 5 Phase 1 — `df mcp` stdio MCP server. The mcp/ module is kept
// out of cli.ts because its lifecycle (long-running stdio transport,
// stderr-only diagnostics) is structurally distinct from the other
// subcommands. See docs/roadmap/cycles/cycle5-mcp-server.md.
import { cmdMcp } from "./mcp/cli.js";
// DFP #192 — `df skills install/list` subcommand. The skills module is the
// install engine (consumer-config-driven template rendering); cmdSkills
// in commands/skills.ts is the CLI wrapper around it.
import { cmdSkills } from "./commands/skills.js";
// Cycle 11 Phase 11.1 — `df flow` namespace surfacing the PR Flow
// Assessor's records from momentiq-ai/df-assessments. See
// docs/roadmap/cycles/cycle11-flow-assessor-surfacing-and-tools.md.
import { cmdFlow } from "./commands/flow/index.js";
import { cmdShow } from "./commands/show.js";
import { cmdStatus } from "./commands/status.js";
// Cycle 22 (momentiq-ai/dark-factory#192) — `df verify` graduates the
// route-runner library (runRoutes) to a first-class subcommand: arm the
// verification routes for a commit's diff, run each route's producer, and
// write diffHash-bound per-SHA evidence the gate can re-validate (#194).
import { cmdVerify } from "./commands/verify.js";
// Cycle 13 (dark-factory-platform#149) — `df findings --range` surfaces
// the per-commit iteration-receipt artifacts that the new (default)
// final-commit-only `df gate-push` semantic leaves un-gated. See
// src/commands/findings.ts for the rationale.
import { cmdFindings } from "./commands/findings.js";
// Cycle 15 Phase A — `df onboard --analysis-only --json` runs the
// deterministic Stage A scanner (no LLM) and emits a bounded
// RepoAnalysis. Phase B/C extend the surface with --apply/--pr.
import { cmdOnboardCli } from "./commands/onboard.js";
// Cycle 12 Phase 12.2 — agent handoff protocol (v2 — Issue-anchored, native-
// baton). The four cmd* functions below wrap the verb orchestrators exported
// from src/handoff/index.ts and route to them at the bottom of main(). v1
// (Cycle 8) was a separate `./handoff/cli.js` module that wired the
// PR-anchored verbs; the v2 surface is small enough to live inline here next
// to the other subcommand handlers. Spec: docs/superpowers/specs/
// 2026-05-30-agent-handoff-v2-issue-anchor-design.md.
import {
  HandoffError,
  SpawnGhClient,
  SpawnGitClient,
  SystemClock,
  runHandoff,
  runAccept,
  runRehydrate,
  runHandoffs,
  renderRehydrateText,
} from "./handoff/index.js";
import { requireIssueNumber, requireSafeArgs } from "./handoff/args.js";

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
      "Local critic workflow:",
      "  df review                   Run the local critic against a commit",
      "                              (subscription auth — Cursor / Codex /",
      "                              Claude logins, NOT pay-per-token keys).",
      "  df gate-push                Pre-push gate — block a push when HEAD's",
      "                              critic verdict has unresolved blockers.",
      "                              Default since Cycle 13 (dark-factory-",
      "                              platform#149): gates the HEAD commit",
      "                              only; intermediate commits are iteration",
      "                              receipts (see `df findings --range`).",
      "                              Legacy per-commit gating via",
      "                              `--full-range` / `DF_GATE_FULL_RANGE=1`.",
      "  df show                     Render the per-commit review artifact",
      "                              (with --json for the structured form).",
      "  df status                   Terse verdict + per-critic status for",
      "                              a commit (with --json for shell pipes).",
      "  df findings --range BASE..HEAD",
      "                              Audit-inspect per-commit findings for the",
      "                              iteration-receipt artifacts the default",
      "                              final-commit-only `df gate-push` leaves",
      "                              un-gated (Cycle 13). NOT a gate.",
      "  df gates                    Run configured quality gates and",
      "                              triggered verification routes.",
      "  df verify                   Run the armed verification routes for a",
      "                              commit's diff and write diffHash-bound",
      "                              per-SHA evidence the gate re-validates.",
      "                              --route <id> runs one route. The route",
      "                              ORCHESTRATOR (wraps runRoutes); consumers",
      "                              override each route's placeholder command.",
      "  df stats                    Pretty-print critic call stats + bypass",
      "                              audit (alias for `df audit stats`).",
      "  df doctor                   Verify env: node, hooks, artifact dir,",
      "                              per-adapter auth.",
      "",
      "CI / reusable-workflow gates:",
      "  df status-check             Sentinel aggregator (pr-status-check).",
      "                              Exits 0 — merge queue is the real",
      "                              aggregator.",
      "  df critic                   Real Critic Orchestrator wiring (agent-",
      "                              critic gate). Loads .agent-review/",
      "                              config.json, runs configured vendor",
      "                              adapters via runReview, writes aggregate",
      "                              verdict to .git/agent-reviews/<sha>.",
      "                              Degrades-and-passes on any error.",
      "",
      "Cycle-doc + project services:",
      "  df validate-cycle-doc       Validate a PR's Cycle:/Issue:/",
      "                              ProjectItem: trailers.",
      "  df audit-branch-protection  Detect drift between spec.yaml and the",
      "                              live GitHub ruleset.",
      "  df sync-trackers            Reconcile GitHub tracker issues with",
      "                              cycle docs.",
      "  df attribute-pr             Write PR's Cycle: trailer into the",
      "                              project board's Cycle Ref field.",
      "  df audit stats              Summarize the _runs.ndjson audit trail.",
      "  df admit-pr                 Classify a PR as plan vs code.",
      "",
      "Agentic surface (MCP server):",
      "  df mcp                      Start the local stdio Model Context Protocol",
      "                              server. Exposes the CLI surface to any MCP-",
      "                              speaking agent as a structured tool + resource",
      "                              + prompt catalog. Run `df mcp --help` for the",
      "                              .mcp.json wiring snippet.",
      "",
      "Bundled skills (consumer-shape):",
      "  df skills install <name>    Render + install a bundled skill into",
      "                              .claude/skills/<name>/, driven by the consumer's",
      "                              darkfactory.yaml. --all installs every skill",
      "                              flagged enabled: true.",
      "  df skills list              List bundled skill names + summaries.",
      "",
      "PR Flow Assessor surfacing:",
      "  df flow                     Surface the PR Flow Assessor's records.",
      "                              Six sub-subcommands: show / agent /",
      "                              patterns / cost / trends / rollup.",
      "                              Each carries --json. Run `df flow",
      "                              --help` for the list.",
      "",
      "Agent handoff protocol (v2 Issue-anchored):",
      "  df handoff [issue]          Put a work-stream on the handoff stack:",
      "    [--link <ref>]...           upsert the marker-bounded rehydration",
      "    [--unlink <ref>]...         note (read from stdin) as the dedicated",
      "    [--new]                     handoff Issue's body, label it `handoff`,",
      "                                leave it unassigned. Scrubs the note for",
      "                                secret-shaped content first. Auto-creates",
      "                                an Issue when @me has none (or --new).",
      "  df handoffs                 List the stack of handed-off Issues (open,",
      "                              labeled `handoff`, unassigned).",
      "  df accept <issue>           Claim a handoff Issue (assign you), rehydrate,",
      "                              then close it.",
      "  df rehydrate [issue]        Read-only catch-up on a handoff Issue's note —",
      "                              derives LIVE state first, changes no ownership.",
      "                              No-arg: 2-tier (open+@me → closed+@me ≤7d).",
      "",
      "Cost model:",
      "  The local hook path (review/gate-push) consumes Cursor / Codex / Claude",
      "  SUBSCRIPTIONS via the developer's existing CLI logins. Vendor API keys",
      "  (CURSOR_API_KEY / CODEX_API_KEY / GEMINI_API_KEY / XAI_API_KEY) are the",
      "  CI cold-path fallback only.",
      "",
      "Each subcommand carries its own `--help` for full flag documentation.",
      "Critic and status-check exit 0 even on failure so the reusable workflows",
      "do not block the merge queue on a single vendor flake — vendor errors",
      "register in the artifact as `status=error` and the configured aggregation",
      "policy (min-complete-quorum, block-if-any) decides the aggregate verdict.",
      "",
      "System requirements:",
      "  Node.js >=20",
      "  python3 (>=3.11)",
      "  gh CLI (authenticated) for project/cycle-doc GitHub API calls",
      "  git on PATH",
      "",
      "Library usage today:",
      "  import { runReview, evaluateCommitGate, buildReviewPacket }",
      `    from \"${name}\";`,
      "",
      `Version: ${version}. Docs: https://github.com/momentiq-ai/dark-factory`,
      "",
    ].join("\n"),
  );
}

function printVersion(meta: PackageMeta): void {
  process.stdout.write(`${meta.version ?? "unknown"}\n`);
}

function notImplemented(sub: string): number {
  process.stderr.write(
    `df: subcommand "${sub}" is not implemented in this build.\n` +
      `    Run \`df --help\` for the list of available subcommands.\n` +
      `    Track / request at: https://github.com/momentiq-ai/dark-factory/issues\n`,
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
//     subcommand exists for the `pr-status-check` ruleset context.
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

// Cycle 5 Phase 1 — `df mcp` is the local stdio MCP server. It is a
// long-running subcommand whose stdout is OWNED by the MCP JSON-RPC
// transport, so the early-help routing in main() MUST forward
// `mcp --help` to the subcommand's own help printer (which is the only
// stdout writer in that subtree) rather than the global printHelp().
const PHASE_G_SUBCOMMANDS = new Set(["mcp"]);

// Cycle 12 Phase 12.2 — agent handoff protocol v2 verbs (replaces the
// Cycle 8 v1 set). Like the other subcommands they talk to GitHub via `gh`;
// unlike the gate verbs they mutate Issue state (body, label, assignee).
// `df handoff` reads the note body on stdin. The set is registered here so
// the early --help interception above forwards to each subcommand's own help
// printer (cmdHandoff/cmdAccept/cmdRehydrate/cmdHandoffs).
const CYCLE12_SUBCOMMANDS = new Set([
  "handoff",
  "handoffs",
  "accept",
  "rehydrate",
]);

// Cycle 11 Phase 11.1 — `df flow` namespace. Each sub-subcommand
// (show/agent/patterns/cost/trends/rollup) is dispatched inside cmdFlow,
// not at the top level, so the surface stays grouped (`df flow --help` is
// authoritative) and we don't pollute the top-level `df` namespace.
const CYCLE11_SUBCOMMANDS = new Set(["flow"]);

// `df show` / `df status` / `df findings` — CLI artifact-inspection
// subcommands. `show` + `status` mirror the df_show_run / df_findings MCP
// tools per-commit (cycle 5); `findings --range <base>..<head>` (Cycle
// 13, dark-factory-platform#149) walks the iteration-receipt artifacts
// the new default final-commit-only `df gate-push` semantic leaves
// un-gated. All three share the loader + mappers in
// src/lib/show-status-core.ts so the CLI's `--json` output stays
// byte-equivalent with the MCP tool's structuredContent envelope (cycle 5
// spec requirement). Registered here so the early --help interception
// forwards each `df <cmd> --help` to its per-subcommand help printer.
const SHOW_STATUS_SUBCOMMANDS = new Set(["show", "status", "findings"]);

// `df skills` — bundled-skill installer (Cycle: DFP #192). The namespace
// fans out into `install/list` sub-subcommands handled inside cmdSkills;
// registered here so the early --help interception above forwards
// `df skills --help` to cmdSkills' own help printer instead of the
// top-level printHelp.
const SKILLS_SUBCOMMANDS = new Set(["skills"]);

// `df onboard` — cycle 15 Phase A deterministic repo analyzer. Registered
// here so `df onboard --help` reaches cmdOnboardCli's per-subcommand help
// printer instead of falling through to the top-level printHelp.
const ONBOARD_SUBCOMMANDS = new Set(["onboard"]);

// `df verify` — cycle 22 (#192) route-runner orchestrator. Registered here so
// `df verify --help` reaches cmdVerify's own help printer instead of the
// top-level printHelp.
const VERIFY_SUBCOMMANDS = new Set(["verify"]);

function cmdStatusCheck(_rest: string[]): number {
  // pr-status-check is a sentinel aggregator. As cycle 331.1 Phase E
  // documents in `.github/workflows/pr-status-check.yml`, this gate is
  // present specifically to satisfy the `pr-status-check` ruleset context
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
  // Issue #170 — the `--profile` flag value (non-empty string) or
  // undefined when the flag is absent (or bare/empty). `cmdCritic` feeds
  // this through `resolveCriticProfile()` — which delegates to
  // `resolveProfile` ONLY when a profile is explicitly set (flag or
  // `AGENT_REVIEW_PROFILE`), else returns undefined to preserve the
  // profile-less default — so a selected profile's `auth` pins take effect
  // on the `df critic` path. Previously `df critic` always ran profile-less,
  // so codex (the only auth-strict adapter) hit "no auth source pinned" on
  // every CI run. Do NOT change this to default to "local" (see
  // `resolveCriticProfile`).
  profileName?: string;
}

// Exported for unit tests (issue #170): pure argv parser, no side
// effects. Mirrors the other exported pure resolvers (resolveProfile).
export function parseCriticArgs(rest: string[]): CriticOptions {
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
  // Issue #170 — only a non-empty string flag value counts; a bare
  // `--profile` (parses as boolean `true`) or `--profile=""` falls
  // through, leaving `profileName` unset so `resolveCriticProfile` falls
  // back to the env (or to profile-less when neither is set).
  if (typeof flags["profile"] === "string" && flags["profile"].trim().length > 0) {
    out.profileName = flags["profile"] as string;
  }
  return out;
}

/**
 * Resolve the profile for a `df critic` run — issue #170.
 *
 * Returns a profile name ONLY when one is explicitly requested: the
 * `--profile` flag (surfaced as `opts.profileName`) or the
 * `AGENT_REVIEW_PROFILE` env, with the standard flag > env precedence.
 * Returns `undefined` when neither is set, so `df critic` keeps its
 * historical PROFILE-LESS default (all configured critics, no profile
 * critic-filtering or `auth` pins) rather than silently adopting
 * `resolveProfile`'s "local" fallback — which would change the published
 * default behaviour of `df critic` and break the reusable workflow's
 * consumer path (it sets no profile env) for callers whose config has a
 * `profiles` map but no "local" entry. dark-factory's own `agent-critic`
 * CI sets `AGENT_REVIEW_PROFILE=cloud` explicitly; that env, not a
 * default, is what activates the cloud codex `auth: api` pin (#170).
 *
 * Exported so the wiring is unit-tested directly (`cmdCritic` is not
 * exported and has no runReview injection seam).
 */
export function resolveCriticProfile(
  opts: { profileName?: string | undefined },
  env: { AGENT_REVIEW_PROFILE?: string | undefined },
): string | undefined {
  const envRaw = env.AGENT_REVIEW_PROFILE;
  const explicit =
    opts.profileName !== undefined ||
    (typeof envRaw === "string" && envRaw.trim().length > 0);
  if (!explicit) return undefined;
  return resolveProfile({ profile: opts.profileName }, env);
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
  { id: "cursor-cli", modulePath: "./adapters/cursor-cli.js", className: "CursorCliAdapter" },
  { id: "codex-sdk", modulePath: "./adapters/codex-sdk.js", className: "CodexSdkAdapter" },
  { id: "gemini-sdk", modulePath: "./adapters/gemini-sdk.js", className: "GeminiSdkAdapter" },
  { id: "grok-direct-sdk", modulePath: "./adapters/grok-direct-sdk.js", className: "GrokDirectSdkAdapter" },
  // Cycle 20 — MiniMax M3 via OpenRouter's OpenAI-compatible Chat
  // Completions endpoint.
  { id: "minimax-direct-sdk", modulePath: "./adapters/minimax-direct-sdk.js", className: "MinimaxDirectSdkAdapter" },
  // Consumer dark-factory-platform#107 — deterministic schema-lint adapter.
  // No vendor SDK, no env vars, no network; pure ajv-backed validation of
  // schema-annotated code blocks in changed markdown / config files.
  // Loads alongside the LLM adapters so the local profile can include it
  // without any additional toolchain.
  { id: "static-schema-lint", modulePath: "./adapters/static-schema-lint.js", className: "StaticSchemaLintAdapter" },
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

// sage3c#2213 — append a markdown block to the GitHub Actions run summary
// when running under CI. No-op (and never throws) when GITHUB_STEP_SUMMARY
// is unset (local runs) or the append fails — surfacing the per-critic
// report is best-effort observability and must not perturb `df critic`'s
// degrade-and-pass exit-0 posture. The path is provided by the runner per
// the Actions contract; we trust it the same way `actions/*` steps do.
function appendStepSummary(markdown: string): void {
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, markdown, "utf8");
  } catch {
    // best-effort — never let a summary-write failure change the gate outcome.
  }
}

/**
 * Cursor finding (cli.ts:560) — resolve the production
 * self-consistency probe so the policy `unilateralVetoRules.requireCorroborationFor`
 * actually demotes findings on the default OSS CLI path. Returns the
 * probe callable when (a) the loaded policy lists `self_inconsistent`
 * AND (b) `buildDefaultSelfConsistencyProbe()` returns a non-null
 * factory (i.e. the env has a `GEMINI_API_KEY`). Otherwise returns
 * undefined, which makes the runner skip the probe pass entirely
 * (byte-identical pre-#112 behavior).
 *
 * Operators who want a non-Gemini probe (or the hosted worker's
 * proprietary calibrated probe) replace the callable by importing
 * `runReview` directly with their own `selfConsistencyProbe`.
 */
export function resolveProductionSelfConsistencyProbe(
  loaded: LoadedConfig,
): SelfConsistencyProbeFn | undefined {
  const flags = loaded.config.aggregation.unilateralVetoRules?.requireCorroborationFor ?? [];
  if (!flags.includes("self_inconsistent")) return undefined;
  const probe = buildDefaultSelfConsistencyProbe();
  if (probe === null) {
    process.stderr.write(
      "[critic] self-consistency probe disabled — GEMINI_API_KEY unset; policy `unilateralVetoRules.requireCorroborationFor: [self_inconsistent]` is configured but probe-flagged findings will not be demoted on this run.\n",
    );
    return undefined;
  }
  return probe;
}

async function cmdCritic(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df critic — run the multi-vendor adversarial critic against HEAD",
        "",
        "Usage:",
        "  df critic [--ref <gitref>] [--config <path>] [--cwd <path>] [--profile <name>]",
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
        "  AGENT_REVIEW_PROFILE",
        "    Profile to run (precedence: --profile flag > this env). When",
        "    neither is set, df critic runs profile-less — all configured",
        "    critics, no profile critic-filtering or `auth` pins (its",
        "    historical default). Selecting a profile applies that profile's",
        "    critic set + `auth` pins (e.g. the `cloud` profile pins codex",
        "    to `api`).",
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

    // Issue #170 — thread the (explicitly-selected) profile into
    // `runReview()` so its `auth` pins take effect on the `df critic`
    // path. Codex previously errored "no auth source pinned" on every CI
    // run because `df critic` never resolved a profile, so `critic.auth`
    // stayed undefined. `undefined` here (no `--profile` flag / no
    // `AGENT_REVIEW_PROFILE` env) preserves the profile-less default — the
    // rationale + the "don't adopt the 'local' fallback" reasoning live in
    // `resolveCriticProfile`. dark-factory's CI sets the env to `cloud`.
    // `resolveProfileWithConfig` (inside runReview) still throws loudly on
    // a mistyped/unknown profile name.
    const profileName = resolveCriticProfile(
      opts,
      process.env as { AGENT_REVIEW_PROFILE?: string | undefined },
    );

    // Wire a file telemetry sink so the run lands in
    // `.git/agent-reviews/_runs.ndjson` (the same path `df audit stats`
    // reads). This is dogfood proof: the substrate exercises its own
    // audit trail on its own PRs.
    const artifactDir = await resolveArtifactDir(loaded);
    const sink = new FileTelemetrySink(telemetryPath(artifactDir));

    const selfConsistencyProbe = resolveProductionSelfConsistencyProbe(loaded);
    const outcome = await runReview({
      loaded,
      registry,
      ref: opts.ref,
      telemetry: sink,
      ...(profileName !== undefined ? { profileName } : {}),
      ...(selfConsistencyProbe !== undefined ? { selfConsistencyProbe } : {}),
    });

    // sage3c#2213 — surface per-critic errors + a loud degradation
    // warning. `buildCriticReport` is pure; it turns the artifact's
    // criticResults into a stdout block (now naming each errored
    // critic's error.message/error.code, which previously lived ONLY in
    // the per-SHA JSON that runner teardown destroys) and a parallel
    // $GITHUB_STEP_SUMMARY markdown block.
    const report = buildCriticReport(outcome.artifact, outcome.paths.jsonPath);
    process.stdout.write(report.stdout);
    appendStepSummary(report.stepSummary);
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
  // #227 — disable auto-gc so a background prune can't corrupt a linked
  // worktree's index. Idempotent + best-effort; never blocks the review.
  await ensureGcAutoDisabled(loaded.repoRoot);
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
    const selfConsistencyProbe = resolveProductionSelfConsistencyProbe(loaded);
    const outcome = await runReview({
      loaded,
      registry,
      ref,
      telemetry: sink,
      profileName,
      ...(selfConsistencyProbe !== undefined ? { selfConsistencyProbe } : {}),
    });
    // Issue #51 — loud post-completion diagnostic for zero-evidence
    // reviews. When every critic errored (no completed verdicts), the
    // gate will silently block at push time and operators reach for
    // AGENT_REVIEW_BYPASS as the workaround. Surface the failure here
    // so the operator sees it at commit time, with a specific
    // remediation per critic and a pointer to the artifact JSON for
    // deeper triage. The helper is pure (no I/O); the only side effect
    // is the stderr write below.
    const configHasProfiles = hasProfileEntry(loaded.config, profileName);
    const diagnostic = buildZeroEvidenceDiagnostic(
      outcome.artifact,
      outcome.paths.jsonPath,
      { configHasProfiles },
    );
    if (diagnostic.isZeroEvidence) {
      process.stderr.write(diagnostic.stderr);
    }
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

// Issue #51 — the post-completion diagnostic needs to know whether
// the loaded config has the requested profile so it can prepend a
// "add 'profiles' to .agent-review/config.json" remediation when the
// seed config is the broken sage-blueprint shape (`profiles: {}`).
// Returns `true` when both a profiles map exists AND the requested
// name is present; `false` otherwise. (Back-compat configs with no
// profiles map AT ALL also return `false`, which is the correct
// signal — the diagnostic surfaces the seed remediation in both
// cases.)
function hasProfileEntry(
  config: LoadedConfig["config"],
  profileName: string,
): boolean {
  if (!config.profiles) return false;
  return config.profiles[profileName] !== undefined;
}

// ----- df gate-push -----
//
// Cycle 13 (dark-factory-platform#149) — semantic flip:
//
//   DEFAULT MODE: final-commit-only. The HEAD (last) commit of each
//     push update is the only one whose verdict decides the gate. The
//     intermediate commits' per-SHA artifacts still exist on disk
//     (`.git/agent-reviews/<sha>.json`) as iteration receipts and stay
//     visible via `df findings --range <base>..<head>`, but they do
//     NOT influence the push outcome. This matches the documented
//     find-fix-new-commit pattern: commit B fixes commit A's blockers,
//     B's verdict is what gates the push.
//
//     Soundness caveat: each per-SHA artifact reviews `parent..commit`
//     only, NOT `base..tip`. HEAD's APPROVED verdict therefore proves
//     the LAST incremental change is safe; it does NOT prove the
//     cumulative `base..tip` diff is safe. The banner + help text
//     surface this so operators can choose `--full-range` (or rely on
//     the CI cold-path agent-critic workflow that reviews the full PR
//     diff) when cumulative soundness matters more than termination of
//     the find-fix loop.
//
//   LEGACY MODE: full-range — gate every commit in the push update,
//     block on any single commit's blockers. Opt-in via `--full-range`
//     OR `DF_GATE_FULL_RANGE=1`. Use cases: forensic replay, per-commit
//     audit (each commit is independently reviewed in a deploy log),
//     cumulative-state evidence requirements.
//
//   The legacy mode was the implicit default before Cycle 13. It
//   makes the find-fix-new-commit pattern non-terminating in practice
//   (any iteration round produces stale intermediate `CHANGES_REQUESTED`
//   verdicts that block the push and force a squash, which spawns a
//   fresh full-diff review that surfaces new findings — see
//   consumer-side dark-factory-platform#149 for the full failure mode).
//
// The mode banner — `GATE MODE: final-commit-only (HEAD=<sha>)` or
// `GATE MODE: full-range (N commits)` — prints once per push update so
// operators see which semantic is active without needing to remember
// the env-var / flag state.
//
// `--commit SHA --ci` mode is a single-commit replay path (CI cold-
// path); the legacy/default split does not apply to it (one commit
// only).
function isFullRangeRequested(flags: Record<string, string | boolean>): boolean {
  if (flags["full-range"] === true || flags["full-range"] === "true") {
    return true;
  }
  const env = process.env["DF_GATE_FULL_RANGE"];
  if (env !== undefined && env !== "" && env !== "0" && env.toLowerCase() !== "false") {
    return true;
  }
  return false;
}

async function cmdGatePush(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df gate-push — gate a push on the local-critic verdict.",
        "",
        "Usage:",
        "  df gate-push [--profile NAME]                              # local pre-push",
        "  df gate-push --full-range [--profile NAME]                 # legacy: gate every commit",
        "  df gate-push --commit SHA --ci [--profile NAME]            # CI replay (single commit)",
        "",
        "Designed for .husky/pre-push. Reads git's pre-push protocol on stdin.",
        "",
        "Default mode (Cycle 13 — dark-factory-platform#149):",
        "  Gates ONLY the HEAD (final) commit of each push update. Intermediate",
        "  commits' per-SHA artifacts at .git/agent-reviews/<sha>.json are still",
        "  written (iteration audit), but they DO NOT influence the gate.",
        "  Inspect them with: `df findings --range <base>..HEAD`.",
        "",
        "Legacy mode — opt in via `--full-range` OR `DF_GATE_FULL_RANGE=1`:",
        "  Gates EVERY commit in the push range; any single commit's blocker",
        "  blocks the push. Use for forensic replay or per-commit deploy-log",
        "  audit. Note: this was the implicit default before Cycle 13 and is",
        "  what produced the find-fix-new-commit termination failure.",
        "",
        "Soundness caveat (default mode):",
        "  Each per-SHA artifact reviews `parent..commit` only, NOT `base..tip`.",
        "  HEAD's APPROVED verdict therefore proves the LAST incremental change",
        "  is safe; it does NOT prove the cumulative `base..tip` diff is safe.",
        "  For cumulative-state evidence either pass `--full-range` (or set",
        "  `DF_GATE_FULL_RANGE=1`) for per-commit gating, or rely on the CI",
        "  cold-path agent-critic workflow (which reviews the full PR diff).",
        "",
        "Exit code:",
        "  1 if the gating verdict (HEAD-only or full-range, per mode) blocks.",
        "  0 otherwise.",
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
  // #227 — disable auto-gc so a background prune can't corrupt a linked
  // worktree's index. Idempotent + best-effort; never blocks the gate.
  await ensureGcAutoDisabled(loaded.repoRoot);
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

  const fullRange = isFullRangeRequested(flags);
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

    if (fullRange) {
      // Legacy mode — gate every commit in the range. Pre-Cycle-13
      // behavior, kept for forensic replay and per-commit audit
      // contexts (e.g. production-deploy push where each commit is
      // independently reviewed in the deploy log).
      process.stdout.write(
        `GATE MODE: full-range (${commits.length} commits) — ${update.localRef} -> ${update.remoteRef}\n`,
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
      continue;
    }

    // Default mode (Cycle 13) — final-commit-only. The last commit in
    // the range (`commitsForPushUpdate` returns the rev-list reverse,
    // so HEAD is the last element) is the only one whose verdict
    // gates the push. Intermediate commits' artifacts are iteration
    // receipts; inspect them with `df findings --range`.
    const headSha = commits[commits.length - 1] ?? "";
    process.stdout.write(
      `GATE MODE: final-commit-only (HEAD=${headSha.slice(0, 12)}) — ${update.localRef} -> ${update.remoteRef}\n`,
    );
    if (commits.length > 1) {
      process.stdout.write(
        `  intermediate commits (${commits.length - 1}) are iteration receipts; inspect with: df findings --range ${update.remoteRef === "" ? "<base>" : `${update.remoteSha.slice(0, 12)}..${headSha.slice(0, 12)}`}\n`,
      );
      process.stdout.write(
        `  soundness caveat: HEAD's verdict covers parent..HEAD only, NOT base..HEAD; use --full-range (or the CI agent-critic on the full PR diff) when cumulative-state evidence is required.\n`,
      );
    }
    const result = await runCommitGate({
      loaded,
      commit: headSha,
      telemetry: sink,
      profileName,
    });
    process.stdout.write(`-- ${headSha.slice(0, 12)}\n${summarizeGate(result)}\n`);
    if (result.blocked) blockedAny = true;
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
        "  df doctor [--profile NAME] [--json]",
        "",
        "Checks: node version, hooks dir, hook executable, core.hooksPath,",
        "artifact dir, doppler bootstrap, cloud-env detection, per-adapter",
        "doctor() (subscription auth lives here; skipped in cloud envs).",
        "",
        "Flags:",
        "  --json                           Emit a machine-readable JSON",
        "                                   report on stdout instead of the",
        "                                   human-readable INFO/OK/FAIL lines",
        "                                   (for consumer-side pre-push hooks",
        "                                   that fail-fast on auth_pending).",
        "  --fix-cache-tree                 If the cache-tree probe finds a",
        "                                   corrupt linked-worktree index",
        "                                   (#227), recover it via",
        "                                   `git read-tree HEAD` (unstages",
        "                                   staged changes; working-tree edits",
        "                                   are preserved).",
        "",
        "Environment:",
        "  AGENT_REVIEW_PROFILE=<name>      Profile to validate (default: local)",
        "  DF_DOCTOR_CI=1                   Skip hookspath + doppler CLI checks",
        "  DF_DOCTOR_SKIP_HOOKS=1           Skip git-core-hookspath check",
        "  DF_DOCTOR_SKIP_DOPPLER=1         Skip doppler-cli-on-path check",
        "",
        "Cloud-env markers (any-of triggers subscription-auth skip):",
        "  CODESPACES=true                  GitHub Codespaces",
        "  REMOTE_CONTAINERS=true           VS Code Dev Containers",
        "  CLAUDE_CODE_SANDBOX=true         Claude Code web sandbox",
        "  DEVCONTAINER=true                generic devcontainer images",
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

  // #227 — opt-in cache-tree recovery. The `cache_tree_probe` check (inside
  // runDoctor) is detect-only by design because the recovery is destructive;
  // `--fix-cache-tree` performs the supported `git read-tree HEAD` recovery
  // when the probe found corruption, then re-probes so the reported state +
  // exit code reflect the recovery. Messages go to stderr so they never
  // corrupt --json stdout.
  if (flags["fix-cache-tree"]) {
    const probe = checks.find((c) => c.name === "cache_tree_probe");
    if (probe && !probe.passed) {
      process.stderr.write(
        `df doctor: cache-tree corruption detected (${probe.detail}) — recovering…\n`,
      );
      const rec = await recoverCacheTree(loaded.repoRoot);
      process.stderr.write(
        `df doctor: ${rec.ok ? "recovered" : "recovery FAILED"} — ${rec.detail}\n`,
      );
      if (rec.ok) {
        const reprobed = await probeCacheTree(loaded.repoRoot);
        const idx = checks.findIndex((c) => c.name === "cache_tree_probe");
        if (idx >= 0) checks[idx] = reprobed;
      }
    } else {
      process.stderr.write(
        "df doctor: --fix-cache-tree: no cache-tree corruption to recover.\n",
      );
    }
  }

  // Issue #51 — surface the 3-state triage classification FIRST, before
  // the per-check INFO/OK/FAIL block. The headline tells the operator
  // whether they're in config_missing / auth_pending / ok before they
  // have to parse per-critic noise.
  const triage = classifyDoctorState({
    config: loaded.config,
    profileName,
    perCriticChecks: checks,
  });
  const cloudEnv = detectCloudEnv();
  const allOk = checks.every((c) => c.passed || c.optional);

  // --json — machine-readable output for consumer-side pre-push hooks
  // (DFP issue #56). Shape is stable and documented in
  // packages/schemas/src/index.ts (DoctorReport). Exit code semantics
  // are the same as the human path: 0 = all required checks passed,
  // 1 = at least one required check failed.
  if (flags["json"]) {
    const report: DoctorReportV1 = {
      version: 1,
      schema: "df-doctor-report-v1",
      triage: { state: triage.state, line: triage.line },
      cloudEnv: {
        detected: cloudEnv.detected,
        markers: cloudEnv.markers,
      },
      // `profile` is part of the stable field set; `JSON.stringify`
      // omits `undefined`, so we default explicitly here even though
      // `resolveProfile` already returns `"local"` on the no-flag /
      // no-env path. Belt-and-braces — keeps the contract intact if the
      // resolver signature ever loosens.
      profile: profileName || "local",
      ok: allOk,
      checks,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return allOk ? 0 : 1;
  }

  process.stdout.write(`${triage.line}\n`);
  for (const c of checks) {
    const label = c.passed ? (c.optional ? "INFO" : "OK") : c.optional ? "INFO" : "FAIL";
    process.stdout.write(`[${label}] ${c.name}: ${c.detail}\n`);
    if (!c.passed && c.remediation) {
      process.stdout.write(`       fix: ${c.remediation}\n`);
    } else if (c.passed && c.optional && c.remediation) {
      // INFO-with-remediation surfaces the cloud-env bypass hint loudly
      // even though the check itself "passed" (it's informational).
      process.stdout.write(`       note: ${c.remediation}\n`);
    }
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
        "Runs static gates from .agent-review/config.json:validation, then the",
        "verification routes the commit's diff arms (via the same `runRoutes`",
        "orchestrator as `df verify`). Writes per-SHA evidence stamped with the",
        "gated diff hash so `df gate-push` re-validates it (#194). No LLM calls",
        "— this subcommand is free.",
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

  // Verification routes — delegate to the same `runRoutes` orchestrator that
  // backs `df verify` (#192). This gives `df gates` the SAME route semantics
  // as the gate it feeds: the additive planner + exclusive-route suppression,
  // the 0/1/2 outcome classification, AND — load-bearing after #194 — the
  // diffHash stamp. Without the stamp, df gates' route evidence would be
  // SHA-only and `df gate-push` would now reject it as unbound (the two
  // surfaces must produce gate-compatible evidence). An un-overridden
  // `df verify` placeholder command surfaces as a thrown recursion-guard
  // error, caught here as a failure.
  let routeFailures = 0;
  let routeRun = 0;
  try {
    let parent = "";
    try {
      parent = await commitParent(sha);
    } catch {
      parent = "";
    }
    const files = await changedFiles(parent, sha, undefined, { readContent: false });
    let gatedDiffHash: string | undefined;
    try {
      gatedDiffHash = diffHash(await commitDiff(parent, sha));
    } catch {
      gatedDiffHash = undefined;
    }
    const summary = await runRoutes({
      loaded,
      commit: sha,
      changedPaths: collectChangedPaths(files),
      ...(gatedDiffHash !== undefined ? { diffHash: gatedDiffHash } : {}),
      ...(routeFilter !== null ? { routeFilter } : {}),
    });
    routeRun = summary.ran.length;
    for (const r of summary.ran) {
      // Preserve df gates' historical exit contract: any non-green ran route
      // (block OR soft-skip) counts as a failure. (df verify maps soft-skip
      // to exit 2; df gates keeps its simpler pass/fail tally.)
      if (r.outcome !== "green") routeFailures++;
      process.stdout.write(
        `  ${r.outcome === "green" ? "PASS" : "FAIL"} route[${r.routeId}] (${r.command}) exit=${r.exitCode}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`df gates: ${(err as Error).message}\n`);
    return 1;
  }

  const totalRun = requiredRun + routeRun;
  const totalFail = requiredFailures + routeFailures;
  process.stdout.write(
    `df gates: ${totalRun} run, ${totalFail} failed${routeFilter ? ` (filter=route:${routeFilter})` : ""}\n`,
  );
  return totalFail === 0 ? 0 : 1;
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

// ---------------------------------------------------------------------------
// Cycle 12 Phase 12.2 — agent handoff protocol v2 (Issue-anchored, native-baton).
//
// Four verbs replace the Cycle 8 (v1) PR-anchored verbs deleted in Task 22:
//
//   df handoff [issue] [--link <ref>]... [--unlink <ref>]... [--new]
//     Reads note body on stdin. Posts the dedicated handoff Issue's URL to
//     stdout, operator logs to stderr.
//   df accept <issue>
//     Take the baton: assign @me, rehydrate (read-only fetch), close.
//   df rehydrate [issue]
//     Read-only catch-up. No-arg → 2-tier resolution.
//   df handoffs
//     List the stack (open + handoff-labeled + unassigned).
//
// Convention: machine-readable output → stdout; operator logs/warns → stderr.
// HandoffError → stderr + exit 1. Usage/arg error → exit 2. Success → exit 0.
//
// requireSafeArgs is defense-in-depth — in the TS CLI real argv kills the
// shell-injection vector the bash .md/$ARGUMENTS surface was defending
// against, but we keep the allow-list so the error wording stays
// byte-equivalent with the bash-era impl for the few payload-rejection tests
// the case-map ports forward.
// ---------------------------------------------------------------------------

async function cmdHandoff(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df handoff — put a work-stream on the handoff stack (v2 Issue-anchored).",
        "",
        "Usage:",
        "  df handoff [issue] [--link <ref>]... [--unlink <ref>]... [--new] [--reuse]",
        "",
        "Upserts the marker-bounded rehydration note (read from stdin) as the",
        "dedicated handoff Issue's body, adds the `handoff` label, leaves it",
        "unassigned. Reads the composed note on stdin (pipe it in or use < note.md).",
        "",
        "Args:",
        "  [issue]            Explicit handoff Issue number. Omit to update @me's",
        "                     open handoff or create a new one.",
        "",
        "Flags:",
        "  --link <ref>       Link a PR or Issue. Ref forms: number (same-repo),",
        "                     owner/repo#N (cross-repo), URL, or pr:N / issue:N",
        "                     prefix. May repeat.",
        "  --unlink <ref>     Remove a linked item. May repeat.",
        "  --new              Force-create a new Issue even if @me already has an",
        "                     open handoff.",
        "  --reuse            Post even if the note's `_Updated:_` date is ≥2 days",
        "                     old (the staleness guard targets leftover drafts; #319).",
        "  --help, -h         Show this message.",
        "",
        "Output:",
        "  stdout — the handoff Issue's URL.",
        "  stderr — operator info / warn / log lines.",
        "",
        "Exit:",
        "  0  success",
        "  1  handoff error (bad state, gh failure, dirty drift, etc.)",
        "  2  usage error",
        "",
      ].join("\n"),
    );
    return 0;
  }

  // Defense-in-depth allow-list on every argv item.
  try {
    requireSafeArgs(rest);
  } catch (err) {
    process.stderr.write(`df handoff: ${(err as Error).message}\n`);
    return 2;
  }

  // Parse args. Issue is the lone positional; --link/--unlink repeat.
  let issueStr: string | undefined;
  const link: string[] = [];
  const unlink: string[] = [];
  let forceNew = false;
  let reuse = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--link") {
      const v = rest[++i];
      if (v === undefined) {
        process.stderr.write("df handoff: --link requires a value.\n");
        return 2;
      }
      link.push(v);
    } else if (arg === "--unlink") {
      const v = rest[++i];
      if (v === undefined) {
        process.stderr.write("df handoff: --unlink requires a value.\n");
        return 2;
      }
      unlink.push(v);
    } else if (arg === "--new") {
      forceNew = true;
    } else if (arg === "--reuse") {
      reuse = true;
    } else if (arg.startsWith("-")) {
      process.stderr.write(`df handoff: unknown flag: ${arg}\n`);
      return 2;
    } else {
      if (issueStr !== undefined) {
        process.stderr.write(
          `df handoff: unexpected positional argument: ${arg} (only one [issue] allowed).\n`,
        );
        return 2;
      }
      issueStr = arg;
    }
  }

  let issue: number | undefined;
  try {
    issue = requireIssueNumber(issueStr);
  } catch (err) {
    process.stderr.write(`df handoff: ${(err as Error).message}\n`);
    return 2;
  }

  // Read stdin (empty string on TTY — runHandoff will reject empty notes).
  const note = await readStdinUtf8FromTtyOrStream();

  try {
    const result = await runHandoff({
      noteStdin: note,
      ...(issue !== undefined ? { issue } : {}),
      link,
      unlink,
      forceNew,
      reuse,
      gh: new SpawnGhClient(),
      git: new SpawnGitClient(),
      clock: new SystemClock(),
    });
    for (const log of result.logs) {
      process.stderr.write(`handoff: ${log}\n`);
    }
    process.stdout.write(`${result.noteUrl}\n`);
    return 0;
  } catch (err) {
    if (err instanceof HandoffError) {
      process.stderr.write(`handoff: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function cmdAccept(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df accept — take the baton on a handoff Issue (v2 Issue-anchored).",
        "",
        "Usage:",
        "  df accept <issue>",
        "",
        "Atomic chain: validate → refuse-on-other-claimant → strict-rehydrate →",
        "drift-check → assign @me → verify assignment → close (Commitment 10).",
        "Any failure before assign leaves the Issue untouched on the stack.",
        "",
        "Args:",
        "  <issue>            Handoff Issue number (required — `df handoffs` lists",
        "                     the stack).",
        "",
        "Flags:",
        "  --help, -h         Show this message.",
        "",
        "Output:",
        "  stdout — rendered rehydration view (operator-readable).",
        "  stderr — assign + close confirmation lines.",
        "",
        "Exit:",
        "  0  success (assigned + rehydrated + closed)",
        "  1  handoff error (other claimant, drift, gh failure, etc.)",
        "  2  usage error",
        "",
      ].join("\n"),
    );
    return 0;
  }

  try {
    requireSafeArgs(rest);
  } catch (err) {
    process.stderr.write(`df accept: ${(err as Error).message}\n`);
    return 2;
  }

  const issueStr = rest[0];
  if (issueStr === undefined || issueStr === "") {
    process.stderr.write(
      "df accept: which one? run `df handoffs` to see the stack, then `df accept <issue>`.\n",
    );
    return 2;
  }
  if (rest.length > 1) {
    process.stderr.write(
      `df accept: unexpected extra arguments: ${rest.slice(1).join(" ")}\n`,
    );
    return 2;
  }

  let issue: number | undefined;
  try {
    issue = requireIssueNumber(issueStr);
  } catch (err) {
    process.stderr.write(`df accept: ${(err as Error).message}\n`);
    return 2;
  }
  if (issue === undefined) {
    process.stderr.write(
      "df accept: which one? run `df handoffs` to see the stack, then `df accept <issue>`.\n",
    );
    return 2;
  }

  try {
    const result = await runAccept({ issue, gh: new SpawnGhClient() });
    process.stdout.write(`${renderRehydrateText(result.rehydrate)}\n`);
    for (const log of result.logs) {
      process.stderr.write(`accept: ${log}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof HandoffError) {
      process.stderr.write(`accept: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function cmdRehydrate(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df rehydrate — read-only catch-up on a handoff Issue (v2 Issue-anchored).",
        "",
        "Usage:",
        "  df rehydrate [issue]",
        "",
        "Derives LIVE state for the Issue + each linked work item. Changes no",
        "ownership — this is the verb for resuming your OWN in-flight work;",
        "/accept is for taking over someone else's.",
        "",
        "Args:",
        "  [issue]            Explicit Issue number. Omit for 2-tier resolution:",
        "                     tier 1 = open + @me, tier 2 = closed + @me ≤7d.",
        "",
        "Flags:",
        "  --help, -h         Show this message.",
        "",
        "Output:",
        "  stdout — rendered rehydration view (operator-readable).",
        "  stderr — non-fatal warns (e.g. tier-2 closedAt-parse skip).",
        "",
        "Exit:",
        "  0  success",
        "  1  handoff error (unreachable Issue, gh failure, no-arg miss, etc.)",
        "  2  usage error",
        "",
      ].join("\n"),
    );
    return 0;
  }

  try {
    requireSafeArgs(rest);
  } catch (err) {
    process.stderr.write(`df rehydrate: ${(err as Error).message}\n`);
    return 2;
  }

  if (rest.length > 1) {
    process.stderr.write(
      `df rehydrate: unexpected extra arguments: ${rest.slice(1).join(" ")}\n`,
    );
    return 2;
  }

  const issueStr = rest[0];
  let issue: number | undefined;
  try {
    issue = requireIssueNumber(issueStr);
  } catch (err) {
    process.stderr.write(`df rehydrate: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    const result = await runRehydrate({
      ...(issue !== undefined ? { issue } : {}),
      gh: new SpawnGhClient(),
      clock: new SystemClock(),
    });
    process.stdout.write(`${renderRehydrateText(result.rehydrate)}\n`);
    for (const log of result.logs) {
      process.stderr.write(`rehydrate: ${log}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof HandoffError) {
      process.stderr.write(`rehydrate: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function cmdHandoffs(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df handoffs — list the stack of handed-off Issues (v2 Issue-anchored).",
        "",
        "Usage:",
        "  df handoffs",
        "",
        "Prints the open + `handoff`-labeled + unassigned Issues, oldest first",
        "by updatedAt — the stack to pick from with `df accept <issue>`.",
        "",
        "Flags:",
        "  --help, -h         Show this message.",
        "",
        "Output:",
        "  stdout — rendered stack list (header + one row per Issue + footer).",
        "",
        "Exit:",
        "  0  success (empty stack also exits 0)",
        "  1  handoff error (gh issue list failed)",
        "  2  usage error",
        "",
      ].join("\n"),
    );
    return 0;
  }

  try {
    requireSafeArgs(rest);
  } catch (err) {
    process.stderr.write(`df handoffs: ${(err as Error).message}\n`);
    return 2;
  }
  if (rest.length > 0) {
    process.stderr.write(
      `df handoffs: takes no arguments (got: ${rest.join(" ")}).\n`,
    );
    return 2;
  }

  try {
    const result = await runHandoffs({
      gh: new SpawnGhClient(),
      clock: new SystemClock(),
    });
    process.stdout.write(`${result.text}\n`);
    for (const log of result.logs) {
      process.stderr.write(`handoffs: ${log}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof HandoffError) {
      process.stderr.write(`handoffs: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
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
    // If a subcommand is present alongside --help, forward to its own
    // help printer rather than the global one (this is critical for
    // `df mcp --help`: cmdMcp owns stdout in stdio mode and must be the
    // only writer of help text for its subcommand).
    const sub0 = args[0] ?? "";
    if (
      !PHASE_C_SUBCOMMANDS.has(sub0) &&
      !PHASE_D_SUBCOMMANDS.has(sub0) &&
      !PHASE_F_SUBCOMMANDS.has(sub0) &&
      !PHASE_F_LOCAL_SUBCOMMANDS.has(sub0) &&
      !PHASE_G_SUBCOMMANDS.has(sub0) &&
      !CYCLE12_SUBCOMMANDS.has(sub0) &&
      !CYCLE11_SUBCOMMANDS.has(sub0) &&
      !SHOW_STATUS_SUBCOMMANDS.has(sub0) &&
      !SKILLS_SUBCOMMANDS.has(sub0) &&
      !ONBOARD_SUBCOMMANDS.has(sub0) &&
      !VERIFY_SUBCOMMANDS.has(sub0)
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
  // Cycle 22 (#192) — `df verify` route-runner orchestrator. Wraps runRoutes:
  // arms the routes for the commit's diff, runs each producer, writes
  // diffHash-bound evidence, and maps the 0/1/2 route contract to its exit.
  if (sub === "verify") {
    return await cmdVerify(rest, {
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
    });
  }
  if (sub === "stats") {
    return await cmdStats(rest);
  }
  // Phase G — agentic MCP surface (cycle5).
  if (sub === "mcp") {
    return await cmdMcp(rest);
  }
  // Cycle 12 Phase 12.2 — agent handoff protocol v2 verbs (Issue-anchored,
  // native-baton). cmdHandoff/cmdAccept/cmdRehydrate/cmdHandoffs wrap the
  // verb orchestrators from src/handoff/index.ts; their --help text owns the
  // per-subcommand help via the CYCLE12_SUBCOMMANDS gate in the early --help
  // interception above.
  if (sub === "handoff") {
    return await cmdHandoff(rest);
  }
  if (sub === "accept") {
    return await cmdAccept(rest);
  }
  if (sub === "rehydrate") {
    return await cmdRehydrate(rest);
  }
  if (sub === "handoffs") {
    return await cmdHandoffs(rest);
  }
  // Cycle 11 Phase 11.1 — PR Flow Assessor surfacing.
  if (sub === "flow") {
    return await cmdFlow(rest, {
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
      parseFlags,
    });
  }
  // `df show` / `df status` — CLI mirrors of the df_show_run / df_findings
  // MCP tools. See src/lib/show-status-core.ts for the shared backend.
  if (sub === "show") {
    return await cmdShow(rest, {
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
    });
  }
  if (sub === "status") {
    return await cmdStatus(rest, {
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
    });
  }
  // Cycle 13 (dark-factory-platform#149) — `df findings --range` audit
  // surface for the iteration-receipt artifacts the new default
  // final-commit-only `df gate-push` semantic intentionally leaves
  // un-gated. NOT a gate; opt-in inspection only.
  if (sub === "findings") {
    return await cmdFindings(rest, {
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
    });
  }
  // DFP #192 — bundled-skill installer surface. The subcommand fans out
  // into `install/list` inside cmdSkills, mirroring the `df flow` pattern.
  if (sub === "skills") {
    return await cmdSkills(rest);
  }
  // Cycle 15 Phase A — `df onboard --analysis-only --json [target]` runs
  // the deterministic Stage A scanner and emits a bounded RepoAnalysis.
  if (sub === "onboard") {
    return await cmdOnboardCli(rest, {
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
    });
  }
  return notImplemented(sub);
}

// Only run main() when this module is the program entry point.
// Tests and other modules can `import` cli.ts to reuse helpers
// (e.g. `resolveProductionSelfConsistencyProbe`) without triggering
// `main(process.argv)` as a side-effect of the import. The realpath
// dance handles symlinked installs (npm bin shims often symlink
// `dist/cli.js` into `node_modules/.bin/df`). Same posture as
// sage-cli (see commit f0f945e). Cursor finding (cli.ts:560) tests
// reach `resolveProductionSelfConsistencyProbe` by importing this
// module; without the guard they'd trigger the help path on import.
function isInvokedAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isInvokedAsMain()) {
  main(process.argv).then(
    // `finalizeExit` records the exit code AND arms an unref'd force-exit
    // backstop so a leaked handle in a vendor critic SDK can't hang the
    // process past the CI job timeout (issue #167). See `./exit.ts`.
    (code) => finalizeExit(code),
    (err: unknown) => {
      process.stderr.write(`df: fatal: ${(err as Error).message}\n`);
      finalizeExit(1);
    },
  );
}
