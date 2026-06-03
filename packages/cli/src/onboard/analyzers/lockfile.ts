// Lockfile analyzer — cycle 15 Phase A.
//
// Reads ONE lockfile per repo (precedence: package-lock.json > yarn.lock >
// poetry.lock > go.sum) and populates two RepoAnalysis fields:
//
//   1. `dependencies[]` — top 20 DIRECT deps with PINNED versions
//      (schema cap = 20). The deterministic name+version table Phase B's
//      LLM cites verbatim in ADR seeds (cycle 15 D2 lines 132–134).
//
//   2. `decisions[]` — heuristic markers (test-framework / deploy-target /
//      stack / auth-model) derived from dep names. Schema cap = 10 globally.
//
// `package.json` alone (no lockfile) returns null: only a real lockfile has
// PINNED versions — package.json deps are ranges. Stack DETECTION is the
// manifest analyzer's job (Task 3); pinned versions are this analyzer's.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { parse as parseYarnLock } from "@yarnpkg/lockfile";
import type { Analyzer } from "../analyzer.js";
import type { Dependency, Decision } from "../schema.js";

const MAX_DEPS = 20;
const MAX_DECISIONS = 10;

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

async function chooseLockfile(
  rootDir: string,
): Promise<{ name: LockfileName; contents: string } | null> {
  for (const name of LOCKFILE_PRECEDENCE) {
    const contents = await readIfExists(join(rootDir, name));
    if (contents !== null) return { name, contents };
  }
  return null;
}

// package-lock.json — handles both lockfileVersion 1 (root-level dependencies
// with the version values being the pins) and 2/3 (packages[""].dependencies
// for direct-dep names; packages["node_modules/<name>"].version for the pin).
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
      if (out.length >= MAX_DEPS) return out;
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
      if (out.length >= MAX_DEPS) return out;
    }
  }

  return out;
}

// yarn.lock — cross-reference top-level package.json keys with parsed lockfile
// entries; lockfile keys take the form "<name>@<range>", so we look up each
// direct dep by its requested range.
async function parseYarn(
  contents: string,
  lockfilePath: string,
  rootDir: string,
): Promise<Dependency[]> {
  const pkgJsonRaw = await readIfExists(join(rootDir, "package.json"));
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

  const out: Dependency[] = [];
  for (const [name, range] of Object.entries(directDeps)) {
    const key = `${name}@${range}`;
    const entry = entries[key];
    const version =
      entry && typeof entry.version === "string" ? entry.version : range;
    out.push({ name, version, manifestPath: lockfilePath });
    if (out.length >= MAX_DEPS) return out;
  }
  return out;
}

// poetry.lock — iterate [[package]] blocks. Older formats use category="main";
// newer formats omit category — accept either.
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
    if (out.length >= MAX_DEPS) return out;
  }
  return out;
}

// go.sum — `<module> <version>/go.mod <hash>` lines. The /go.mod-suffix is
// the canonical pin (the bare `<module> <version>` lines hash the module zip;
// many lines per dep exist — first-match-per-module wins).
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
    if (out.length >= MAX_DEPS) return out;
  }
  return out;
}

function deriveDecisions(
  dependencies: Dependency[],
  lockfilePath: string,
): Decision[] {
  const out: Decision[] = [];
  for (const dep of dependencies) {
    const lower = dep.name.toLowerCase();
    for (const marker of DECISION_MARKERS) {
      if (lower === marker.match) {
        out.push({
          title: marker.title,
          surface: marker.surface,
          evidence: [lockfilePath],
        });
        if (out.length >= MAX_DECISIONS) return out;
        break;
      }
    }
  }
  return out;
}

export const lockfileAnalyzer: Analyzer = {
  name: "lockfile",
  async detect(rootDir) {
    const chosen = await chooseLockfile(rootDir);
    if (chosen === null) return null;

    let dependencies: Dependency[];
    switch (chosen.name) {
      case "package-lock.json":
        dependencies = parsePackageLock(chosen.contents, chosen.name);
        break;
      case "yarn.lock":
        dependencies = await parseYarn(chosen.contents, chosen.name, rootDir);
        break;
      case "poetry.lock":
        dependencies = parsePoetry(chosen.contents, chosen.name);
        break;
      case "go.sum":
        dependencies = parseGoSum(chosen.contents, chosen.name);
        break;
    }

    const decisions = deriveDecisions(dependencies, chosen.name);
    return { dependencies, decisions };
  },
};
