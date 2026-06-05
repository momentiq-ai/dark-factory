#!/usr/bin/env node
// Post-build asset copy: mirror non-TypeScript files (Python scripts +
// YAML defaults) from `src/` to `dist/` so the published package can
// resolve them via `dirname(fileURLToPath(import.meta.url))` regardless
// of whether the consumer imports from `src/` (dev) or `dist/` (npm).
//
// tsc only copies `.ts` files; this script picks up the rest. Adding
// a bundler later (Phase B's "FULLY BUNDLED artifact" goal per cycle
// 331.1) will skip these too — the bundler must continue to invoke
// this script as part of its build pipeline.
//
// Whitelist extensions to avoid accidentally shipping README.md from
// inside a service directory (the package's top-level README.md is
// already covered by the `files` array in package.json).
//
// Phase C — cycle 331.1.

import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const SRC_ROOT = join(PACKAGE_ROOT, "src");
const DIST_ROOT = join(PACKAGE_ROOT, "dist");

// `.md` added in cycle 15 Phase B (Task 14) so the Stage B scaffold prompt
// asset at src/onboard/prompts/scaffold.md lands in dist/onboard/prompts/.
// `.tmpl` added in cycle 15 Phase C so the deterministic seeder templates
// (src/onboard/seeders/templates/{adr,cycle1-bootstrap,runbook}.md.tmpl)
// land in dist/onboard/seeders/templates/ — the seeders read them via
// resolve(HERE, "templates", "<name>.md.tmpl") at runtime, so the
// published-package runtime needs them present.
const COPY_EXTENSIONS = new Set([".py", ".yaml", ".yml", ".md", ".tmpl"]);

async function walkAndCopy(currentDir) {
  let copied = 0;
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  for (const entry of entries) {
    const srcPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      copied += await walkAndCopy(srcPath);
      continue;
    }
    if (!entry.isFile()) continue;
    const dotIndex = entry.name.lastIndexOf(".");
    if (dotIndex < 0) continue;
    const ext = entry.name.slice(dotIndex).toLowerCase();
    if (!COPY_EXTENSIONS.has(ext)) continue;
    const rel = relative(SRC_ROOT, srcPath);
    const destPath = join(DIST_ROOT, rel);
    await fs.mkdir(dirname(destPath), { recursive: true });
    await fs.copyFile(srcPath, destPath);
    copied += 1;
  }
  return copied;
}

const count = await walkAndCopy(SRC_ROOT);
process.stdout.write(`[copy-assets] copied ${count} non-ts asset(s) from src/ to dist/\n`);
