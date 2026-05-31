#!/usr/bin/env node
import { Command } from "commander";

import { runCreate } from "./commands/create.js";
import { runUpdate } from "./commands/update.js";
import { renderVersionBanner } from "./version.js";

const program = new Command();

program
  .name("sage")
  .description(
    "Sage CLI — scaffold a production-ready agentic AI product (FastAPI + Next.js + LangGraph + Helm), pre-wired to Cerebe and the Dark Factory gate. Customer-facing wrapper around the bundled Sage template.",
  )
  .version(renderVersionBanner(), "-v, --version", "show the CLI version + the bundled sage-blueprint commit");

program
  .command("create")
  .description("scaffold a new product from the bundled Sage template")
  .argument("[slug]", "product slug (also the directory name). Derived from --product-name if omitted.")
  .option("-n, --product-name <name>", "product display name (e.g. HireFlow)")
  .option("-p, --primary-persona <persona>", "primary user role (e.g. employer)")
  .option(
    "-s, --secondary-persona <persona>",
    "secondary user role (pass empty string '' to opt out)",
  )
  .option("-d, --domain <domain>", "production domain (e.g. hireflow.ai)")
  .option("--github-org <org>", "GitHub organization (defaults to momentiq-ai)")
  .option("--skip-df-gate", "skip the Dark Factory gate wiring (you can wire it in later)", false)
  .option("--skip-cerebe", "skip the Cerebe SDK wiring (you can wire it in later)", false)
  .option(
    "--no-post-install",
    "suppress the post-scaffold next-steps printout",
  )
  .option(
    "--accept-defaults",
    "pass --defaults to Copier (no prompts for unset advanced variables)",
    true,
  )
  .action(async (slug: string | undefined, options) => {
    const exitCode = await runCreate({
      slug,
      productName: options.productName,
      primaryPersona: options.primaryPersona,
      secondaryPersona: options.secondaryPersona,
      domain: options.domain,
      githubOrg: options.githubOrg,
      skipDfGate: Boolean(options.skipDfGate),
      skipCerebe: Boolean(options.skipCerebe),
      noPostInstall: options.postInstall === false,
      acceptDefaults: Boolean(options.acceptDefaults),
    });
    process.exit(exitCode);
  });

program
  .command("update")
  .description("pull the latest bundled template into an existing scaffolded product")
  .argument("[destination]", "scaffolded product directory (defaults to current working directory)")
  .option("--dry-run", "show what would change without writing any files", false)
  .action(async (destination: string | undefined, options) => {
    const exitCode = await runUpdate({
      destination,
      dryRun: Boolean(options.dryRun),
    });
    process.exit(exitCode);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
});
