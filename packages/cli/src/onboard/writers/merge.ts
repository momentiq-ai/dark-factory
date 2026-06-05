// packages/cli/src/onboard/writers/merge.ts
//
// CLAUDE.md / AGENTS.md additive-append merge. THE Cycle 15 risk surface.
//
// Contract:
//   - First run: append `\n<BEGIN>\n<tailored_content>\n<END>\n` after the
//     existing file. NEVER touches the existing bytes.
//   - Re-run: if BEGIN/END pair is found, REPLACE the content between them
//     with the new tailored_content; preserve everything else byte-for-byte.
//   - Parse failure (binary, > 128 KB, unbalanced fences): SKIP — leave the
//     file untouched, emit a stderr warning. Non-fatal.
//
// The file is treated as bytes-on-disk; the heading parse is only used as a
// sanity gate (Phase B never NEEDS the heading list for the merge — that's a
// Phase A docs-analyzer concern).

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { MergeFilePlan } from "../scaffold-schema.js";

export const BEGIN_MARKER = "<!-- df onboard: inserted-by-cycle-15 BEGIN -->";
export const END_MARKER = "<!-- df onboard: inserted-by-cycle-15 END -->";
const MAX_TARGET_SIZE = 128 * 1024;

export interface MergeOptions {
  stderr?: (s: string) => void;
}

export interface MergeResult {
  path: string;
  action: "merge";
  wrote: boolean;
  skipped: boolean;
  reason?: string;
  fellBackToEmit?: boolean;
}

function safeResolve(root: string, p: string): string {
  if (isAbsolute(p)) {
    throw new Error(`df onboard: refuses to merge to absolute path "${p}" (outside the target root).`);
  }
  const resolved = resolve(root, p);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`df onboard: path traversal blocked — "${p}" resolves outside the target root.`);
  }
  return resolved;
}

function isBinaryBuffer(buf: Buffer): boolean {
  const cap = Math.min(buf.length, 8192);
  for (let i = 0; i < cap; i++) if (buf[i] === 0) return true;
  return false;
}

// Best-effort fence balance check. Counts unescaped triple-backtick runs; an
// odd count means an unpaired fence (or a fence inside another fence — both
// are conditions where the heading regex can't safely traverse the file).
function fencesBalanced(text: string): boolean {
  // Lines starting with ``` (possibly preceded by spaces) toggle fence state.
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
  }
  return !inFence;
}

// Heading detector — same `^#{1,6}\s+(.+)$` regex Phase A's docs analyzer
// (`docs.ts`) uses, with the same fenced-code-block tracking so a `# inside
// code` line in a code block doesn't count. The merge handler skips files
// with zero detected headings: appending after a heading-less prose blob
// (or YAML, or boilerplate) would yield a structurally surprising file the
// operator probably didn't intend to mark up. Per B-D6.
const HEADING_RE = /^#{1,6}\s+(.+)$/;

function detectHeadings(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(HEADING_RE);
    if (m) out.push(m[1]!);
  }
  return out;
}

function findMarkerBlock(text: string): { start: number; end: number } | null {
  const start = text.indexOf(BEGIN_MARKER);
  if (start < 0) return null;
  const endRel = text.indexOf(END_MARKER, start + BEGIN_MARKER.length);
  if (endRel < 0) return null;
  const end = endRel + END_MARKER.length;
  return { start, end };
}

function replaceMarkerBlock(text: string, content: string, block: { start: number; end: number }): string {
  const before = text.slice(0, block.start);
  const after = text.slice(block.end);
  return `${before}${BEGIN_MARKER}\n${content}${content.endsWith("\n") ? "" : "\n"}${END_MARKER}${after}`;
}

function appendMarkerBlock(text: string, content: string): string {
  // Normalize so the file ends with exactly one newline, then add a blank line,
  // the BEGIN marker, content, END marker, and a trailing newline.
  let base = text;
  if (!base.endsWith("\n")) base += "\n";
  const block = `\n${BEGIN_MARKER}\n${content}${content.endsWith("\n") ? "" : "\n"}${END_MARKER}\n`;
  return base + block;
}

export async function writeMerge(
  rootDir: string,
  plan: MergeFilePlan,
  opts: MergeOptions = {},
): Promise<MergeResult> {
  const abs = safeResolve(rootDir, plan.path);
  // Fall-back to emit semantics if target absent.
  let existing: Buffer;
  try {
    existing = await readFile(abs);
  } catch {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, plan.tailored_content, "utf8");
    return {
      path: plan.path, action: "merge", wrote: true, skipped: false, fellBackToEmit: true,
    };
  }

  // Parse-error gates.
  if (existing.length > MAX_TARGET_SIZE) {
    const reason = `target size ${existing.length} bytes exceeds 128 KB cap`;
    opts.stderr?.(`df onboard: merge skipped for ${plan.path} — ${reason}; file left untouched.\n`);
    return { path: plan.path, action: "merge", wrote: false, skipped: true, reason };
  }
  if (isBinaryBuffer(existing)) {
    const reason = "target is binary";
    opts.stderr?.(`df onboard: merge skipped for ${plan.path} — ${reason}; file left untouched.\n`);
    return { path: plan.path, action: "merge", wrote: false, skipped: true, reason };
  }
  const text = existing.toString("utf8");
  if (!fencesBalanced(text)) {
    const reason = "could not parse headings — unbalanced fenced code blocks";
    opts.stderr?.(`df onboard: merge skipped for ${plan.path} — ${reason}; file left untouched.\n`);
    return { path: plan.path, action: "merge", wrote: false, skipped: true, reason };
  }
  if (detectHeadings(text).length === 0) {
    const reason = "could not parse headings — no headings detected";
    opts.stderr?.(`df onboard: merge skipped for ${plan.path} — ${reason}; file left untouched.\n`);
    return { path: plan.path, action: "merge", wrote: false, skipped: true, reason };
  }

  // Re-run case: replace the existing marker block; preserve all bytes outside.
  const block = findMarkerBlock(text);
  const next = block
    ? replaceMarkerBlock(text, plan.tailored_content, block)
    : appendMarkerBlock(text, plan.tailored_content);

  await writeFile(abs, next, "utf8");
  return { path: plan.path, action: "merge", wrote: true, skipped: false };
}
