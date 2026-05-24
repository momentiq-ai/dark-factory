#!/usr/bin/env node
// Dark Factory CLI entrypoint — Phase B stub.
//
// Phase B ships the underlying services (Critic Orchestrator, Policy Engine,
// Trusted-Surface Rebind) but does NOT wire up the subcommand surface. The
// full CLI subcommand implementation lands in cycle 331.1 Phase E (or 331.3
// re-publish), where the `df review`, `df gate`, `df doctor`, `df audit`,
// `df sync-cycle-trackers`, and `df attribute-pr-cycle-ref` commands gain
// their argv parsing, env handling, and exit-code semantics.
//
// For now this entrypoint prints help and exits cleanly so the `df` binary
// is installable + invokable without crashing.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
      "  df --version          Print version and exit",
      "  df --help             Print this help and exit",
      "",
      "Subcommands (coming in cycle 331.1 Phase E):",
      "  df review             Run the multi-critic review for the current commit",
      "  df gate               Evaluate gate verdict for the current commit",
      "  df doctor             Diagnose installation, env, and config",
      "  df audit              Branch-protection / cycle-doc audits",
      "",
      "Library usage today:",
      "  import { runReview, evaluateCommitGate, buildReviewPacket }",
      `    from \"${name}\";`,
      "",
      "Status: Phase B alpha (0.1.0-alpha.x). Subcommand surface is stubbed;",
      "        the underlying services are consumable as a library.",
      "",
      "Docs:   https://github.com/momentiq-ai/dark-factory",
      "",
    ].join("\n"),
  );
}

function printVersion(meta: PackageMeta): void {
  process.stdout.write(`${meta.version ?? "unknown"}\n`);
}

function main(argv: string[]): number {
  const meta = readPackageMeta();
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp(meta);
    return 0;
  }
  if (args.includes("--version") || args.includes("-V")) {
    printVersion(meta);
    return 0;
  }
  const sub = args[0];
  process.stderr.write(
    `df: subcommand "${sub}" is not implemented in this alpha build.\n` +
      `    Phase B ships services-as-library; subcommand surface lands in Phase E.\n` +
      `    Run \"df --help\" for the planned command list.\n`,
  );
  return 2;
}

process.exitCode = main(process.argv);
