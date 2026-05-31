import { existsSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import prompts from "prompts";

import { ensureCopierInstalled, runCopierCopy } from "../copier.js";
import { isValidSlug, slugify } from "../slug.js";
import { getBundledTemplatePath } from "../template-resolver.js";

export interface CreateOptions {
  /** Positional: the directory + product slug the customer typed. */
  slug: string | undefined;
  /** Customer-facing product name (e.g. "HireFlow"). */
  productName: string | undefined;
  /** Primary persona (e.g. "employer"). */
  primaryPersona: string | undefined;
  /** Optional secondary persona. Pass empty string to opt out. */
  secondaryPersona: string | undefined;
  /** Production domain (e.g. "hireflow.ai"). */
  domain: string | undefined;
  /** GitHub org (defaults to "momentiq-ai"). */
  githubOrg: string | undefined;
  /** Skip the interactive Dark Factory gate setup. */
  skipDfGate: boolean;
  /** Skip the interactive Cerebe SDK wiring. */
  skipCerebe: boolean;
  /** Suppress all post-scaffold automation (no `npm ci`, no `make df-doctor`). */
  noPostInstall: boolean;
  /** Pass through to copier — accept defaults for any unset variable. */
  acceptDefaults: boolean;
}

interface ResolvedData {
  slug: string;
  productName: string;
  primaryPersona: string;
  secondaryPersona: string;
  domain: string;
  githubOrg: string;
  enableAgentReview: boolean;
  cerebeBaseUrl: string;
}

const DEFAULT_GITHUB_ORG = "momentiq-ai";
const DEFAULT_CEREBE_BASE_URL = "https://api.cerebe.ai";

export async function runCreate(opts: CreateOptions): Promise<number> {
  // 1. Verify copier is installed before doing anything else.
  const copier = ensureCopierInstalled();
  if (!copier.installed) {
    process.stderr.write(`error: ${copier.installHint}\n`);
    return 127;
  }

  // 2. Resolve all required inputs — interactive prompts fill any gaps.
  const data = await resolveData(opts);
  if (data === null) {
    process.stderr.write("error: cancelled by user\n");
    return 130;
  }

  // 3. Compute the absolute destination path. Refuse to overwrite an
  //    existing non-empty directory — copier will also refuse but we
  //    want the friendlier message.
  const destination = resolvePath(process.cwd(), data.slug);
  if (existsSync(destination)) {
    process.stderr.write(
      `error: ${destination} already exists. Choose a different slug or remove the directory.\n`,
    );
    return 17;
  }
  mkdirSync(destination, { recursive: true });

  // 4. Resolve the bundled template path.
  let templatePath: string;
  try {
    templatePath = getBundledTemplatePath();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }

  // 5. Render the template through Copier with pre-filled data.
  const copierData = buildCopierData(data);
  process.stdout.write(`\nScaffolding ${data.productName} (${data.slug})...\n\n`);
  const exitCode = await runCopierCopy({
    templatePath,
    destination,
    data: copierData,
    acceptDefaults: opts.acceptDefaults,
  });
  if (exitCode !== 0) {
    process.stderr.write(
      `error: copier exited with status ${exitCode}. Your destination may be partially populated.\n`,
    );
    return exitCode;
  }

  // 6. Post-scaffold next-steps prompt — no automatic side effects.
  //    Running `npm ci`, `make df-doctor`, and `doppler setup` requires
  //    side-effects the customer should consent to explicitly.
  process.stdout.write(`\nScaffold complete: ${destination}\n\n`);
  printNextSteps(data, opts);
  return 0;
}

async function resolveData(opts: CreateOptions): Promise<ResolvedData | null> {
  // product_name + slug
  let productName = opts.productName;
  let slug = opts.slug;

  if (!productName) {
    const answer = await prompts({
      type: "text",
      name: "value",
      message: "Product name (e.g. HireFlow):",
      validate: (v: string) => (v.trim().length > 0 ? true : "Required"),
    });
    if (answer.value === undefined) return null;
    productName = String(answer.value).trim();
  }

  // If the customer passed `sage create my-slug` but no --product-name,
  // they probably meant the positional to also be the product name.
  // Treat the positional as the slug, and fall back to a Titleized
  // version for the product name if still missing.
  if (!slug) slug = slugify(productName);
  if (!productName) productName = slug;

  if (!isValidSlug(slug)) {
    process.stderr.write(
      `error: '${slug}' is not a valid product slug. Use lowercase letters, digits, and hyphens; start with a letter; 2-40 chars.\n`,
    );
    return null;
  }

  // primary_persona
  let primaryPersona = opts.primaryPersona;
  if (!primaryPersona) {
    const answer = await prompts({
      type: "text",
      name: "value",
      message: "Primary persona (e.g. employer, candidate, operator):",
      validate: (v: string) => (v.trim().length > 0 ? true : "Required"),
    });
    if (answer.value === undefined) return null;
    primaryPersona = String(answer.value).trim();
  }

  // secondary_persona — optional. An empty string means skip.
  let secondaryPersona = opts.secondaryPersona;
  if (secondaryPersona === undefined) {
    const answer = await prompts({
      type: "text",
      name: "value",
      message: "Secondary persona (leave blank to skip):",
    });
    if (answer.value === undefined) return null;
    secondaryPersona = String(answer.value).trim();
  }

  // domain
  let domain = opts.domain;
  if (!domain) {
    const answer = await prompts({
      type: "text",
      name: "value",
      message: "Production domain (e.g. hireflow.ai):",
      validate: (v: string) => (v.trim().length > 0 ? true : "Required"),
    });
    if (answer.value === undefined) return null;
    domain = String(answer.value).trim();
  }

  return {
    slug,
    productName,
    primaryPersona,
    secondaryPersona,
    domain,
    githubOrg: opts.githubOrg ?? DEFAULT_GITHUB_ORG,
    enableAgentReview: !opts.skipDfGate,
    cerebeBaseUrl: opts.skipCerebe ? "" : DEFAULT_CEREBE_BASE_URL,
  };
}

/**
 * Map ResolvedData into the flat record Copier expects as --data flags.
 *
 * The keys mirror the variable names in sage-blueprint's copier.yaml.
 * Any variable not present here is left to its sage-blueprint default
 * (Copier picks them up automatically when --defaults is passed, or
 * prompts for them otherwise).
 */
function buildCopierData(data: ResolvedData): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {
    product_name: data.productName,
    product_slug: data.slug,
    primary_persona: data.primaryPersona,
    secondary_persona: data.secondaryPersona,
    domain: data.domain,
    github_org: data.githubOrg,
    doppler_project: data.slug,
    gcp_project: `momentiq-${data.slug}`,
    temporal_namespace: data.slug,
    enable_agent_review: data.enableAgentReview,
  };
  if (data.cerebeBaseUrl) {
    out["cerebe_base_url"] = data.cerebeBaseUrl;
  }
  return out;
}

