// Lockfile analyzer — cycle 15 Phase A (multi-root aggregation per #137).
//
// Walks the repo (bounded depth + skip set) for every known lockfile, parses
// each, and aggregates contributions into the two RepoAnalysis fields:
//
//   1. `dependencies[]` — top 20 DIRECT deps with PINNED versions across ALL
//      detected lockfiles (schema cap = 20). The deterministic name+version
//      table Phase B's LLM cites verbatim in ADR seeds (cycle 15 D2 lines
//      132–134). Each entry's `manifestPath` is the source lockfile relative
//      to the repo root (e.g. `package-lock.json`, `web/package-lock.json`).
//
//   2. `decisions[]` — heuristic markers (test-framework / deploy-target /
//      stack / auth-model) derived from dep names, deduped on the
//      `(title, surface)` tuple across all lockfiles; `evidence[]` is the
//      sorted union of source lockfile paths. Schema cap = 10 globally.
//
// `package.json` alone (no lockfile) returns null: only a real lockfile has
// PINNED versions — package.json deps are ranges. Stack DETECTION is the
// manifest analyzer's job (Task 3); pinned versions are this analyzer's.
//
// Multi-root rationale (#137): monorepos like sage3c put the real frontend
// signals in `web/package-lock.json` and backend signals in
// `backend/poetry.lock`; choosing ONE root lockfile would emit zero
// decisions and break ADR seeding downstream.
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import TOML from "@iarna/toml";
// @yarnpkg/lockfile is CJS; ESM only sees the default export.
// Pull `parse` off the default to keep ESM consumers + Node ESM-loader happy.
import yarnpkgLockfile from "@yarnpkg/lockfile";
const { parse: parseYarnLock } = yarnpkgLockfile;
import type { Analyzer } from "../analyzer.js";
import type { Dependency, Decision } from "../schema.js";

const MAX_DEPS = 20;
const MAX_DECISIONS = 10;
// Walk depth: 0 = root, 1 = direct child (e.g. `web/`), 2 = grandchild
// (e.g. `tools/df-flow-assessor/`), 3 = great-grandchild. Covers every
// sage3c lockfile (deepest is depth-2). Mirrors tree.ts's depth budget.
const MAX_LOCKFILE_DEPTH = 3;

// Skip the same set tree.ts skips — kept local on purpose so this analyzer's
// diff doesn't collide with any sibling refactor of tree.ts. Hidden entries
// (starting with `.`) are also skipped to keep .git/.github/.venv etc. out
// of the walk.
const SKIP_DIR_NAMES = new Set<string>([
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".venv",
  "__pycache__",
  ".gradle",
]);

function shouldSkipDir(name: string): boolean {
  if (name.startsWith(".")) return true;
  if (SKIP_DIR_NAMES.has(name)) return true;
  return false;
}

// Decision-surface heuristics. Each entry matches a single dep name (exact
// match, post-lowercase) and emits ONE decision with evidence: [lockfilePath].
// Title strings follow the spec's example phrasing — Phase B's LLM polishes
// the narrative; Phase A only surfaces deterministic signals.
const DECISION_MARKERS: Array<{
  match: string;
  surface: Decision["surface"];
  title: string;
}> = [
  // test-framework
  { match: "vitest", surface: "test-framework", title: "Repo uses Vitest as test framework" },
  { match: "jest", surface: "test-framework", title: "Repo uses Jest as test framework" },
  { match: "mocha", surface: "test-framework", title: "Repo uses Mocha as test framework" },
  { match: "pytest", surface: "test-framework", title: "Repo uses Pytest as test framework" },

  // deploy-target
  { match: "@kubernetes/client-node", surface: "deploy-target", title: "Repo deploys via Kubernetes" },
  { match: "aws-sdk", surface: "deploy-target", title: "Repo deploys via AWS" },

  // stack — frontend
  { match: "next", surface: "stack", title: "Frontend stack: Next.js" },
  { match: "react", surface: "stack", title: "Frontend stack: React" },
  { match: "vue", surface: "stack", title: "Frontend stack: Vue" },
  { match: "svelte", surface: "stack", title: "Frontend stack: Svelte" },
  { match: "solid-js", surface: "stack", title: "Frontend stack: Solid.js" },

  // stack — backend
  { match: "express", surface: "stack", title: "Backend framework: Express" },
  { match: "fastify", surface: "stack", title: "Backend framework: Fastify" },
  { match: "koa", surface: "stack", title: "Backend framework: Koa" },
  { match: "hono", surface: "stack", title: "Backend framework: Hono" },
  { match: "fastapi", surface: "stack", title: "Backend framework: FastAPI" },
  { match: "gin", surface: "stack", title: "Backend framework: Gin" },

  // auth-model
  { match: "passport", surface: "auth-model", title: "Auth model: Passport" },
  { match: "auth0", surface: "auth-model", title: "Auth model: Auth0" },
  { match: "clerk", surface: "auth-model", title: "Auth model: Clerk" },
  { match: "next-auth", surface: "auth-model", title: "Auth model: NextAuth" },
  { match: "nextauth", surface: "auth-model", title: "Auth model: NextAuth" },
];

