import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getBundleInfo } from "./template-resolver.js";

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
 * Render the version banner shown by `sage --version`.
 *
 * Includes the CLI version and the pinned sage-blueprint commit the
 * bundled template was built against — so a customer reporting a bug
 * can include both pieces of provenance in one line.
 */
export function renderVersionBanner(): string {
  const { name, version } = readPackageJson();
  const bundle = getBundleInfo();
  if (!bundle) {
    return `${name} ${version} (bundled template: <bundle-info missing>)`;
  }
  const shortSha = bundle.commit.slice(0, 12);
  return `${name} ${version} (bundled ${bundle.source_repo}@${shortSha} via ref ${bundle.ref})`;
}