function printNextSteps(data: ResolvedData, opts: CreateOptions): void {
  const lines: string[] = [];
  lines.push(`Next steps:`);
  lines.push(``);
  lines.push(`  cd ${data.slug}`);
  lines.push(``);
  lines.push(`  # 1. Set up secrets`);
  lines.push(`  doppler login`);
  lines.push(`  doppler setup --project ${data.slug}`);
  lines.push(``);
  if (data.enableAgentReview) {
    lines.push(`  # 2. Install the Dark Factory gate's local critic auth`);
    lines.push(`  npm ci --include=dev`);
    lines.push(`  npx codex login`);
    lines.push(`  cursor-agent login`);
    lines.push(``);
    lines.push(`  # 3. Verify the toolchain`);
    lines.push(`  make df-doctor`);
    lines.push(``);
  } else {
    lines.push(`  # 2. Install dependencies`);
    lines.push(`  npm install`);
    lines.push(``);
  }
  lines.push(`  # ${data.enableAgentReview ? "4" : "3"}. Start the local cluster`);
  lines.push(`  make k8s-up`);
  lines.push(`  make k8s-build-deploy-smart`);
  lines.push(``);
  if (opts.noPostInstall) {
    lines.push(`(post-scaffold automation skipped via --no-post-install)`);
    lines.push(``);
  }
  lines.push(`See ./README.md for the full Day-1 checklist.`);
  process.stdout.write(lines.join("\n") + "\n");
}
