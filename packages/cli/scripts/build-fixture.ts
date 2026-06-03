#!/usr/bin/env -S npx tsx
// packages/cli/scripts/build-fixture.ts
//
// Ground-truth fixture builder for Cycle 15 Phase A — Task 11.
//
// Produces a 3-file fixture under <destDir> for a single source repo:
//   - tree.tar.gz       structural files only (≤ 50 KB target)
//   - git-history.txt   compact replay format (canonical / branch / 200 subjects)
//   - golden.json       analyze() output over the replayed tree (regression baseline)
//
// Usage:
//   npx tsx packages/cli/scripts/build-fixture.ts \
//     --repo <owner/name> [--ref <sha>] --dest <fixtureDir>
//
// Default --ref is the source clone's HEAD when the script runs (and the SHA is
// printed at the end so it can be pinned in the fixtures README). Source repos
// MUST be cloned WITHOUT --depth (shallow clones break `git log -200` on small
// histories AND triggered the 2026-06-02 d2669eb incident).
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
// Import via dist/ so the script doesn't have to be in the tsc rootDir.
import { analyze } from "../dist/onboard/analyze.js";
import {
  parseGitHistory,
  replayGitHistory,
} from "../dist/onboard/fixtures/replay-git-history.js";

const ex = promisify(execFile);

const TRUNCATE_PLACEHOLDER = "# truncated for fixture\n";
const TRUNCATE_THRESHOLD = 200; // bytes
const TARBALL_SIZE_BUDGET = 50 * 1024; // 50 KB

// Manifest files at the repo root that the analyzers parse fully — they must
// keep their full content (no truncation). Note: lockfiles get special
// downsize treatment (see shrinkPackageLock / shrinkLockfile) because the
// lockfile analyzer reads ONLY the direct-dep slice; preserving the entire
// node_modules-shadow tree would blow the 50 KB budget on any non-trivial
// repo (DFP's package-lock.json alone is 124 KB).
const ROOT_MANIFEST_FILES = new Set<string>([
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "mix.exs",
  "pom.xml",
  "build.gradle.kts",
  ".tool-versions",
  ".python-version",
  ".nvmrc",
  ".ruby-version",
  "Dockerfile",
]);

// Lockfiles: structurally parsed but ONLY for the direct-dep slice. We rewrite
// each into a minimal shape that exposes the top-N direct deps with pinned
// versions; the full lockfile is never copied.
const ROOT_LOCKFILE_FILES = new Set<string>([
  "package-lock.json",
  "yarn.lock",
  "poetry.lock",
  "go.sum",
]);

const LOCKFILE_TOP_N = 20; // mirrors the analyzer's MAX_DEPS cap

// Root-level doc files captured by name (presence detection).
const ROOT_DOC_FILES = new Set<string>([
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "ARCHITECTURE.md",
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
]);

// Top-level dirs whose immediate children should be preserved as placeholder
// markers so the tree analyzer's service discovery still fires.
const SERVICE_PARENT_DIRS = ["services", "apps", "packages"];

interface Args {
  repo: string;
  ref?: string;
  dest: string;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a === "--ref") out.ref = argv[++i];
    else if (a === "--dest") out.dest = argv[++i];
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: build-fixture.ts --repo <owner/name> [--ref <sha>] --dest <dir>\n",
      );
      process.exit(0);
    }
  }
  if (!out.repo || !out.dest) {
    process.stderr.write(
      "Error: --repo and --dest are required.\n" +
        "Usage: build-fixture.ts --repo <owner/name> [--ref <sha>] --dest <dir>\n",
    );
    process.exit(2);
  }
  return out as Args;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

async function copyFile(src: string, dest: string): Promise<void> {
  await ensureDir(dirname(dest));
  await cp(src, dest);
}

// Copy a file. If it's NOT a structurally-meaningful file (manifest/workflow)
// AND > TRUNCATE_THRESHOLD bytes, replace its body with the truncation
// placeholder. Manifests + workflows always keep full content because the
// analyzers parse them.
async function copyStructural(
  src: string,
  dest: string,
  fullContent: boolean,
): Promise<void> {
  await ensureDir(dirname(dest));
  if (fullContent) {
    await cp(src, dest);
    return;
  }
  const size = (await stat(src)).size;
  if (size <= TRUNCATE_THRESHOLD) {
    await cp(src, dest);
  } else {
    await writeFile(dest, TRUNCATE_PLACEHOLDER, "utf8");
  }
}

