// Cycle doc parser — cycle5 Phase 1 step 3a.
//
// Reads cycle docs from the repo's cycle-doc directory and returns:
//   - listCycleDocs(repoRoot) → summary per file (id, title, status, ...)
//   - readCycleDoc(repoRoot, id) → full structured representation
//     (id, frontmatter, sections)
//
// The cycle-doc directory is resolved in this precedence:
//   1. `darkfactory.yaml#docs.cycleDocsDir` (consumer override)
//   2. `docs/roadmap/cycles/` when it exists (sage-blueprint / default convention)
//   3. `docs/cycles/` when it exists (hand-built repos, e.g. dark-factory-dashboard)
//   4. `docs/roadmap/cycles/` as the final fallback (so missing-dir errors point
//      at the canonical default).
//
// Note on overlap with `src/cycle-doc-validator/`: that module is the
// Python-backed PR-trailer CI gate (different concern). Its
// `read_cycle_frontmatter` helper exists but is Python-only and bound
// to validation flow. This module is the TypeScript-side parser the
// MCP server needs; the cycle5 spec calls out that a TS parser will
// be added here and reused by Phase 2's remote MCP gateway.

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { loadDarkFactoryConfig } from "../../skills/config.js";

const DEFAULT_CYCLES_RELATIVE_PATH = "docs/roadmap/cycles";
const ALT_CYCLES_RELATIVE_PATH = "docs/cycles";
// Matches: `cycle1-foo.md`, `cycle331.6-slug.md`, `cycle10-something.md`
// Captures the id portion (e.g., `cycle1`, `cycle331.6`).
const CYCLE_FILE_PATTERN = /^(cycle\d+(?:\.\d+)?)(?:-.+)?\.md$/;

const FRONTMATTER_DELIMITER = "---";

/**
 * Resolve the relative cycle-docs directory for a repo.
 *
 * Precedence:
 *   1. `darkfactory.yaml#docs.cycleDocsDir` when the file parses cleanly and
 *      the configured path stays inside `repoRoot` (lexically and via realpath,
 *      so symlinks to outside the repo are rejected).
 *   2. `docs/roadmap/cycles` when it exists.
 *   3. `docs/cycles` when it exists.
 *   4. `docs/roadmap/cycles` as the canonical fallback.
 *
 * A malformed `darkfactory.yaml` is intentionally non-fatal here: the cycle-doc
 * parser is a low-level utility used by MCP resources and `df objectives`, and
 * a YAML/schema typo in consumer config should not obscure cycle-doc reads.
 * Callers that need strict config validation already validate via other paths.
 *
 * Security: the configured `docs.cycleDocsDir` is resolved and validated to be
 * within `repoRoot`. Paths that escape the repo (absolute outside paths, `..`
 * segments, or symlinks pointing outside) are ignored, falling back to
 * convention-based auto-detection.
 */
export function resolveCyclesDir(repoRoot: string): string {
  try {
    const config = loadDarkFactoryConfig(repoRoot);
    const configured = config.config.docs?.cycleDocsDir;
    if (configured) {
      const resolved = resolve(repoRoot, configured);
      if (isInsideRepo(resolved, repoRoot)) {
        // Also follow symlinks: an in-repo path that is a symlink to an outside
        // directory must not be honored.
        if (existsSync(resolved)) {
          try {
            const realResolved = realpathSync(resolved);
            const realRepoRoot = realpathSync(repoRoot);
            if (isInsideRepo(realResolved, realRepoRoot)) {
              return relative(repoRoot, resolved) || ".";
            }
          } catch {
            // realpath failed (e.g. broken symlink) — fall through to fallback.
          }
        } else {
          // Non-existent configured dir: lexical containment is enough because
          // there is no symlink target to read yet.
          return relative(repoRoot, resolved) || ".";
        }
      }
      // Configured path escapes repoRoot — fall through to auto-detection.
    }
  } catch {
    // Fall through to convention-based auto-detection.
  }

  if (existsSync(resolve(repoRoot, DEFAULT_CYCLES_RELATIVE_PATH))) {
    return DEFAULT_CYCLES_RELATIVE_PATH;
  }
  if (existsSync(resolve(repoRoot, ALT_CYCLES_RELATIVE_PATH))) {
    return ALT_CYCLES_RELATIVE_PATH;
  }
  return DEFAULT_CYCLES_RELATIVE_PATH;
}

/**
 * Return true when `candidate` is the same as, or a descendant of, `repoRoot`.
 * Both arguments are expected to be absolute paths. The check is lexical (does
 * not follow symlinks) — callers that need symlink containment must also
 * compare `realpathSync` results.
 */
