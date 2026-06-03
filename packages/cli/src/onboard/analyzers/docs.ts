// packages/cli/src/onboard/analyzers/docs.ts
//
// Cycle 15 Phase A — Task 8. Two concerns merged in one analyzer because both
// walk the top of the tree once:
//
//   1. Docs scan — populate docs.existing[] (README/CONTRIBUTING/CHANGELOG/
//      ARCHITECTURE at root + every docs/**/*.md, cap 50), set hasClaudeMd /
//      hasAgentsMd, derive agentContextSetPresent, and (per D2 lines 142–145)
//      capture the structural envelope of CLAUDE.md / AGENTS.md when present —
//      sizeBytes + ordered H1+H2 heading list, cap 50. Bodies are NEVER stored.
//
//   2. DF gate-presence check — populate dfPresence.{hooks, configJson,
//      prWorkflow, cliPin}. cliPin parses the @momentiq/dark-factory-cli
//      version from the ROOT package.json (dependencies first, then
//      devDependencies), verbatim, or null if absent.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Analyzer } from "../analyzer.js";
import type { AgentFile } from "../schema.js";

const ROOT_DOC_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "ARCHITECTURE.md",
];
const MAX_DOCS = 50;
const MAX_HEADINGS = 50;

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

// Recursive walk of docs/ collecting *.md paths (forward-slash-relative to
// rootDir). The output array is shared with the root-doc scan, so we stop as
// soon as it hits MAX_DOCS — the cap is on the COMBINED list.
async function walkDocsDir(
  docsRoot: string,
  rootDir: string,
  out: string[],
): Promise<void> {
  if (out.length >= MAX_DOCS) return;
  let entries;
  try {
    entries = await readdir(docsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  // Stable ordering: filesystem readdir is not guaranteed sorted on all
  // platforms; sort by name so the analysis envelope is deterministic.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_DOCS) return;
    const p = join(docsRoot, entry.name);
    if (entry.isDirectory()) {
      await walkDocsDir(p, rootDir, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(relative(rootDir, p).split(sep).join("/"));
    }
  }
}

// Extract H1+H2 headings from a markdown body. Tracks fenced code block state
// so a `# foo` line inside a ```-fence is NOT counted as a heading. Strips
// trailing whitespace from each captured heading. Caps the list at
// MAX_HEADINGS (silent truncation — the test pins this behavior).
function extractHeadings(body: string): {
  sizeBytes: number;
  headings: string[];
} {
  const sizeBytes = Buffer.byteLength(body, "utf8");
  const headings: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    // Treat any ```-prefix line (optionally indented) as a fence toggle.
    if (/^\s*```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = trimmed.match(/^#{1,2}\s+(.+)$/);
    if (m && m[1] !== undefined) {
      headings.push(m[1].trimEnd());
      if (headings.length >= MAX_HEADINGS) break;
    }
  }
  return { sizeBytes, headings };
}

async function readAgentFile(p: string): Promise<AgentFile | null> {
  try {
    const body = await readFile(p, "utf8");
    return extractHeadings(body);
  } catch {
    return null;
  }
}

export const docsAnalyzer: Analyzer = {
  name: "docs",
  async detect(rootDir) {
    const existing: string[] = [];
    for (const name of ROOT_DOC_FILES) {
      if (existing.length >= MAX_DOCS) break;
      if (await isFile(join(rootDir, name))) existing.push(name);
    }
    await walkDocsDir(join(rootDir, "docs"), rootDir, existing);

    const claudeMd = await readAgentFile(join(rootDir, "CLAUDE.md"));
    const agentsMd = await readAgentFile(join(rootDir, "AGENTS.md"));
    const hasClaudeMd = claudeMd !== null;
    const hasAgentsMd = agentsMd !== null;
    const agentContextSetPresent =
      hasClaudeMd &&
      hasAgentsMd &&
      existing.some((p) => p.startsWith("docs/"));

    const hooks = await isDir(join(rootDir, ".husky"));
    const configJson = await isFile(
      join(rootDir, ".agent-review", "config.json"),
    );
    const prWorkflow = await isFile(
      join(rootDir, ".github", "workflows", "dark-factory-pr.yml"),
    );

    let cliPin: string | null = null;
    try {
      const pkgRaw = await readFile(join(rootDir, "package.json"), "utf8");
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      cliPin =
        pkg?.dependencies?.["@momentiq/dark-factory-cli"] ??
        pkg?.devDependencies?.["@momentiq/dark-factory-cli"] ??
        null;
    } catch {
      cliPin = null;
    }

    return {
      docs: {
        existing: existing.slice(0, MAX_DOCS),
        hasClaudeMd,
        hasAgentsMd,
        agentContextSetPresent,
        claudeMd,
        agentsMd,
      },
      dfPresence: { hooks, configJson, prWorkflow, cliPin },
    };
  },
};
