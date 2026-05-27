// ADR parser — cycle5 Phase 1 step 3c.
//
// Reads ADRs from `docs/ADR/*.md`. ADR format is different from cycle
// docs: instead of YAML frontmatter, ADRs put metadata as markdown
// bullets following the h1 title:
//
//     # ADR <prefix> — <Title>
//
//     - **Status:** Accepted | Proposed | Superseded | Deprecated
//     - **Date:** YYYY-MM-DD
//     - **Deciders:** ...
//     - **Scope:** ...
//     - **Supersedes:** ... (optional)
//     - **Supersedes (in part):** ... (optional)
//
//     ## Context
//     ...
//
// The `id` is the filename basename (without `.md`) — that's the only
// always-unique identifier across ADRs that share a date prefix.
//
// Why a separate module vs reusing cycle-doc/parser.ts: the input
// shapes have no overlap. Cycle docs use YAML frontmatter + h2 section
// split; ADRs use bullet metadata + free-form body. Trying to share a
// parser between them would force a brittle if-then branch; better to
// keep two small focused parsers.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ADR_RELATIVE_PATH = "docs/ADR";
// ADR filenames: typically `YYYY-MM-...-slug.md`. We don't enforce
// the date prefix — any `*.md` in docs/ADR/ is treated as an ADR;
// the basename becomes the id. (A future cycle can tighten this if
// non-ADR markdown ends up in docs/ADR/ by accident.)
const ADR_FILE_PATTERN = /^(.+)\.md$/;

// Bullet metadata pattern. Matches lines like:
//   - **Status:** Accepted
//   - **Supersedes (in part):** ADR 2026-04
// Captures: (1) the key (without bold + colon), (2) the value.
const BULLET_PATTERN = /^- \*\*([^*]+?):\*\*\s*(.*)$/;

// H1 with optional "ADR <prefix> — Title" structure. Captures the
// title portion (after the em-dash, or the whole h1 if no em-dash).
const H1_PATTERN = /^#\s+(?:ADR\s+\S+\s+[—\-–]\s+)?(.+?)\s*$/;

export interface AdrSummary {
  /** Filename basename (e.g. "2026-05-w1-w3-gate-migration"). */
  readonly id: string;
  /** Title from the h1 (with "ADR <prefix> — " stripped when present). */
  readonly title: string;
  /** Status from the metadata bullets, e.g. "Accepted". */
  readonly status: string;
  /** Date from the metadata bullets, e.g. "2026-05-26". */
  readonly date: string;
}

export interface ParsedAdrDoc {
  readonly id: string;
  /** All bullet-metadata key/value pairs (raw markdown values). */
  readonly frontmatter: Record<string, string>;
  /** Body markdown after the bullet metadata block (h2 + onward). */
  readonly body: string;
  /** Convenience: pulled from frontmatter.Status. */
  readonly status: string;
  /**
   * Convenience: pulled from frontmatter.Supersedes (or
   * "Supersedes (in part)") when present. Omitted when neither bullet
   * is present in the ADR.
   */
  readonly supersedes?: string;
}

interface SplitAdr {
  readonly h1Title: string | null;
  readonly metadata: Record<string, string>;
  readonly body: string;
}

function splitAdr(source: string): SplitAdr {
  const lines = source.split(/\r?\n/);
  let h1Title: string | null = null;
  const metadata: Record<string, string> = {};
  let i = 0;

  // 1. Skip any blank lines before the h1.
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  // 2. Capture the h1 if present.
  const h1Match = i < lines.length ? H1_PATTERN.exec(lines[i] ?? "") : null;
  if (h1Match) {
    h1Title = h1Match[1] ?? null;
    i++;
  }
  // 3. Skip blank lines between h1 and the bullet metadata.
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  // 4. Greedily consume bullet metadata lines. A blank line or any
  //    non-bullet line ends the metadata block.
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      // Blank-line separator after the metadata block — break here.
      // Subsequent content is body markdown.
      break;
    }
    const match = BULLET_PATTERN.exec(line);
    if (!match) {
      // Non-bullet, non-blank line after the start of metadata: the
      // metadata block ends here. Don't consume; let body capture it.
      break;
    }
    const key = match[1]?.trim() ?? "";
    const value = match[2]?.trim() ?? "";
    if (key) metadata[key] = value;
    i++;
  }
  const body = lines.slice(i).join("\n").trim();
  return { h1Title, metadata, body };
}

function listAdrFiles(repoRoot: string): string[] {
  const dir = resolve(repoRoot, ADR_RELATIVE_PATH);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && ADR_FILE_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort();
}

function fileToAdrId(filename: string): string | null {
  const match = ADR_FILE_PATTERN.exec(filename);
  return match?.[1] ?? null;
}

export async function listAdrDocs(repoRoot: string): Promise<AdrSummary[]> {
  const out: AdrSummary[] = [];
  for (const filename of listAdrFiles(repoRoot)) {
    const id = fileToAdrId(filename);
    if (!id) continue;
    const source = readFileSync(
      resolve(repoRoot, ADR_RELATIVE_PATH, filename),
      "utf8",
    );
    const { h1Title, metadata } = splitAdr(source);
    if (!h1Title) {
      // Defensive: no h1 → not a well-formed ADR; skip it. Avoids
      // surfacing partial drafts in `df_adr_list` output.
      continue;
    }
    out.push({
      id,
      title: h1Title,
      status: metadata.Status ?? "unknown",
      date: metadata.Date ?? "",
    });
  }
  return out;
}

function extractSupersedes(
  metadata: Record<string, string>,
): string | undefined {
  // Prefer the qualified bullet ("Supersedes (in part)") when both are
  // present — it's the more precise statement.
  return metadata["Supersedes (in part)"] ?? metadata.Supersedes;
}

export async function readAdrDoc(
  repoRoot: string,
  adrId: string,
): Promise<ParsedAdrDoc | null> {
  for (const filename of listAdrFiles(repoRoot)) {
    if (fileToAdrId(filename) !== adrId) continue;
    const fullPath = resolve(repoRoot, ADR_RELATIVE_PATH, filename);
    const source = readFileSync(fullPath, "utf8");
    const { metadata, body } = splitAdr(source);
    const supersedes = extractSupersedes(metadata);
    const status = metadata.Status ?? "unknown";
    return {
      id: adrId,
      frontmatter: metadata,
      body,
      status,
      ...(supersedes !== undefined ? { supersedes } : {}),
    };
  }
  return null;
}

export function adrDir(repoRoot: string): string {
  return join(repoRoot, ADR_RELATIVE_PATH);
}

export const __test = { splitAdr };
