import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { LoadedConfig } from "../policy/config.js";
import {
  changedFiles,
  commitDiff,
  commitMetadata,
  commitParent,
  commitStat,
  currentBranch,
  diffHash as diffHashFn,
  gitShowFile,
  resolveCommit,
} from "../git.js";
import { readQualityGateEvidence } from "../evidence/index.js";
import {
  compactDiff,
  effectiveMode,
  extractFromUnifiedDiff,
  identifyLockfileKind,
  renderContentStub,
  type CompactedContentInput,
  type LockfileKind,
} from "../compact/index.js";
import type {
  ChangedFile,
  GeneratedFilePolicy,
  GuidanceFile,
  ReviewPacket,
  ReviewPacketValidation,
} from "@momentiq/dark-factory-schemas";

export interface BuildPacketOptions {
  ref?: string;
  cwd?: string;
  // When set, read trusted-surface inputs (guidance files, prompt fragments)
  // from this git ref instead of the working tree. Set by `runReview` when
  // the policy-baseline guard detected that the commit being reviewed
  // touches the trusted policy surface (config + guidance + fragments).
  // Without this, the parent-policy reload would only freeze the config
  // file, not the actual contents the critic reads.
  trustedSurfaceRef?: string;
}

const DEFAULT_DIFF_BUDGET = 1_500_000;

export async function buildReviewPacket(
  loaded: LoadedConfig,
  options: BuildPacketOptions = {},
): Promise<ReviewPacket> {
  const { config, repoRoot } = loaded;
  const cwd = options.cwd ?? repoRoot;
  const ref = options.ref ?? "HEAD";

  const sha = await resolveCommit(ref, cwd);
  const parent = await safeParent(sha, cwd);
  const branch = await currentBranch(cwd);
  const metadata = await commitMetadata(sha, cwd);
  const range = parent ? `${parent}..${sha}` : sha;

  const stat = await commitStat(parent, sha, cwd);
  const fullDiff = await commitDiff(parent, sha, cwd);
  // ADR § 2.1 — diffHash hashes the PRE-TRUNCATION, PRE-COMPACTION
  // fullDiff so cache identity is stable across policy toggles AND
  // budget truncation. This is unchanged from today.
  const hash = diffHashFn(fullDiff);
  // packet.diff retains today's shape: byte-budgeted from fullDiff
  // (back-compat surface for downstream consumers).
  const diff =
    fullDiff.length > DEFAULT_DIFF_BUDGET
      ? `${fullDiff.slice(0, DEFAULT_DIFF_BUDGET)}\n... [diff truncated at ${DEFAULT_DIFF_BUDGET} bytes]\n`
      : fullDiff;
  const diffTruncated = fullDiff.length > DEFAULT_DIFF_BUDGET;

  const files = await changedFiles(parent, sha, cwd, {
    maxBytes: config.context.maxChangedFileBytes,
    readContent: config.context.includeFullChangedFiles,
  });

  // ADR § 2.1.1 — bounded lockfile strategy. Operates on the
  // UNTRUNCATED fullDiff so source-file hunks that previously
  // overflowed the per-packet budget now fit after lockfile
  // sections collapse to stubs. The result is byte-capped at
  // MAX_COMPACTED_DIFF_BYTES (an EARLIER cap than DEFAULT_DIFF_BUDGET
  // — see ADR § 2.4.1).
  let compactedDiff: string | undefined;
  let parseErrorPaths: string[] | undefined;
  const policy = config.context.generatedFilePolicy;
  if (policy !== undefined) {
    // Compute effective mode for each changed file path; if any has
    // non-"full" effective mode, run compaction.
    const anyNonFull = files.some(
      (f) => effectiveMode(f.path, policy) !== "full",
    );
    if (anyNonFull) {
      const result = compactDiff(fullDiff, policy);
      compactedDiff = result.compactedDiff;
      const onParseError = policy.onParseError ?? "refuse-and-block";
      if (result.parseErrorPaths.length > 0 && onParseError === "refuse-and-block") {
        parseErrorPaths = result.parseErrorPaths;
      }
      // Update each matched file's compactedContent + clear content.
      await applyContentCompaction(files, policy, sha, cwd);
    }
  }

  const guidanceFiles = options.trustedSurfaceRef !== undefined
    ? await readGuidanceFilesFromRef(options.trustedSurfaceRef, config.context.guidanceFiles, cwd)
    : readGuidanceFiles(repoRoot, config.context.guidanceFiles);
  const promptFragments = options.trustedSurfaceRef !== undefined
    ? await readGuidanceFilesFromRef(options.trustedSurfaceRef, config.context.promptFragments, cwd)
    : readGuidanceFiles(repoRoot, config.context.promptFragments);
  const validation = await readValidationEvidence(loaded, sha);

  return {
    repoRoot,
    branch,
    commit: metadata,
    range,
    diffHash: hash,
    stat,
    diff,
    diffTruncated,
    changedFiles: files,
    guidanceFiles,
    promptFragments,
    validation,
    ...(compactedDiff !== undefined ? { compactedDiff } : {}),
    ...(parseErrorPaths !== undefined ? { parseErrorPaths } : {}),
  };
}

