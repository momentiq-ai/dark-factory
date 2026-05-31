#!/usr/bin/env node
/**
 * Build-time step: populate `packages/sage-cli/template/` with the
 * contents of `momentiq-ai/sage-blueprint` at a pinned ref, and write
 * `template/.bundle-info.json` recording the commit hash.
 *
 * This script runs as `prebuild` in `package.json` (npm scripts), so it
 * fires automatically before `tsc`. It runs in CI (where the bundled
 * template needs to be fresh from sage-blueprint) and locally when a
 * developer iterates on the wrapper.
 *
 * Resolution order (first match wins):
 *
 *   1. `SAGE_BLUEPRINT_LOCAL_PATH` env var (absolute path to a local
 *      sage-blueprint checkout). Local-dev fast path; copies straight
 *      from disk; reads commit via `git -C <path> rev-parse HEAD`.
 *
 *   2. `git clone` from `https://${GH_TOKEN}@github.com/momentiq-ai/sage-blueprint`
 *      at `SAGE_BLUEPRINT_REF` (default `main`) into a temp dir.
 *      In CI, `GH_TOKEN` is `SAGE_BLUEPRINT_READ_TOKEN` — a fine-grained
 *      token with `Contents: Read` on sage-blueprint only. Locally,
 *      `gh auth token` or any token in `GH_TOKEN` works.
 *
 * The script is idempotent: re-running it wipes `template/` (except
 * `.keep`) and repopulates. The `.keep` file is preserved so the empty
 * directory stays in git after a clean (.keep is gitignored-exempted).
 *
 * Failure modes:
 *   - missing GH_TOKEN in CI without LOCAL_PATH -> exit 2 with hint
 *   - git clone failure (network, auth, ref not found) -> exit 3
 *   - copy failure (disk full, permissions) -> exit 4
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const TEMPLATE_DEST = join(PACKAGE_ROOT, "template");
const KEEP_FILE = join(TEMPLATE_DEST, ".keep");

const DEFAULT_REPO = "momentiq-ai/sage-blueprint";
const DEFAULT_REF = process.env["SAGE_BLUEPRINT_REF"] ?? "main";
const SOURCE_REPO = process.env["SAGE_BLUEPRINT_REPO"] ?? DEFAULT_REPO;
const LOCAL_PATH = process.env["SAGE_BLUEPRINT_LOCAL_PATH"];

const TEMPLATE_FILES_TO_COPY = ["copier.yaml", "template", "LICENSE", "NOTICE", "README.md"];

async function main() {
  log(`bundling sage-blueprint template into ${TEMPLATE_DEST}`);

  // Refresh destination — wipe everything except .keep.
  if (existsSync(TEMPLATE_DEST)) {
    rmSync(TEMPLATE_DEST, { recursive: true, force: true });
  }
  mkdirSync(TEMPLATE_DEST, { recursive: true });
  await writeFile(KEEP_FILE, "# placeholder — see scripts/bundle-template.mjs\n");

  const bundled = LOCAL_PATH ? await bundleFromLocal(LOCAL_PATH) : await bundleFromGit();
  log(bundled ? "bundle complete" : "bundle skipped");
}

async function bundleFromLocal(source) {
  log(`source: local path ${source}`);
  if (!existsSync(source)) {
    fail(`SAGE_BLUEPRINT_LOCAL_PATH does not exist: ${source}`, 2);
  }
  const commit = readGitCommit(source);
  await copyTemplateFiles(source);
  await writeBundleInfo({
    commit,
    ref: "<local>",
    source_repo: SOURCE_REPO,
    source_path: source,
  });
  return true;
}

async function bundleFromGit() {
  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (!token) {
    // No-op gracefully when no input is available. The wrapper's
    // tsc build does NOT need the bundled template (template/ is at the
    // package root, not under src/), so non-publish CI workflows can
    // run `npm run build` against the workspace root without
    // SAGE_BLUEPRINT_READ_TOKEN. The publish-sage-cli job has a
    // separate "Validate sage-cli package" step that fails if it
    // reaches publish without a bundled template — so the safety
    // property holds: we never ship an empty bundle.
    //
    // Set SAGE_CLI_REQUIRE_BUNDLE=1 to opt back into the fail-fast
    // behavior locally (useful when iterating on the script itself).
    if (process.env["SAGE_CLI_REQUIRE_BUNDLE"] === "1") {
      fail(
        "no SAGE_BLUEPRINT_LOCAL_PATH and no GH_TOKEN/GITHUB_TOKEN in env, and " +
          "SAGE_CLI_REQUIRE_BUNDLE=1 was set. Either provide a token / local path, " +
          "or unset SAGE_CLI_REQUIRE_BUNDLE.",
        2,
      );
    }
    log("skip: no SAGE_BLUEPRINT_LOCAL_PATH and no GH_TOKEN/GITHUB_TOKEN in env.");
    log("      Bundling skipped; template/ left empty.");
    log("      This is the expected path in non-publish CI (agent-critic, schema-check, etc.).");
    log("      The publish-sage-cli job sets GH_TOKEN and runs the real bundle step.");
    log("      For local dev, set SAGE_BLUEPRINT_LOCAL_PATH=/path/to/sage-blueprint.");
    return false;
  }

  const tmp = mkdtempSync(join(tmpdir(), "sage-blueprint-"));
  log(`source: git clone ${SOURCE_REPO}@${DEFAULT_REF} -> ${tmp}`);
  const url = `https://x-access-token:${token}@github.com/${SOURCE_REPO}.git`;
  try {
    execFileSync(
      "git",
      ["clone", "--depth=1", "--branch", DEFAULT_REF, url, tmp],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  } catch (err) {
    fail(`git clone failed: ${err instanceof Error ? err.message : String(err)}`, 3);
  }

  const commit = readGitCommit(tmp);
  await copyTemplateFiles(tmp);
  await writeBundleInfo({ commit, ref: DEFAULT_REF, source_repo: SOURCE_REPO });

  rmSync(tmp, { recursive: true, force: true });
  return true;
}

function readGitCommit(path) {
  try {
    const out = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    });
    return out.trim();
  } catch (err) {
    fail(
      `failed to read git commit from ${path}: ${err instanceof Error ? err.message : String(err)}`,
      3,
    );
    return ""; // unreachable
  }
}

async function copyTemplateFiles(sourceRoot) {
  for (const name of TEMPLATE_FILES_TO_COPY) {
    const src = join(sourceRoot, name);
    if (!existsSync(src)) {
      // README/LICENSE/NOTICE are optional — only copier.yaml + template are required.
      if (name === "copier.yaml" || name === "template") {
        fail(`required file ${name} missing in source ${sourceRoot}`, 3);
      }
      continue;
    }
    const dest = join(TEMPLATE_DEST, name);
    await cp(src, dest, { recursive: true });
  }
  // Verify the two must-haves actually landed.
  if (!existsSync(join(TEMPLATE_DEST, "copier.yaml"))) {
    fail("copier.yaml did not copy", 4);
  }
  if (!existsSync(join(TEMPLATE_DEST, "template"))) {
    fail("template/ did not copy", 4);
  }
}

async function writeBundleInfo(info) {
  // SOURCE_DATE_EPOCH override supports reproducible-build tooling
  // (https://reproducible-builds.org/specs/source-date-epoch/).
  const epoch = process.env["SOURCE_DATE_EPOCH"];
  const fetchedAt = epoch
    ? new Date(Number(epoch) * 1000).toISOString()
    : new Date().toISOString();

  const payload = {
    commit: info.commit,
    ref: info.ref,
    source_repo: info.source_repo,
    fetched_at: fetchedAt,
  };
  if (info.source_path) payload.source_path = info.source_path;
  await writeFile(
    join(TEMPLATE_DEST, ".bundle-info.json"),
    JSON.stringify(payload, null, 2) + "\n",
  );
  log(`  commit:  ${info.commit}`);
  log(`  ref:     ${info.ref}`);
}

function log(msg) {
  process.stderr.write(`[bundle-template] ${msg}\n`);
}

function fail(msg, code) {
  process.stderr.write(`[bundle-template] error: ${msg}\n`);
  process.exit(code);
}

await main();