// Recursively copy every *.md under src/<rel> into <stagingRoot>/<rel>.
// Markdown files are TRUNCATE-ELIGIBLE (size > TRUNCATE_THRESHOLD → placeholder)
// to keep the tarball under budget — try with full content first; the caller
// retries with retruncation if the tarball exceeds budget.
async function copyDocsTree(
  srcRoot: string,
  stagingRoot: string,
  forceTruncate: boolean,
): Promise<void> {
  const docsSrc = join(srcRoot, "docs");
  if (!(await isDir(docsSrc))) return;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = relative(srcRoot, full);
        const dest = join(stagingRoot, rel);
        await copyStructural(full, dest, !forceTruncate);
      }
    }
  };
  await walk(docsSrc);
}

// Copy every .github/workflows/*.yml|yaml — these MUST keep full content
// because ciAnalyzer parses them via the YAML parser. Capped at MAX_WORKFLOWS
// because the RepoAnalysis schema enforces `.max(20)` on `ci.workflows`; if a
// real source repo has > 20 workflows (sage3c has 28), copying them all would
// make analyze() throw on Zod validation. We pick the first 20 alphabetically
// for a deterministic-and-defensible slice; this is a fixture-builder
// constraint, not an analyzer claim.
const MAX_WORKFLOWS = 20;

async function copyWorkflows(
  srcRoot: string,
  stagingRoot: string,
): Promise<void> {
  const wfSrc = join(srcRoot, ".github", "workflows");
  if (!(await isDir(wfSrc))) return;
  const entries = await readdir(wfSrc, { withFileTypes: true });
  const workflowFiles = entries
    .filter(
      (e) =>
        e.isFile() && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")),
    )
    .map((e) => e.name)
    .sort()
    .slice(0, MAX_WORKFLOWS);
  for (const name of workflowFiles) {
    await copyFile(
      join(wfSrc, name),
      join(stagingRoot, ".github", "workflows", name),
    );
  }
}

// Copy root manifests + root docs verbatim (manifests because analyzers parse
// them; root docs because their PRESENCE matters and they're small enough).
// Markdown root docs ARE truncate-eligible to keep the tarball lean.
async function copyRootFiles(
  srcRoot: string,
  stagingRoot: string,
  forceTruncateMarkdown: boolean,
): Promise<void> {
  const entries = await readdir(srcRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (ROOT_MANIFEST_FILES.has(name)) {
      await copyStructural(
        join(srcRoot, name),
        join(stagingRoot, name),
        true,
      );
    } else if (ROOT_LOCKFILE_FILES.has(name)) {
      await copyLockfileSlim(
        join(srcRoot, name),
        join(stagingRoot, name),
        name,
      );
    } else if (ROOT_DOC_FILES.has(name)) {
      await copyStructural(
        join(srcRoot, name),
        join(stagingRoot, name),
        !forceTruncateMarkdown,
      );
    }
  }
}