// ADR § 2.1 / § 2.4 — for each path whose effective mode is
// !== "full", set compactedContent + CLEAR content so the prompt
// renders only the compacted form. Mutates `files` in place (caller
// receives the mutated array).
async function applyContentCompaction(
  files: ChangedFile[],
  policy: GeneratedFilePolicy,
  sha: string,
  cwd: string,
): Promise<void> {
  for (const file of files) {
    const mode = effectiveMode(file.path, policy);
    if (mode === "full") continue;
    const kind = identifyLockfileKind(file.path);
    if (kind === undefined) {
      // Unknown lockfile kind but explicitly globbed; emit a stub
      // marking the path as omitted by policy. Don't read content.
      file.compactedContent = `[DF-COMPACT v1 unknown-format full-content omitted]\nfiles:\n  - path: ${file.path}`;
      file.content = "";
      continue;
    }
    if (file.content === undefined) {
      // includeFullChangedFiles must have been false. Synthesize a
      // minimal stub from path + status alone.
      file.compactedContent = `[DF-COMPACT v1 ${kind} full-content not-read]\nfiles:\n  - path: ${file.path}`;
      continue;
    }
    if (mode === "omit") {
      file.compactedContent = `[DF-COMPACT v1 ${kind} omitted-by-policy]\nfiles:\n  - path: ${file.path}\n  - bytes: ${Buffer.byteLength(file.content, "utf8")}`;
      file.content = "";
      continue;
    }
    // mode === "compact"
    const packagesAfter = extractPackagesAfter(kind, file.content);
    const contentSha = createHash("sha256").update(file.content).digest("hex");
    const stub = renderContentStub({
      path: file.path,
      lockfileKind: kind,
      bytesBefore: Buffer.byteLength(file.content, "utf8"),
      contentSha256: contentSha,
      packagesAfter,
    });
    file.compactedContent = stub;
    file.content = "";
  }
}

// Lightweight post-commit-state extractor for the content stub.
// Walks the same field surfaces as the per-format diff extractors;
// errors fall back to an empty array (the stub still emits with
// notes:lockfile-metadata-only equivalent).
function extractPackagesAfter(
  kind: LockfileKind,
  content: string,
): { name: string; version: string; integrity?: string }[] {
  const out: { name: string; version: string; integrity?: string }[] = [];
  if (kind === "npm") {
    const lines = content.split("\n");
    const markerRe = /^\s*"node_modules\/(@?[^"]+)":\s*\{/;
    const versionRe = /^\s*"version":\s*"([^"]+)"/;
    const integrityRe = /^\s*"integrity":\s*"([^"]+)"/;
    let pendingName: string | null = null;
    let pendingVersion: string | undefined;
    let pendingIntegrity: string | undefined;
    function flush() {
      if (pendingName && pendingVersion) {
        out.push({
          name: pendingName,
          version: pendingVersion,
          ...(pendingIntegrity !== undefined ? { integrity: pendingIntegrity } : {}),
        });
      }
      pendingName = null;
      pendingVersion = undefined;
      pendingIntegrity = undefined;
    }
    for (const line of lines) {
      const m = markerRe.exec(line);
      if (m) {
        flush();
        let name = m[1] ?? "";
        if (name.includes("/node_modules/")) {
          const parts = name.split("/node_modules/");
          name = parts[parts.length - 1] ?? name;
        }
        pendingName = name;
        continue;
      }
      const vm = versionRe.exec(line);
      if (vm && pendingName) pendingVersion = vm[1];
      const im = integrityRe.exec(line);
      if (im && pendingName) pendingIntegrity = im[1];
    }
    flush();
    return out;
  }
  if (kind === "pnpm") {
    const lines = content.split("\n");
    const specRe = /^\s*\/(@?[^@/]+(?:\/[^@/]+)?)@([^:()]+)(?:\([^)]+\))?:/;
    const integrityRe = /^\s*integrity:\s*(\S+)/;
    let pending: { name: string; version: string; integrity?: string } | null = null;
    function flush() {
      if (pending) out.push(pending);
      pending = null;
    }
    for (const line of lines) {
      const m = specRe.exec(line);
      if (m) {
        flush();
        pending = { name: m[1] ?? "", version: m[2] ?? "" };
        continue;
      }
      if (pending) {
        const im = integrityRe.exec(line);
        if (im) pending.integrity = im[1] ?? "";
      }
    }
    flush();
    return out;
  }
  // yarn
  const lines = content.split("\n");
  const specRe = /^(@?[^@\s]+)@[^:]+:/;
  const versionRe = /^\s+version\s+"([^"]+)"/;
  const integrityRe = /^\s+integrity\s+(\S+)/;
  let pending: { name: string; version?: string; integrity?: string } | null = null;
  function flush() {
    if (pending && pending.version) {
      out.push({
        name: pending.name,
        version: pending.version,
        ...(pending.integrity !== undefined ? { integrity: pending.integrity } : {}),
      });
    }
    pending = null;
  }
  for (const line of lines) {
    const m = specRe.exec(line);
    if (m) {
      flush();
      pending = { name: m[1] ?? "" };
      continue;
    }
    if (pending) {
      const vm = versionRe.exec(line);
      if (vm) pending.version = vm[1] ?? "";
      const im = integrityRe.exec(line);
      if (im) pending.integrity = im[1] ?? "";
    }
  }
  flush();
  return out;
}