const LOCKFILE_PRECEDENCE = [
  "package-lock.json",
  "yarn.lock",
  "poetry.lock",
  "go.sum",
] as const;

type LockfileName = (typeof LOCKFILE_PRECEDENCE)[number];

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

const LOCKFILE_SET: ReadonlySet<string> = new Set(LOCKFILE_PRECEDENCE);

interface DiscoveredLockfile {
  name: LockfileName;
  // Forward-slash relative path from rootDir; never starts with "./". For a
  // root-level lockfile this is just the bare filename (preserves the
  // existing `manifestPath: "package-lock.json"` contract).
  relPath: string;
  absDir: string;
  contents: string;
}

// Walk the repo (bounded by MAX_LOCKFILE_DEPTH + SKIP_DIR_NAMES) for every
// known lockfile filename. Results are sorted by relPath for deterministic
// output across readdir order.
async function discoverLockfiles(
  rootDir: string,
): Promise<DiscoveredLockfile[]> {
  const found: DiscoveredLockfile[] = [];

  async function walk(absDir: string, depth: number): Promise<void> {
    if (depth > MAX_LOCKFILE_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      // Permission denied / transient — treat as empty so one unreadable
      // subtree can't bomb the whole analyzer.
      return;
    }
    // Read files in this dir before descending so each level's lockfile
    // joins `found` before its descendants'.
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!LOCKFILE_SET.has(entry.name)) continue;
      const absPath = join(absDir, entry.name);
      const contents = await readIfExists(absPath);
      if (contents === null) continue;
      const rel = relative(rootDir, absPath).split(sep).join("/");
      found.push({
        name: entry.name as LockfileName,
        relPath: rel,
        absDir,
        contents,
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipDir(entry.name)) continue;
      await walk(join(absDir, entry.name), depth + 1);
    }
  }

  await walk(rootDir, 0);
  found.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return found;
}

// package-lock.json — handles both lockfileVersion 1 (root-level dependencies
// with the version values being the pins) and 2/3 (packages[""].dependencies
// for direct-dep names; packages["node_modules/<name>"].version for the pin).
//
// Returns EVERY direct dep (no internal cap). The aggregate cap is enforced
// in `detect()` so the decision-marker scan can find matches anywhere in the
// lockfile, not just within the first 20 alphabetical entries.
function parsePackageLock(contents: string, lockfilePath: string): Dependency[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const obj = parsed as Record<string, unknown>;

  const out: Dependency[] = [];
  const seen = new Set<string>();

  // v2/v3: prefer packages[""] for direct-dep NAMES; resolve pins from
  // packages["node_modules/<name>"].version when available.
  const packages = obj.packages;
  const root =
    typeof packages === "object" && packages !== null
      ? (packages as Record<string, Record<string, unknown> | undefined>)[""]
      : undefined;
  if (root !== undefined && typeof root === "object" && packages !== null) {
    const directDeps: Record<string, string> = {
      ...(root.dependencies as Record<string, string> | undefined),
      ...(root.devDependencies as Record<string, string> | undefined),
    };
    const pkgMap = packages as Record<string, Record<string, unknown>>;
    for (const [name, requestedRange] of Object.entries(directDeps)) {
      if (seen.has(name)) continue;
      const pkgEntry = pkgMap[`node_modules/${name}`];
      const pinnedVersion =
        pkgEntry && typeof pkgEntry.version === "string"
          ? pkgEntry.version
          : requestedRange;
      out.push({ name, version: pinnedVersion, manifestPath: lockfilePath });
      seen.add(name);
    }
  }

  // v1 fallback (and a belt+braces top-up if v2/v3 produced nothing): root
  // dependencies/devDependencies whose values ARE the pinned versions.
  if (out.length === 0) {
    const flat: Record<string, string> = {
      ...(obj.dependencies as Record<string, string> | undefined),
      ...(obj.devDependencies as Record<string, string> | undefined),
    };
    for (const [name, version] of Object.entries(flat)) {
      if (seen.has(name)) continue;
      // v1 entries can be either bare strings (pin) or objects with .version.
      // We only get strings here from the spread above; objects are excluded.
      if (typeof version !== "string") continue;
      out.push({ name, version, manifestPath: lockfilePath });
      seen.add(name);
    }
  }

  return out;
}

// yarn.lock — cross-reference the SIBLING package.json's deps (NOT the repo
// root's — yarn workspaces put a lockfile next to a per-package manifest)
// with parsed lockfile entries; lockfile keys take the form "<name>@<range>",
// so we look up each direct dep by its requested range.
async function parseYarn(
  contents: string,
  lockfilePath: string,
  lockfileDir: string,
): Promise<Dependency[]> {
  const pkgJsonRaw = await readIfExists(join(lockfileDir, "package.json"));
  if (pkgJsonRaw === null) return [];
  let pkg: unknown;
  try {
    pkg = JSON.parse(pkgJsonRaw);
  } catch {
    return [];
  }
  if (typeof pkg !== "object" || pkg === null) return [];
  const pkgObj = pkg as Record<string, unknown>;
  const directDeps: Record<string, string> = {
    ...(pkgObj.dependencies as Record<string, string> | undefined),
    ...(pkgObj.devDependencies as Record<string, string> | undefined),
  };

  const parsed = parseYarnLock(contents);
  if (parsed.type === "conflict") return [];
  const entries = parsed.object;

  // Returns every direct dep (no internal cap — aggregate cap is in detect()).
  const out: Dependency[] = [];
  for (const [name, range] of Object.entries(directDeps)) {
    const key = `${name}@${range}`;
    const entry = entries[key];
    const version =
      entry && typeof entry.version === "string" ? entry.version : range;
    out.push({ name, version, manifestPath: lockfilePath });
  }
  return out;
}