function isInsideRepo(candidate: string, repoRoot: string): boolean {
  const rel = relative(repoRoot, candidate);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export interface CycleSummary {
  /** Stable id derived from filename, e.g. "cycle5" or "cycle331.6". */
  readonly id: string;
  /** Title from frontmatter — required field in a well-formed cycle doc. */
  readonly title: string;
  /** Status from frontmatter — typically "draft" | "active" | "done" | "abandoned". */
  readonly status: string;
  /** Owner from frontmatter, when present. */
  readonly owner?: string;
  /** Target date from frontmatter, when present. */
  readonly target?: string;
}

export interface ParsedCycleDoc {
  /** Stable id derived from filename. */
  readonly id: string;
  /** Raw parsed YAML frontmatter — caller can pluck any field. */
  readonly frontmatter: Record<string, unknown>;
  /**
   * Map of h2 section name (snake_case'd) → section body markdown.
   * Section body is the markdown between this h2 and the next h2 (or
   * EOF). Nested headings (###, ####, …) stay inline.
   */
  readonly sections: Record<string, string>;
}

interface SplitDoc {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

function splitFrontmatter(source: string): SplitDoc {
  // Cycle docs start with `---\n...\n---\n` frontmatter. If absent
  // (template / partial doc), return `{}` frontmatter + full source as
  // body so callers degrade gracefully.
  if (!source.startsWith(FRONTMATTER_DELIMITER)) {
    return { frontmatter: {}, body: source };
  }
  // Find the closing delimiter. We scan line-by-line so YAML strings
  // containing `---` literals don't false-match.
  const lines = source.split(/\r?\n/);
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FRONTMATTER_DELIMITER) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    // Open delimiter without close — treat as no frontmatter.
    return { frontmatter: {}, body: source };
  }
  const yamlBody = lines.slice(1, closeIdx).join("\n");
  const restBody = lines.slice(closeIdx + 1).join("\n");
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBody);
  } catch {
    return { frontmatter: {}, body: restBody };
  }
  const frontmatter =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { frontmatter, body: restBody };
}

function snakeCaseSectionName(raw: string): string {
  // "Open Questions" → "open_questions"; "Exit criteria" → "exit_criteria";
  // "exit-criteria" → "exit_criteria". Anything non-alphanumeric is
  // collapsed to `_`. Leading/trailing `_` trimmed.
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function splitSections(body: string): Record<string, string> {
  // An h2 header is a line starting with `##` followed by a space and
  // some text. Nested headings (###+) stay inside their parent section.
  const lines = body.split(/\r?\n/);
  const sections: Record<string, string> = {};
  let currentName: string | null = null;
  let currentLines: string[] = [];
  const flush = (): void => {
    if (currentName !== null) {
      sections[currentName] = currentLines.join("\n").trim();
    }
  };
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    // Only h2 (exactly two #'s) — don't match h3 or deeper. The negative
    // lookahead is encoded by checking the third char is not `#`.
    if (match && !line.startsWith("###")) {
      flush();
      const titleRaw = match[1] ?? "";
      currentName = snakeCaseSectionName(titleRaw);
      currentLines = [];
      continue;
    }
    if (currentName !== null) {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
}

function listCycleFiles(repoRoot: string, cyclesDir?: string): string[] {
  const dir = resolve(repoRoot, cyclesDir ?? resolveCyclesDir(repoRoot));
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && CYCLE_FILE_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort();
}

function fileToCycleId(filename: string): string | null {
  const match = CYCLE_FILE_PATTERN.exec(filename);
  return match?.[1] ?? null;
}

export async function listCycleDocs(repoRoot: string): Promise<CycleSummary[]> {
  const cyclesDir = resolveCyclesDir(repoRoot);
  const out: CycleSummary[] = [];
  for (const filename of listCycleFiles(repoRoot, cyclesDir)) {
    const id = fileToCycleId(filename);
    if (!id) continue;
    const fullPath = resolve(repoRoot, cyclesDir, filename);
    const source = readFileSync(fullPath, "utf8");
    const { frontmatter } = splitFrontmatter(source);
    const summary: CycleSummary = {
      id,
      title: stringOr(frontmatter.title, `[no title — ${id}]`),
      status: stringOr(frontmatter.status, "unknown"),
      ...(typeof frontmatter.owner === "string"
        ? { owner: frontmatter.owner }
        : {}),
      ...(typeof frontmatter.target === "string"
        ? { target: frontmatter.target }
        : {}),
    };
    out.push(summary);
  }
  return out;
}

export async function readCycleDoc(
  repoRoot: string,
  cycleId: string,
): Promise<ParsedCycleDoc | null> {
  const cyclesDir = resolveCyclesDir(repoRoot);
  for (const filename of listCycleFiles(repoRoot, cyclesDir)) {
    if (fileToCycleId(filename) !== cycleId) continue;
    const fullPath = resolve(repoRoot, cyclesDir, filename);
    const source = readFileSync(fullPath, "utf8");
    const { frontmatter, body } = splitFrontmatter(source);
    const sections = splitSections(body);
    return { id: cycleId, frontmatter, sections };
  }
  return null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

// Re-export internal helpers under a `__test` namespace for unit
// tests that want to pin parser primitives directly without going
// through the filesystem layer.
export const __test = {
  splitFrontmatter,
  splitSections,
  snakeCaseSectionName,
  fileToCycleId,
};

// Hint for callers building the cycle-doc cwd; identical to the
// constant the python validator uses (CONFIG-shaped duplication is
// fine — the path is a public convention, not an implementation
// detail.).
export const CYCLE_DOCS_RELATIVE_PATH = DEFAULT_CYCLES_RELATIVE_PATH;

// Path helper for test fixtures + production code.
export function cycleDocsDir(repoRoot: string): string {
  return join(repoRoot, resolveCyclesDir(repoRoot));
}
