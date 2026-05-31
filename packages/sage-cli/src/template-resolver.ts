import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the absolute path to the bundled Sage template.
 *
 * Layout at runtime (after `npm install @momentiq/sage-cli`):
 *
 *   <package-root>/
 *     dist/cli.js          <- this file, after build
 *     dist/template-resolver.js
 *     template/            <- bundled sage-blueprint contents
 *       copier.yaml
 *       template/...
 *       .bundle-info.json
 *
 * The template directory is populated at build time by
 * `scripts/bundle-template.mjs` (which fetches a pinned sage-blueprint
 * commit) and shipped via the `files: ["dist", "template", ...]` array
 * in package.json. We resolve it relative to this module's URL so the
 * lookup works regardless of where npm installed the package.
 */

const THIS_FILE = fileURLToPath(import.meta.url);
// dist/template-resolver.js -> dist -> package root -> template
const PACKAGE_ROOT = dirname(dirname(THIS_FILE));
const BUNDLED_TEMPLATE_PATH = join(PACKAGE_ROOT, "template");

export function getBundledTemplatePath(): string {
  if (!existsSync(BUNDLED_TEMPLATE_PATH)) {
    throw new Error(
      `Bundled Sage template not found at ${BUNDLED_TEMPLATE_PATH}. ` +
        `This package was built without running scripts/bundle-template.mjs, ` +
        `which means the npm tarball is corrupt. Reinstall @momentiq/sage-cli.`,
    );
  }
  const copierYaml = join(BUNDLED_TEMPLATE_PATH, "copier.yaml");
  if (!existsSync(copierYaml)) {
    throw new Error(
      `Bundled template at ${BUNDLED_TEMPLATE_PATH} is missing copier.yaml. ` +
        `The bundle is incomplete. Reinstall @momentiq/sage-cli.`,
    );
  }
  return BUNDLED_TEMPLATE_PATH;
}

export interface BundleInfo {
  /** sage-blueprint commit hash this CLI version was built against. */
  commit: string;
  /** sage-blueprint git ref the commit was resolved from (branch or tag). */
  ref: string;
  /** ISO-8601 timestamp of the bundle step. */
  fetched_at: string;
  /** sage-blueprint repo full name (e.g. "momentiq-ai/sage-blueprint"). */
  source_repo: string;
}

export function getBundleInfo(): BundleInfo | null {
  const infoPath = join(BUNDLED_TEMPLATE_PATH, ".bundle-info.json");
  if (!existsSync(infoPath)) return null;
  try {
    const raw = readFileSync(infoPath, "utf-8");
    return JSON.parse(raw) as BundleInfo;
  } catch {
    return null;
  }
}
