#!/usr/bin/env node
// Dark Factory CLI entrypoint.
//
// Phase B shipped the underlying services (Critic Orchestrator, Policy
// Engine, Trusted-Surface Rebind) as a library + a stub binary.
//
// Phase C (this file) extends the binary with four subcommands that
// wrap the Python-backed services extracted in cycle 331.1 Phase C:
//
//   df validate-cycle-doc          — service #5 (cycle-doc trailer validator)
//   df audit-branch-protection     — service #7 (branch-protection drift detector)
//   df sync-trackers               — service #9 part A (cycle tracker sync)
//   df attribute-pr                — service #9 part B (PR -> Cycle Ref attribution)
//
// The remaining subcommands listed in --help (review, gate, doctor) land
// in Phase E (or 331.3 re-publish). For now they print a "not implemented"
// message and exit 2.
//
// Argument parsing is intentionally minimal — every flag after the
// subcommand is passed through to the wrapped Python script verbatim.
// The Python scripts already have argparse-based help; consumers invoke
// `df validate-cycle-doc --help` to get the full flag list.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runValidateCycleDoc } from "./cycle-doc-validator/index.js";
import { runAuditBranchProtection } from "./branch-protection/index.js";
import {
  runSyncCycleTrackers,
  runAttributePrCycleRef,
} from "./cycle-tracker-sync/index.js";

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
      "Subcommands (coming in cycle 331.1 Phase E):",
      "  df review                 Run the multi-critic review for the current commit",
      "  df gate                   Evaluate gate verdict for the current commit",
      "  df doctor                 Diagnose installation, env, and config",
      "  df audit                  Higher-level audit aggregator",
      "",
      "Each Phase C subcommand passes its remaining argv through to the bundled",
      "Python script verbatim; run `df <subcommand> --help` for full flags.",
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
      "Status: 0.1.0-alpha.1 — Phase C services land via subprocess-wrap.",
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
    if (!PHASE_C_SUBCOMMANDS.has(sub0)) {
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
