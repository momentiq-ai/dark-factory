import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { parse as parseYaml } from "yaml";

import { ensureCopierInstalled, runCopierUpdate } from "../copier.js";
import { getBundledTemplatePath, getBundleInfo } from "../template-resolver.js";

export interface UpdateOptions {
  /** Path to the scaffolded product (defaults to cwd). */
  destination: string | undefined;
  /** Run copier with --pretend (no file changes). */
  dryRun: boolean;
}

interface CopierAnswers {
  /** sage-blueprint commit the customer's product was last rendered against. */
  _commit?: string;
  /** Path/URL the template was rendered from. */
  _src_path?: string;
}

export async function runUpdate(opts: UpdateOptions): Promise<number> {
  // 1. Verify copier is installed.
  const copier = ensureCopierInstalled();
  if (!copier.installed) {
    process.stderr.write(`error: ${copier.installHint}\n`);
    return 127;
  }

  // 2. Resolve destination + verify it's a scaffolded product.
  const destination = resolvePath(process.cwd(), opts.destination ?? ".");
  const answersPath = resolvePath(destination, ".copier-answers.yml");
  if (!existsSync(answersPath)) {
    process.stderr.write(
      `error: ${destination} does not contain a .copier-answers.yml. ` +
        `'sage update' must be run inside a scaffolded product directory.\n`,
    );
    return 2;
  }

  // 3. Report the drift (customer's anchored commit vs the bundled commit).
  const answers = readCopierAnswers(answersPath);
  const bundle = getBundleInfo();
  printDrift(answers, bundle, opts.dryRun);

  // 4. Run copier update. Copier reads .copier-answers.yml internally
  //    to find the template; we pass the destination as the working
  //    dir AND the trusted bundled template path so runCopierUpdate
  //    can verify the destination's _src_path matches before invoking
  //    `copier update --trust` (otherwise a hostile _src_path could
  //    redirect --trust into an attacker-controlled template's _tasks).
  let trustedTemplatePath: string;
  try {
    trustedTemplatePath = getBundledTemplatePath();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
  const updateOpts: Parameters<typeof runCopierUpdate>[0] = {
    destination,
    trustedTemplatePath,
  };
  if (opts.dryRun) updateOpts.dryRun = true;
  try {
    return await runCopierUpdate(updateOpts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

function readCopierAnswers(path: string): CopierAnswers {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = parseYaml(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as CopierAnswers;
  } catch {
    return {};
  }
}

function printDrift(
  answers: CopierAnswers,
  bundle: ReturnType<typeof getBundleInfo>,
  dryRun: boolean,
): void {
  const anchored = answers._commit ?? "<unknown>";
  const target = bundle?.commit ?? "<unknown>";
  const shortAnchored = typeof anchored === "string" ? anchored.slice(0, 12) : "<unknown>";
  const shortTarget = typeof target === "string" ? target.slice(0, 12) : "<unknown>";

  process.stdout.write("\n");
  process.stdout.write(`Template drift:\n`);
  process.stdout.write(`  your product was last rendered at: ${shortAnchored}\n`);
  process.stdout.write(`  this CLI's bundled template is at: ${shortTarget}\n`);
  if (shortAnchored === shortTarget && shortAnchored !== "<unknown>") {
    process.stdout.write(`  -> up to date; nothing to do\n\n`);
  } else if (dryRun) {
    process.stdout.write(`  -> running copier update --pretend (no file changes)\n\n`);
  } else {
    process.stdout.write(`  -> running copier update; you will be prompted before each conflict\n\n`);
  }
}