// poetry.lock — iterate [[package]] blocks. Older formats use category="main";
// newer formats omit category — accept either. Returns every package (no
// internal cap — aggregate cap is in detect()).
function parsePoetry(contents: string, lockfilePath: string): Dependency[] {
  let parsed: unknown;
  try {
    parsed = TOML.parse(contents);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const pkgs = (parsed as Record<string, unknown>).package;
  if (!Array.isArray(pkgs)) return [];

  const out: Dependency[] = [];
  for (const raw of pkgs) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const category = entry.category;
    if (typeof category === "string" && category !== "main") continue;
    const name = entry.name;
    const version = entry.version;
    if (typeof name !== "string" || typeof version !== "string") continue;
    out.push({ name, version, manifestPath: lockfilePath });
  }
  return out;
}

// go.sum — `<module> <version>/go.mod <hash>` lines. The /go.mod-suffix is
// the canonical pin (the bare `<module> <version>` lines hash the module zip;
// many lines per dep exist — first-match-per-module wins). Returns every
// module (no internal cap — aggregate cap is in detect()).
function parseGoSum(contents: string, lockfilePath: string): Dependency[] {
  const out: Dependency[] = [];
  const seen = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Match: "<module> <version>/go.mod <hash>"
    const match = trimmed.match(/^(\S+)\s+(\S+?)\/go\.mod\s+/);
    if (!match) continue;
    const name = match[1];
    const version = match[2];
    if (name === undefined || version === undefined) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, version, manifestPath: lockfilePath });
  }
  return out;
}

async function parseOne(lf: DiscoveredLockfile): Promise<Dependency[]> {
  switch (lf.name) {
    case "package-lock.json":
      return parsePackageLock(lf.contents, lf.relPath);
    case "yarn.lock":
      return parseYarn(lf.contents, lf.relPath, lf.absDir);
    case "poetry.lock":
      return parsePoetry(lf.contents, lf.relPath);
    case "go.sum":
      return parseGoSum(lf.contents, lf.relPath);
  }
}

export const lockfileAnalyzer: Analyzer = {
  name: "lockfile",
  async detect(rootDir) {
    const discovered = await discoverLockfiles(rootDir);
    if (discovered.length === 0) return null;

    // Aggregate dependencies + decisions across every lockfile, capped at the
    // schema maxima. Dependencies dedupe on `name` (the FIRST lockfile in
    // sort order wins — root before subdirs). Decisions dedupe on the
    // `(title, surface)` tuple with evidence accumulated as the sorted union
    // of source lockfiles.
    const dependencies: Dependency[] = [];
    const seenDeps = new Set<string>();
    const decisionMap = new Map<
      string,
      { title: string; surface: Decision["surface"]; evidence: Set<string> }
    >();

    for (const lf of discovered) {
      const deps = await parseOne(lf);

      // Take this lockfile's contribution to the bounded dependency table.
      // The cap is checked BEFORE the push so `dependencies.length` is
      // strictly ≤ MAX_DEPS (the schema's hard contract — exceeding it
      // throws inside `RepoAnalysisSchema.parse()`).
      for (const dep of deps) {
        if (dependencies.length >= MAX_DEPS) break;
        if (seenDeps.has(dep.name)) continue;
        seenDeps.add(dep.name);
        dependencies.push(dep);
      }

      // Decision-marker scan walks EVERY parsed dep for this lockfile,
      // independent of whether the dep made it into the bounded table.
      // Without this independence, a long alphabetical lockfile (e.g.
      // sage3c's backend/poetry.lock) would fill the 20-slot dependency
      // budget before reaching `fastapi`/`pytest`, suppressing the
      // marker scan even though the names are right there in the file.
      for (const dep of deps) {
        const lower = dep.name.toLowerCase();
        for (const marker of DECISION_MARKERS) {
          if (lower !== marker.match) continue;
          const key = `${marker.surface} ${marker.title}`;
          const existing = decisionMap.get(key);
          if (existing) {
            existing.evidence.add(lf.relPath);
          } else if (decisionMap.size < MAX_DECISIONS) {
            decisionMap.set(key, {
              title: marker.title,
              surface: marker.surface,
              evidence: new Set([lf.relPath]),
            });
          }
          break;
        }
      }
    }

    const decisions: Decision[] = Array.from(decisionMap.values()).map((d) => ({
      title: d.title,
      surface: d.surface,
      evidence: Array.from(d.evidence).sort(),
    }));

    return { dependencies, decisions };
  },
};
