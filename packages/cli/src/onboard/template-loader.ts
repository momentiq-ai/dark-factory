// packages/cli/src/onboard/template-loader.ts
//
// Template loader for `df onboard`'s Stage B input.
// Resolves a templateRef (gh:<owner>/<repo>@<ref> | file://<abs>@<ref>) to a
// content-addressed cache directory, then walks the directory and returns
// the file set (subject to the Phase B filter rules: no .git/node_modules,
// ≤ 64 KB per file, no binary, ≤ 200 entries total).
//
// Cache key is the resolved sha — so `latest` and the sha it resolves to
// share one entry, no churn on re-runs.
//
// Ref parsing is delegated to template-ref.ts (Task 1's co-located foundation
// file) — this loader consumes parseTemplateRef + the parsed-ref types from
// there. Round-4 restructure-completion: keeping the parser in the foundation
// file means schema (Task 1) and loader (Task 3) cannot drift on the semantic
// check, AND no circular import is possible (template-ref.ts imports nothing
// from schema or loader, so the loader can import ScaffoldPlanSchema in the
// future if it ever needs to).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, rename, rm, stat, cp } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import {
  parseTemplateRef,
  type ParsedTemplateRef,
  type GhTemplateRef,
  type FileTemplateRef,
} from "./template-ref.js";

export { parseTemplateRef };
export type { ParsedTemplateRef, GhTemplateRef, FileTemplateRef };

const ex = promisify(execFile);

// Cap chosen for headroom above the current sage-blueprint walk (701
// post-filter files at 2.9 MB total content, measured 2026-06-06). The
// 200-cap from Phase B / B-D4 was set when the template was much smaller
// and started blocking the sage3c-reproduction harness (cycle 15 metric 1)
// after Cycle 12.3 handoff wiring + BP-N additions landed — see issue #140.
// We raise instead of filtering because the file inventory is intentional
// template content (154 .jinja Copier files, 217 .py backend, 78 .ts +
// 77 .tsx frontend, 55 yaml + 35 md): no extension-whitelist or SKIP_DIRS
// expansion brings the count below 200 without dropping legitimate
// structural files the LLM needs. The 64 KB per-file ceiling + binary
// skip remain the real backstops; this cap is the count tripwire.
export const MAX_TEMPLATE_FILES = 1000;
export const MAX_TEMPLATE_FILE_SIZE = 65_536;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build"]);

export interface TemplateFile {
  path: string;
  content: string;
}

export interface Template {
  canonicalRef: string;
  resolvedSha: string;
  cacheDir: string;
  files: TemplateFile[];
}

export interface LoadOptions {
  cacheRoot?: string;
}

const FORTY_HEX = /^[0-9a-f]{40}$/i;

async function resolveSha(parsed: ParsedTemplateRef): Promise<string> {
  if (parsed.kind === "file") {
    return parsed.ref;
  }
  if (FORTY_HEX.test(parsed.ref)) {
    return parsed.ref.toLowerCase();
  }
  const url = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
  const refArg =
    parsed.ref === "latest" ? "HEAD" :
    parsed.ref.startsWith("refs/") ? parsed.ref :
    parsed.ref;
  const { stdout } = await ex("git", ["ls-remote", url, refArg]);
  const sha = stdout.split(/\s/)[0];
  if (!sha || !FORTY_HEX.test(sha)) {
    throw new Error(
      `df onboard: could not resolve ref "${parsed.ref}" against ${url}. ` +
        "Verify the ref exists and the repo is publicly readable.",
    );
  }
  return sha.toLowerCase();
}

function cacheDirFor(parsed: ParsedTemplateRef, sha: string, cacheRoot: string): string {
  if (parsed.kind === "gh") {
    return join(cacheRoot, `${parsed.owner}__${parsed.repo}__${sha}`);
  }
  const tag = parsed.path.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(cacheRoot, `file__${tag}__${sha}`);
}

async function populateCache(parsed: ParsedTemplateRef, sha: string, cacheDir: string): Promise<void> {
  const tmp = `${cacheDir}.tmp-${process.pid}-${Date.now()}`;
  await rm(tmp, { recursive: true, force: true });
  if (parsed.kind === "file") {
    await cp(parsed.path, tmp, { recursive: true });
  } else {
    const url = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
    await mkdir(tmp, { recursive: true });
    await ex("git", ["init", "-q"], { cwd: tmp });
    await ex("git", ["fetch", "--depth", "1", "-q", url, sha], { cwd: tmp });
    await ex("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: tmp });
    await rm(join(tmp, ".git"), { recursive: true, force: true });
  }
  try {
    await rename(tmp, cacheDir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    try { await stat(cacheDir); } catch { throw err; }
  }
}

async function isBinary(filepath: string): Promise<boolean> {
  const head = Buffer.alloc(8192);
  const fh = await import("node:fs/promises").then((m) => m.open(filepath, "r"));
  try {
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    for (let i = 0; i < bytesRead; i++) if (head[i] === 0) return true;
    return false;
  } finally {
    await fh.close();
  }
}

async function walkTemplate(rootDir: string): Promise<TemplateFile[]> {
  const out: TemplateFile[] = [];
  async function recur(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await recur(abs);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await stat(abs);
      if (st.size > MAX_TEMPLATE_FILE_SIZE) continue;
      if (await isBinary(abs)) continue;
      const rel = relative(rootDir, abs);
      out.push({ path: rel, content: await readFile(abs, "utf8") });
      if (out.length > MAX_TEMPLATE_FILES) {
        throw new Error(
          `df onboard: template file count exceeds ${MAX_TEMPLATE_FILES}. ` +
            "Reduce the template surface or raise MAX_TEMPLATE_FILES " +
            "(see #140 for the rationale behind the current ceiling).",
        );
      }
    }
  }
  await recur(rootDir);
  return out;
}

export async function loadTemplate(canonicalRef: string, opts: LoadOptions = {}): Promise<Template> {
  const parsed = parseTemplateRef(canonicalRef);
  const cacheRoot = opts.cacheRoot ?? join(homedir(), ".df", "cache", "templates");
  await mkdir(cacheRoot, { recursive: true });
  const sha = await resolveSha(parsed);
  const cacheDir = cacheDirFor(parsed, sha, cacheRoot);
  try {
    await stat(cacheDir);
  } catch {
    await populateCache(parsed, sha, cacheDir);
  }
  const files = await walkTemplate(cacheDir);
  return { canonicalRef, resolvedSha: sha, cacheDir, files };
}