// Service discovery placeholder markers: for every immediate subdir under
// services/ apps/ packages/, leave a tiny .fixture-placeholder so:
//   - tree analyzer's services[] discovery still fires
//   - tree analyzer counts the parent dir as a top-level entry with files
// We don't need to recurse — the analyzer only enumerates immediate children.
async function copyServiceMarkers(
  srcRoot: string,
  stagingRoot: string,
): Promise<void> {
  for (const parent of SERVICE_PARENT_DIRS) {
    const parentSrc = join(srcRoot, parent);
    if (!(await isDir(parentSrc))) continue;
    let children;
    try {
      children = await readdir(parentSrc, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (child.name.startsWith(".")) continue;
      const marker = join(stagingRoot, parent, child.name, ".fixture-placeholder");
      await ensureDir(dirname(marker));
      await writeFile(marker, "", "utf8");
    }
  }
}

// .husky directory presence is enough for dfPresence.hooks — create a single
// placeholder marker (the analyzer only checks dir existence). If the source
// has actual hook scripts, we don't need their bodies.
async function copyHuskyMarker(
  srcRoot: string,
  stagingRoot: string,
): Promise<void> {
  if (!(await isDir(join(srcRoot, ".husky")))) return;
  const marker = join(stagingRoot, ".husky", ".fixture-placeholder");
  await ensureDir(dirname(marker));
  await writeFile(marker, "", "utf8");
}

async function copyAgentReviewConfig(
  srcRoot: string,
  stagingRoot: string,
): Promise<void> {
  // dfPresence.configJson only checks isFile — never reads contents.
  // Write a tiny stub instead of copying the (potentially KB-sized) real file.
  const src = join(srcRoot, ".agent-review", "config.json");
  if (!(await isFile(src))) return;
  const dest = join(stagingRoot, ".agent-review", "config.json");
  await ensureDir(dirname(dest));
  await writeFile(dest, "{}\n", "utf8");
}

// Shrink package-lock.json to the minimum shape the analyzer reads:
//   packages[""] : root entry with dependencies + devDependencies (names only)
//   packages["node_modules/<name>"] : { version: "<pinned>" } for each direct dep
// Top 20 entries (mirroring the lockfile analyzer's MAX_DEPS cap).
function shrinkPackageLock(contents: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return contents;
  }
  if (typeof parsed !== "object" || parsed === null) return contents;
  const obj = parsed as Record<string, unknown>;
  const packages = obj.packages as Record<string, Record<string, unknown>> | undefined;
  if (!packages) return contents;
  const root = packages[""];
  if (!root || typeof root !== "object") return contents;

  const directDeps: Record<string, string> = {
    ...(root.dependencies as Record<string, string> | undefined),
    ...(root.devDependencies as Record<string, string> | undefined),
  };
  const slicedNames = Object.keys(directDeps).slice(0, LOCKFILE_TOP_N);
  const slicedDeps: Record<string, string> = {};
  for (const n of slicedNames) slicedDeps[n] = directDeps[n] ?? "";

  // Re-split into dependencies vs devDependencies so the analyzer's spread
  // logic still picks them up. Names that came from devDependencies stay there.
  const origDeps = (root.dependencies as Record<string, string> | undefined) ?? {};
  const origDevDeps = (root.devDependencies as Record<string, string> | undefined) ?? {};
  const newDeps: Record<string, string> = {};
  const newDevDeps: Record<string, string> = {};
  for (const n of slicedNames) {
    if (n in origDeps) newDeps[n] = origDeps[n] ?? "";
    else if (n in origDevDeps) newDevDeps[n] = origDevDeps[n] ?? "";
  }

  const newPackages: Record<string, Record<string, unknown>> = {
    "": {
      ...(typeof root.name === "string" ? { name: root.name } : {}),
      ...(typeof root.version === "string" ? { version: root.version } : {}),
      ...(Object.keys(newDeps).length > 0 ? { dependencies: newDeps } : {}),
      ...(Object.keys(newDevDeps).length > 0 ? { devDependencies: newDevDeps } : {}),
    },
  };
  for (const n of slicedNames) {
    const entry = packages[`node_modules/${n}`];
    const version =
      entry && typeof entry.version === "string"
        ? entry.version
        : slicedDeps[n] ?? "";
    newPackages[`node_modules/${n}`] = { version };
  }

  const shrunk = {
    name: typeof obj.name === "string" ? obj.name : "fixture",
    version: typeof obj.version === "string" ? obj.version : "0.0.0",
    lockfileVersion: typeof obj.lockfileVersion === "number" ? obj.lockfileVersion : 3,
    requires: true,
    packages: newPackages,
  };
  return JSON.stringify(shrunk, null, 2) + "\n";
}

// Shrink yarn.lock by truncating to a small synthetic block. Yarn.lock parsing
// happens against package.json; we keep package.json intact and only need a
// few representative entries here so the parser doesn't choke.
function shrinkYarnLock(contents: string): string {
  // Keep the first 100 lines of the lockfile so the parser has a meaningful
  // header + sample. The analyzer cross-refs against package.json keys, so
  // missing entries are skipped gracefully (fallback to the requested range).
  const lines = contents.split(/\r?\n/);
  return lines.slice(0, 100).join("\n");
}

// Shrink poetry.lock by keeping only the top-N [[package]] blocks.
function shrinkPoetryLock(contents: string): string {
  const blocks = contents.split(/(?=^\[\[package\]\])/m);
  // First chunk is header (lockfile metadata + version pins).
  const header = blocks[0] ?? "";
  const pkgBlocks = blocks.slice(1, 1 + LOCKFILE_TOP_N);
  return header + pkgBlocks.join("");
}