async function safeParent(sha: string, cwd: string): Promise<string> {
  try {
    return await commitParent(sha, cwd);
  } catch {
    return "";
  }
}

function readGuidanceFiles(repoRoot: string, paths: string[]): GuidanceFile[] {
  return readContainedFiles(repoRoot, paths);
}

// Shared by `context.ts` and `evals.ts` — both build packets that get sent to
// the Cursor critic prompt (an external API call). `loadAgentReviewConfig`
// reads `.agent-review/config.json` from HEAD, so untrusted commits can list
// `/etc/passwd`, `../../.ssh/id_rsa`, or a tracked symlink pointing outside
// the repo, and exfiltrate workstation files via the prompt. Every load path
// must go through this helper.
export function readContainedFiles(repoRoot: string, paths: string[]): GuidanceFile[] {
  const out: GuidanceFile[] = [];
  for (const rel of paths) {
    assertContainedPath(repoRoot, rel);
    const absolute = resolve(repoRoot, rel);
    if (!existsSync(absolute)) continue;
    // realpath resolves symlinks; if the real target escapes the repo, refuse.
    // Without this check, a tracked symlink `leak -> /Users/x/.ssh/id_rsa`
    // would pass the lexical guard above and still leak the target.
    const realAbsolute = realpathSync(absolute);
    const realInside = relative(repoRoot, realAbsolute);
    if (realInside.startsWith("..") || isAbsolute(realInside)) {
      throw new Error(
        `agent-review config path resolves (via symlink) outside repo root: ${rel} → ${realAbsolute}`,
      );
    }
    const content = readFileSync(realAbsolute, "utf8");
    out.push({ path: rel, content });
  }
  return out;
}

// Read guidance files from a specific git ref. Used when the policy
// baseline (`policy-baseline.ts`) detected self-modification of trusted
// policy surface — the parent's contents must apply, not the working tree's
// (which may have been tampered with). Missing files at the ref are treated
// the same as missing files in the working tree (skipped, not fatal).
//
// Path containment is still checked lexically — absolute paths and `..`
// traversal are rejected even when reading from a ref, since the path comes
// from the (parent's) config file. Symlink resolution does not apply
// because git tracks symlinks as their target string, not the resolved
// path; `git show ref:path` returns the file's literal blob contents.
async function readGuidanceFilesFromRef(
  ref: string,
  paths: string[],
  cwd: string,
): Promise<GuidanceFile[]> {
  const out: GuidanceFile[] = [];
  for (const rel of paths) {
    if (isAbsolute(rel)) {
      throw new Error(
        `agent-review config path must be repo-relative, got absolute: ${rel}`,
      );
    }
    if (rel.split("/").some((segment) => segment === "..")) {
      throw new Error(`agent-review config path escapes repo root: ${rel}`);
    }
    const content = await gitShowFile(ref, rel, cwd);
    if (content === null) continue;
    out.push({ path: rel, content });
  }
  return out;
}

// Lexical containment check: rejects absolute paths and `..` traversal.
// Pair with the realpath check in `readContainedFiles` to also catch
// symlinks that resolve outside the repo.
function assertContainedPath(repoRoot: string, rel: string): void {
  if (isAbsolute(rel)) {
    throw new Error(
      `agent-review config path must be repo-relative, got absolute: ${rel}`,
    );
  }
  const resolved = resolve(repoRoot, rel);
  const inside = relative(repoRoot, resolved);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(
      `agent-review config path escapes repo root: ${rel} → ${resolved}`,
    );
  }
}

async function readValidationEvidence(
  loaded: LoadedConfig,
  sha: string,
): Promise<ReviewPacketValidation> {
  const required = [...loaded.config.validation.requiredQualityGates];
  const optional = [...loaded.config.validation.optionalQualityGates];
  const result: ReviewPacketValidation = {
    requiredQualityGates: required,
    optionalQualityGates: optional,
    evidence: [],
    missing: [...required],
    stale: false,
  };

  // Delegate to `readQualityGateEvidence` which implements the per-SHA-first
  // read path with legacy `latest.json` fallback (cycle 318.2 canonical
  // layout). Prior to issue #1370, this function only read the legacy
  // `latest.json` directly — so any time that file pointed at a different
  // commit (multi-commit gate runs, `agent-review-test` test-pollution, etc.)
  // the packet would falsely report `qualityGateResults: []` and
  // `qualityGatesMissing: [<all required gates>]` even when valid per-SHA
  // evidence existed on disk.
  const read = await readQualityGateEvidence(loaded, sha);
  if (!read.evidence) return result;
  if (read.stale) {
    result.stale = true;
    return result;
  }

  result.evidence = read.evidence.results;
  result.missing = required.filter(
    (r) => !read.evidence!.results.some((e) => e.command === r),
  );
  return result;
}
