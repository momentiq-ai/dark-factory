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
// The remaining subcommands listed in --help (review, gate, doctor) land
// in Phase E (or 331.3 re-publish). For now they print a "not implemented"
// message and exit 2.
//
// Argument parsing is intentionally minimal — every flag after a Phase C
// subcommand is passed through to the wrapped Python script verbatim.
// The Python scripts already have argparse-based help; consumers invoke
// `df validate-cycle-doc --help` to get the full flag list. Phase D
// subcommands accept their own flags directly (see `cmdAudit` and
// `cmdAdmitPr` below).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runValidateCycleDoc } from "./cycle-doc-validator/index.js";
import { runAuditBranchProtection } from "./branch-protection/index.js";
import {
  runSyncCycleTrackers,
  runAttributePrCycleRef,
} from "./cycle-tracker-sync/index.js";
import {
  readTelemetryEvents,
  summarizeTelemetry,
  computeQuorumStats,
  computeCriticAgreement,
} from "./evidence/audit-trail.js";
import { classifyPrKindFromFiles } from "./policy/merge-queue.js";

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
      "Subcommands (coming in cycle 331.1 Phase E):",
      "  df review                 Run the multi-critic review for the current commit",
      "  df gate                   Evaluate gate verdict for the current commit",
      "  df doctor                 Diagnose installation, env, and config",
      "",
      "Each Phase C subcommand passes its remaining argv through to the bundled",
      "Python script verbatim; run `df <subcommand> --help` for full flags.",
      "Phase D subcommands parse flags directly — see `df audit --help` and",
      "`df admit-pr --help`.",
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
      "Status: 0.1.0-alpha.2 — Phase D extracts services #6/#8 (pure-TS).",
      "        Pure-TS port of #5/#7/#9 tracked as Phase C-PORT follow-up.",
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
      `    Phase B/C ship services as library + Python-wrapped subcommands;\n` +
      `    "${sub}" lands in Phase E.\n` +
      `    Run \"df --help\" for the planned command list.\n`,
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
    if (!PHASE_C_SUBCOMMANDS.has(sub0) && !PHASE_D_SUBCOMMANDS.has(sub0)) {
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
