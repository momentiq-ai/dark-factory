// packages/cli/src/onboard/analyzers/tree.ts
//
// Tree analyzer — cycle 15 Phase A, Task 6.
//
// Walks the repo with bounded depth (4) and bounded file cap (50,000) to:
//   1. classify each top-level dir (services/packages/src/tests/docs/infra/scripts/other),
//   2. count files per language extension,
//   3. surface every test directory (basename tests/test/__tests__/spec) up to depth 3,
//   4. populate `services[]` from immediate children of `services/` and `apps/`.
//
// Exceeding the file cap throws — the orchestrator records that as an
// `analyzerErrors` entry. The walk skips hidden entries (anything starting
// with `.`) at every level plus a small set of well-known build-artifact
// dirs (node_modules, dist, build, target, .next, .venv, __pycache__,
// .gradle). Those entries don't count toward fileCount or the language
// breakdown.
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Analyzer } from "../analyzer.js";
import type { Service, TopLevelDir } from "../schema.js";

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

const DIR_CATEGORY: Record<string, TopLevelDir["category"]> = {
  services: "services",
  apps: "services",
  packages: "packages",
  src: "src",
  lib: "src",
  tests: "tests",
  test: "tests",
  __tests__: "tests",
  docs: "docs",
  documentation: "docs",
  infra: "infra",
  terraform: "infra",
  deploy: "infra",
  scripts: "scripts",
  bin: "scripts",
  tools: "scripts",
};

const EXT_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".ex": "elixir",
  ".exs": "elixir",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
  ".swift": "swift",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
};

const TEST_DIR_NAMES = new Set(["tests", "test", "__tests__", "spec"]);

const MAX_DEPTH = 4;
const MAX_FILES = 50_000;
const MAX_TOP_LEVEL_DIRS = 30;
const MAX_TEST_DIRS = 20;
const MAX_SERVICES = 30;

class FileCapExceededError extends Error {
  constructor() {
    super(`tree analyzer exceeded ${MAX_FILES.toLocaleString()} file cap`);
    this.name = "FileCapExceededError";
  }
}

interface WalkState {
  fileCount: number;
  languageBreakdown: Record<string, number>;
  testDirs: string[];
  topLevelFileCounts: Map<string, number>;
}

function shouldSkipEntry(name: string): boolean {
  // Skip every hidden entry (`.git`, `.github`, `.vscode`, dotfiles…) and
  // every well-known build-artifact directory.
  if (name.startsWith(".")) return true;
  if (SKIP_DIR_NAMES.has(name)) return true;
  return false;
}

async function walk(
  absPath: string,
  relPath: string,
  depth: number,
  topLevelName: string | null,
  state: WalkState,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = await readdir(absPath, { withFileTypes: true });
  } catch {
    // Permission denied or transient — treat as empty so the analyzer
    // doesn't bomb the whole onboarding pass over one unreadable subtree.
    return;
  }
  for (const entry of entries) {
    if (shouldSkipEntry(entry.name)) continue;
    const childRel = relPath === "" ? entry.name : `${relPath}/${entry.name}`;
    const childAbs = join(absPath, entry.name);
    if (entry.isDirectory()) {
      // testDirs: any directory whose basename matches tests/test/__tests__/spec
      // at depth ≤ 3 (the directory itself sits at depth+1 from root).
      const dirDepth = depth + 1;
      if (
        dirDepth <= 3 &&
        TEST_DIR_NAMES.has(entry.name) &&
        state.testDirs.length < MAX_TEST_DIRS &&
        !state.testDirs.includes(childRel)
      ) {
        state.testDirs.push(childRel);
      }
      await walk(
        childAbs,
        childRel,
        depth + 1,
        topLevelName ?? entry.name,
        state,
      );
    } else if (entry.isFile()) {
      state.fileCount += 1;
      if (state.fileCount > MAX_FILES) throw new FileCapExceededError();
      const ext = extname(entry.name).toLowerCase();
      const bucket = EXT_LANG[ext] ?? "other";
      state.languageBreakdown[bucket] =
        (state.languageBreakdown[bucket] ?? 0) + 1;
      if (topLevelName !== null) {
        state.topLevelFileCounts.set(
          topLevelName,
          (state.topLevelFileCounts.get(topLevelName) ?? 0) + 1,
        );
      }
    }
    // Symlinks and other types are ignored — we only follow concrete files
    // and directories, which matches the manifest analyzer's posture.
  }
}

function classify(name: string): TopLevelDir["category"] {
  return DIR_CATEGORY[name] ?? "other";
}

async function listImmediateDirs(absPath: string): Promise<string[]> {
  try {
    const entries = await readdir(absPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !shouldSkipEntry(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export const treeAnalyzer: Analyzer = {
  name: "tree",
  async detect(rootDir) {
    const state: WalkState = {
      fileCount: 0,
      languageBreakdown: {},
      testDirs: [],
      topLevelFileCounts: new Map(),
    };

    // Enumerate top-level entries first so we can populate `topLevelDirs`
    // independent of how many files each subtree contains.
    let rootEntries: Dirent[];
    try {
      rootEntries = await readdir(rootDir, { withFileTypes: true });
    } catch {
      rootEntries = [];
    }

    const topLevelDirNames: string[] = [];
    for (const entry of rootEntries) {
      if (entry.isDirectory() && !shouldSkipEntry(entry.name)) {
        topLevelDirNames.push(entry.name);
      }
    }

    await walk(rootDir, "", 0, null, state);

    const topLevelDirs: TopLevelDir[] = topLevelDirNames
      .slice(0, MAX_TOP_LEVEL_DIRS)
      .map((name) => ({
        name,
        category: classify(name),
        fileCount: state.topLevelFileCounts.get(name) ?? 0,
      }));

    // Services discovery: immediate children of every top-level dir of
    // category `services` (literally `services/` or `apps/`).
    const services: Service[] = [];
    for (const top of topLevelDirNames) {
      if (classify(top) !== "services") continue;
      const children = await listImmediateDirs(join(rootDir, top));
      for (const child of children) {
        if (services.length >= MAX_SERVICES) break;
        services.push({
          name: child,
          path: `${top}/${child}`,
          stack: null,
        });
      }
      if (services.length >= MAX_SERVICES) break;
    }

    return {
      tree: {
        topLevelDirs,
        languageBreakdown: state.languageBreakdown,
        testDirs: state.testDirs.slice(0, MAX_TEST_DIRS),
        fileCount: state.fileCount,
      },
      services,
    };
  },
};