// Shrink go.sum by keeping the first N module lines. Order matters
// minimally — the analyzer dedupes by name.
function shrinkGoSum(contents: string): string {
  const lines = contents.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // 2 lines per module typically (zip + go.mod); take ~3 * cap to be safe.
  return lines.slice(0, LOCKFILE_TOP_N * 3).join("\n") + "\n";
}

async function copyLockfileSlim(
  srcPath: string,
  destPath: string,
  name: string,
): Promise<void> {
  const body = await readFile(srcPath, "utf8");
  let shrunk: string;
  switch (name) {
    case "package-lock.json":
      shrunk = shrinkPackageLock(body);
      break;
    case "yarn.lock":
      shrunk = shrinkYarnLock(body);
      break;
    case "poetry.lock":
      shrunk = shrinkPoetryLock(body);
      break;
    case "go.sum":
      shrunk = shrinkGoSum(body);
      break;
    default:
      shrunk = body;
  }
  await ensureDir(dirname(destPath));
  await writeFile(destPath, shrunk, "utf8");
}

// Build the structural staging tree. forceTruncateMarkdown=true is the
// retry path when the tarball overshoots the 50 KB budget.
async function buildStaging(
  srcRoot: string,
  stagingRoot: string,
  forceTruncateMarkdown: boolean,
): Promise<void> {
  await ensureDir(stagingRoot);
  await copyRootFiles(srcRoot, stagingRoot, forceTruncateMarkdown);
  await copyWorkflows(srcRoot, stagingRoot);
  await copyDocsTree(srcRoot, stagingRoot, forceTruncateMarkdown);
  await copyServiceMarkers(srcRoot, stagingRoot);
  await copyHuskyMarker(srcRoot, stagingRoot);
  await copyAgentReviewConfig(srcRoot, stagingRoot);
}

async function tarStaging(
  stagingRoot: string,
  tarballPath: string,
): Promise<void> {
  await ensureDir(dirname(tarballPath));
  await ex("tar", ["-czf", tarballPath, "-C", stagingRoot, "."]);
}

