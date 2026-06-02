import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getBundleInfo, type BundleInfo } from "./template-resolver.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = dirname(dirname(THIS_FILE));

interface PackageJson {
  version: string;
  name: string;
}

function readPackageJson(): PackageJson {
  const raw = readFileSync(join(PACKAGE_ROOT, "package.json"), "utf-8");
  return JSON.parse(raw) as PackageJson;
}

/**
 * Pure helper — render the version banner given pre-resolved inputs.
 *
 * Splits the org prefix off `bundle.source_repo` so the user-facing line reads
 * `bundled sage-blueprint@<sha>` (not `bundled momentiq-ai/sage-blueprint@<sha>`).
 * The full `source_repo` stays in `template/.bundle-info.json` for diagnostics
 * — this is render-time only. Matches the post-PR #88 README example. (#90)
 */
export function formatVersionBanner(
  name: string,
  version: string,
  bundle: BundleInfo | null,
): string {
  if (!bundle) {
    return `${name} ${version} (bundled template: <bundle-info missing>)`;
  }
  const shortSha = bundle.commit.slice(0, 12);
  const repoName = bundle.source_repo.split("/").pop() ?? bundle.source_repo;
  return `${name} ${version} (bundled ${repoName}@${shortSha} via ref ${bundle.ref})`;
}

/**
 * Render the version banner shown by `sage --version`.
 *
 * Includes the CLI version and the pinned sage-blueprint commit the
 * bundled template was built against — so a customer reporting a bug
 * can include both pieces of provenance in one line.
 */
export function renderVersionBanner(): string {
  const { name, version } = readPackageJson();
  return formatVersionBanner(name, version, getBundleInfo());
}
