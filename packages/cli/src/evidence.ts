// Commit-trailer parsing and per-SHA evidence file path helpers.
// Trailers (per git-interpret-trailers semantics) carry human-supplied
// overrides into the gate: a developer who deliberately ships a
// production-only change can attach `Tdd-Justification: <reason>` and the
// TDD classifier returns `justified` instead of `block`. The keys are
// case-insensitive; whitespace around values is trimmed.

import { resolve } from "node:path";

export interface CommitTrailers {
  // Lowercased key → first non-empty value seen. Per
  // git-interpret-trailers, repeated trailers concatenate by default, but
  // for our use case (override reasons) the first occurrence is the
  // canonical one. Repeated trailers with the same key still parse
  // successfully — only the first value is kept.
  readonly trailers: Record<string, string>;
  // Whether the message ended with a recognized trailer block. Useful for
  // diagnostics: a message with `Tdd-Justification` buried in the body
  // (not at the end) does NOT count as a trailer.
  readonly hasTrailerBlock: boolean;
}

const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9._-]*)\s*:\s*(.*)$/;

export function parseCommitTrailers(message: string): CommitTrailers {
  const trailers: Record<string, string> = {};
  if (!message) return { trailers, hasTrailerBlock: false };

  // Normalize line endings and trim trailing whitespace so a message
  // ending with "\n\n" still surfaces its trailer block.
  const lines = message.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
    lines.pop();
  }
  if (lines.length === 0) return { trailers, hasTrailerBlock: false };

  // Walk backwards from the end, collecting consecutive lines that look
  // like trailers. The block ends at the first blank line OR the first
  // non-trailer line. This matches git-interpret-trailers' behavior: the
  // last paragraph is treated as a trailer block iff every line in it is
  // a trailer or a continuation (line starting with whitespace).
  const collected: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "") break;
    collected.unshift(line);
  }
  if (collected.length === 0) return { trailers, hasTrailerBlock: false };

  // Every non-continuation line in the candidate block must match the
  // trailer pattern; otherwise this is a regular paragraph and trailers
  // are NOT extracted. This guards against parsing free-prose paragraphs
  // (e.g., "Reviewed by Alice. Tested locally.") as trailers.
  let hasAnyTrailer = false;
  for (const line of collected) {
    if (line.startsWith(" ") || line.startsWith("\t")) continue;
    if (TRAILER_LINE.test(line)) {
      hasAnyTrailer = true;
      continue;
    }
    // First non-trailer, non-continuation line invalidates the block.
    return { trailers, hasTrailerBlock: false };
  }
  if (!hasAnyTrailer) return { trailers, hasTrailerBlock: false };

  for (const line of collected) {
    const match = line.match(TRAILER_LINE);
    if (!match) continue;
    const rawKey = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    const key = rawKey.toLowerCase();
    if (key in trailers) continue; // first occurrence wins
    if (value.length === 0) continue; // empty value is no override
    trailers[key] = value;
  }

  return { trailers, hasTrailerBlock: true };
}

// Return a recognized trailer value by case-insensitive key, or undefined.
// Callers should compare against the canonical lowercased key.
export function getTrailer(
  trailers: CommitTrailers,
  key: string,
): string | undefined {
  return trailers.trailers[key.toLowerCase()];
}

// Per-SHA evidence file path under <artifactRoot>/<artifactDir>/quality-gates/<sha>.json.
// Centralized so quality-gates.ts, gate.ts, and the runner all agree on the
// canonical layout. The legacy `validation.resultFile` ("latest.json") is
// maintained as a back-compat write target during the 318.2 → 318.4
// migration window, but consumers should prefer the per-SHA path.
export function perShaQualityGatePath(
  artifactRoot: string,
  artifactDir: string,
  sha: string,
): string {
  return resolve(artifactRoot, artifactDir, "quality-gates", `${sha}.json`);
}

export const QUALITY_GATES_SUBDIR = "quality-gates";

// Flatten `ChangedFile[]` (or anything shaped like `{path, oldPath?}`)
// into a path list that includes both the new `path` and (when present)
// the rename/copy `oldPath`. Used by every gate-time path consumer so a
// route-classified or TDD-classified file matches on EITHER side of a
// rename. Centralized here (no git/runner/cli dependencies) so the
// three former inline loops in runner.ts / gate.ts / cli.ts cannot
// drift. (Codex P2 follow-up on d46b8be7.)
export function collectChangedPaths(
  files: ReadonlyArray<{ path: string; oldPath?: string }>,
): string[] {
  const out: string[] = [];
  for (const f of files) {
    out.push(f.path);
    if (f.oldPath && f.oldPath !== f.path) out.push(f.oldPath);
  }
  return out;
}