// Parse `<owner>/<repo>[.git]` from an HTTPS or SSH remote URL — mirrors the
// gitAnalyzer logic so the canonical line in git-history.txt is byte-identical
// to what gitAnalyzer would compute.
function parseCanonicalName(remoteUrl: string): string {
  const https = remoteUrl.match(
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = remoteUrl.match(/^[^@]+@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return "";
}

async function gitCapture(cwd: string): Promise<{
  canonical: string;
  defaultBranch: string;
  remote: string;
  subjects: string[];
  sha: string;
}> {
  const sha = (
    await ex("git", ["rev-parse", "HEAD"], { cwd })
  ).stdout.trim();

  let remote = "";
  try {
    remote = (
      await ex("git", ["remote", "get-url", "origin"], { cwd })
    ).stdout.trim();
  } catch {
    /* no remote */
  }
  const canonical = parseCanonicalName(remote);

  let defaultBranch = "main";
  try {
    const symref = (
      await ex(
        "git",
        ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        { cwd },
      )
    ).stdout.trim();
    if (symref.startsWith("refs/remotes/origin/")) {
      defaultBranch = symref.slice("refs/remotes/origin/".length);
    }
  } catch {
    try {
      const head = (
        await ex("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })
      ).stdout.trim();
      if (head && head !== "HEAD") defaultBranch = head;
    } catch {
      /* fall through to "main" */
    }
  }

  const logOut = await ex(
    "git",
    ["log", "--pretty=%s", "-200", "--reverse"],
    { cwd, maxBuffer: 10 * 1024 * 1024 },
  );
  const subjects = logOut.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { canonical, defaultBranch, remote, subjects, sha };
}

function composeGitHistoryText(
  canonical: string,
  defaultBranch: string,
  remote: string,
  subjects: string[],
  sha: string,
  destBasename: string,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# git-history.txt for fixtures/${destBasename}/`);
  lines.push(`# Generated by build-fixture.ts at ${sha} on ${today}.`);
  lines.push(`canonical: ${canonical}`);
  lines.push(`defaultBranch: ${defaultBranch}`);
  if (remote) lines.push(`remote: ${remote}`);
  lines.push("");
  lines.push("# Last 200 subject lines (oldest -> newest), captured via:");
  lines.push("#   git log --pretty=%s -200 --reverse");
  lines.push("subjects:");
  for (const s of subjects) lines.push(s);
  lines.push("");
  return lines.join("\n");
}

// Normalize the absolute repoRoot path in the golden so the integration test
// can deep-equal across machines / tmp-dir layouts.
function normalizeGolden(analysis: unknown): unknown {
  if (
    analysis &&
    typeof analysis === "object" &&
    !Array.isArray(analysis) &&
    "repoRoot" in analysis
  ) {
    return { ...(analysis as Record<string, unknown>), repoRoot: "<NORM>" };
  }
  return analysis;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const destAbs = resolve(args.dest);
  const destBasename = destAbs.split(sep).filter(Boolean).pop() ?? "fixture";

  process.stderr.write(`[build-fixture] repo=${args.repo} dest=${destAbs}\n`);

  await ensureDir(destAbs);

  // -- Step 1: clone (NO --depth) -----------------------------------------
  const tmpRoot = await mkdtemp(join(tmpdir(), "build-fixture-"));
  const cloneDir = join(tmpRoot, "clone");
  process.stderr.write(`[build-fixture] cloning into ${cloneDir} ...\n`);
  await ex("gh", ["repo", "clone", args.repo, cloneDir], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (args.ref) {
    process.stderr.write(`[build-fixture] checkout ${args.ref}\n`);
    await ex("git", ["checkout", args.ref], { cwd: cloneDir });
  }

  // -- Step 4 (read git first so we know the sha to record) ----------------
  const capture = await gitCapture(cloneDir);
  process.stderr.write(
    `[build-fixture] sha=${capture.sha} branch=${capture.defaultBranch} subjects=${capture.subjects.length}\n`,
  );

  // -- Step 2 + 3: stage + tar (with size-budget retry) --------------------
  const stagingDir = join(tmpRoot, "staging");
  const tarballPath = join(destAbs, "tree.tar.gz");

  let forceTruncate = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    await rm(stagingDir, { recursive: true, force: true });
    await buildStaging(cloneDir, stagingDir, forceTruncate);
    await tarStaging(stagingDir, tarballPath);
    const size = (await stat(tarballPath)).size;
    process.stderr.write(
      `[build-fixture] tarball ${size} bytes (budget ${TARBALL_SIZE_BUDGET}) — attempt ${attempt + 1}, forceTruncate=${forceTruncate}\n`,
    );
    if (size <= TARBALL_SIZE_BUDGET) break;
    if (attempt === 0) {
      process.stderr.write(
        "[build-fixture] over budget — retrying with markdown truncation\n",
      );
      forceTruncate = true;
    } else {
      process.stderr.write(
        `[build-fixture] WARNING: tarball ${size} bytes exceeds ${TARBALL_SIZE_BUDGET}-byte budget after retry.\n`,
      );
    }
  }

  // -- Write git-history.txt -----------------------------------------------
  const historyText = composeGitHistoryText(
    capture.canonical,
    capture.defaultBranch,
    capture.remote,
    capture.subjects,
    capture.sha,
    destBasename,
  );
  const historyPath = join(destAbs, "git-history.txt");
  await writeFile(historyPath, historyText, "utf8");
  process.stderr.write(`[build-fixture] wrote ${historyPath}\n`);

  // -- Step 5: replay history into a fresh extract + run analyze() ---------
  const goldenWorkdir = await mkdtemp(join(tmpdir(), "golden-extract-"));
  try {
    await ex("tar", ["-xzf", tarballPath, "-C", goldenWorkdir]);
    const history = parseGitHistory(historyText);
    await replayGitHistory(goldenWorkdir, history);

    // -- Step 6: analyze + write golden.json -------------------------------
    const analysis = await analyze(goldenWorkdir);
    const golden = normalizeGolden(analysis);
    const goldenPath = join(destAbs, "golden.json");
    await writeFile(
      goldenPath,
      JSON.stringify(golden, null, 2) + "\n",
      "utf8",
    );
    process.stderr.write(`[build-fixture] wrote ${goldenPath}\n`);
  } finally {
    await rm(goldenWorkdir, { recursive: true, force: true });
  }

  // -- Cleanup ------------------------------------------------------------
  await rm(tmpRoot, { recursive: true, force: true });

  process.stderr.write(
    `[build-fixture] DONE — repo=${args.repo} sha=${capture.sha} dest=${destAbs}\n`,
  );
  process.stdout.write(
    JSON.stringify(
      {
        repo: args.repo,
        sha: capture.sha,
        defaultBranch: capture.defaultBranch,
        canonical: capture.canonical,
        dest: destAbs,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(
    `[build-fixture] FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
