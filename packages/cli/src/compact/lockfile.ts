// ADR 0001 — bounded lockfile strategy (issue #67).
//
// Per-lockfile-format extractors + renderer. The compactor walks a
// unified-diff section (per the cycle's "diff --git ..." → next
// "diff --git ..." boundary), identifies the lockfile kind by
// filename, parses the +/- lines into a CompactedLockfileDelta, and
// renders a stable text stub the prompt builder splices in.
//
// See `docs/ADR/0001-bounded-lockfile-strategy.md` for the full
// design + format spec. This module implements §§ 2.2.1, 2.3, 2.4.1,
// 3.6, 3.7 of that ADR.

import { createHash } from "node:crypto";

import type { GeneratedFilePolicy } from "@momentiq/dark-factory-schemas";

import { matchAnyGlob, matchGlob } from "../glob.js";

// ADR § 2.4.1 — byte caps on the prompt-rendered surfaces. The 250KB
// cap on compactedDiff is the LOAD-BEARING fix for codex round-2
// performance blocker: even after compaction, a mono-repo with
// hundreds of compacted lockfiles must not overflow the model
// context window. 250KB ≈ 60K tokens, leaving headroom below the
// smallest critic context window.
//
// The 50KB cap on compactedContent applies per-file: a single
// lockfile with thousands of packages can still produce a large
// `packages-after:` stub. Truncation preserves content-sha256 over
// the FULL pre-truncation body so audit recovery remains possible.
export const MAX_COMPACTED_DIFF_BYTES = 250_000;
export const MAX_COMPACTED_CONTENT_BYTES = 50_000;

// ADR § 2.2 — shipped default glob list, substituted at packet-build
// time when generatedFilePolicy.globs is omitted. § 3.7 documents
// why we do NOT merge with explicit globs: the default list will
// grow over CLI versions, and silently expanding an operator's
// match set is a surprise vector.
export const DEFAULT_GENERATED_LOCKFILE_GLOBS: readonly string[] = [
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
];

export type LockfileKind = "npm" | "pnpm" | "yarn";

export interface CompactedPackageDelta {
  kind: "add" | "remove" | "upgrade";
  name: string;
  version?: string;
  oldVersion?: string;
  newVersion?: string;
  integrity?: string;
  oldIntegrity?: string;
}

export interface CompactedLockfileDelta {
  path: string;
  lockfileKind: LockfileKind;
  addedLines: number;
  removedLines: number;
  patchSha256: string;
  packages: CompactedPackageDelta[];
  parseError?: string;
  notes?: string[];
}

export interface CompactedContentInput {
  path: string;
  lockfileKind: LockfileKind;
  bytesBefore: number;
  contentSha256: string;
  packagesAfter: { name: string; version: string; integrity?: string }[];
}

export interface CompactDiffOutput {
  compactedDiff: string;
  matchedFiles: Map<string, LockfileKind>;
  parseErrorPaths: string[];
}

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

export function identifyLockfileKind(path: string): LockfileKind | undefined {
  const base = path.split("/").pop() ?? path;
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return "npm";
  if (base === "pnpm-lock.yaml") return "pnpm";
  if (base === "yarn.lock") return "yarn";
  return undefined;
}

// ADR § 2.2.1 — effective-mode resolver. Override precedence is
// strictly per-path; the packet builder triggers compaction whenever
// ANY path has effectiveMode !== "full", not when policy.mode !== "full".
export function effectiveMode(
  path: string,
  policy: GeneratedFilePolicy,
): "full" | "compact" | "omit" {
  for (const override of policy.overrides ?? []) {
    if (matchGlob(path, override.glob)) return override.mode;
  }
  const effectiveGlobs = policy.globs ?? DEFAULT_GENERATED_LOCKFILE_GLOBS;
  if (matchAnyGlob(path, effectiveGlobs)) return policy.mode;
  return "full";
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export function extractFromUnifiedDiff(
  perFileDiff: string,
  path: string,
): CompactedLockfileDelta {
  const lockfileKind = identifyLockfileKind(path);
  if (lockfileKind === undefined) {
    return {
      path,
      lockfileKind: "npm",
      addedLines: 0,
      removedLines: 0,
      patchSha256: sha256(perFileDiff),
      packages: [],
      parseError: `unknown-lockfile-kind: ${path}`,
    };
  }

  const { added, removed } = countAddedRemoved(perFileDiff);
  const patchSha256 = sha256(perFileDiff);

  try {
    let packages: CompactedPackageDelta[];
    switch (lockfileKind) {
      case "npm":
        packages = extractNpm(perFileDiff);
        break;
      case "pnpm":
        packages = extractPnpm(perFileDiff);
        break;
      case "yarn":
        packages = extractYarn(perFileDiff);
        break;
    }

    return {
      path,
      lockfileKind,
      addedLines: added,
      removedLines: removed,
      patchSha256,
      packages,
      ...(packages.length === 0 ? { notes: ["lockfile-metadata-only"] } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      path,
      lockfileKind,
      addedLines: added,
      removedLines: removed,
      patchSha256,
      packages: [],
      parseError: message,
    };
  }
}

// npm — walk hunks; track last-seen `"node_modules/<name>":` marker.
// Each `+/-"version"` or `+/-"integrity"` line attributes to the
// last-seen marker. Pure-add and pure-remove blocks are detected by
// the marker line itself appearing on a `+` or `-` line.
function extractNpm(diff: string): CompactedPackageDelta[] {
  interface Acc {
    addVersion?: string;
    addIntegrity?: string;
    removeVersion?: string;
    removeIntegrity?: string;
    sawAddMarker: boolean;
    sawRemoveMarker: boolean;
  }
  const byName = new Map<string, Acc>();
  let lastName: string | null = null;
  // Match "node_modules/<name>" entries; ignore workspace ("") and
  // bare "packages/<name>" entries.
  const markerRe = /^([+\- ])\s*"node_modules\/(@?[^"]+)":\s*\{/;
  const versionRe = /^([+\- ])\s*"version":\s*"([^"]+)"/;
  const integrityRe = /^([+\- ])\s*"integrity":\s*"([^"]+)"/;

  let saw = false;
  for (const line of diff.split("\n")) {
    const m = markerRe.exec(line);
    if (m) {
      saw = true;
      lastName = m[2] ?? null;
      // Skip nested packages like "node_modules/foo/node_modules/bar"
      // for v1; record the inner name only.
      if (lastName?.includes("/node_modules/")) {
        const parts = lastName.split("/node_modules/");
        lastName = parts[parts.length - 1] ?? lastName;
      }
      if (!lastName) continue;
      let acc = byName.get(lastName);
      if (!acc) {
        acc = { sawAddMarker: false, sawRemoveMarker: false };
        byName.set(lastName, acc);
      }
      if (m[1] === "+") acc.sawAddMarker = true;
      else if (m[1] === "-") acc.sawRemoveMarker = true;
      continue;
    }
    if (!lastName) continue;
    const acc = byName.get(lastName);
    if (!acc) continue;
    const vm = versionRe.exec(line);
    if (vm) {
      saw = true;
      if (vm[1] === "+") acc.addVersion = vm[2] ?? "";
      else if (vm[1] === "-") acc.removeVersion = vm[2] ?? "";
      continue;
    }
    const im = integrityRe.exec(line);
    if (im) {
      if (im[1] === "+") acc.addIntegrity = im[2] ?? "";
      else if (im[1] === "-") acc.removeIntegrity = im[2] ?? "";
      continue;
    }
  }

  if (!saw) {
    throw new Error("npm: no node_modules entries found in diff");
  }

  const out: CompactedPackageDelta[] = [];
  for (const [name, acc] of byName) {
    // Pure add: sawAddMarker AND not sawRemoveMarker
    // Pure remove: sawRemoveMarker AND not sawAddMarker
    // Upgrade: any version change or integrity change without
    //         marker-only flip
    if (acc.sawAddMarker && !acc.sawRemoveMarker) {
      out.push({
        kind: "add",
        name,
        ...(acc.addVersion !== undefined ? { version: acc.addVersion } : {}),
        ...(acc.addIntegrity !== undefined ? { integrity: acc.addIntegrity } : {}),
      });
    } else if (acc.sawRemoveMarker && !acc.sawAddMarker) {
      out.push({
        kind: "remove",
        name,
        ...(acc.removeVersion !== undefined ? { oldVersion: acc.removeVersion } : {}),
      });
    } else if (acc.addVersion !== undefined || acc.removeVersion !== undefined) {
      out.push({
        kind: "upgrade",
        name,
        ...(acc.removeVersion !== undefined ? { oldVersion: acc.removeVersion } : {}),
        ...(acc.addVersion !== undefined ? { newVersion: acc.addVersion } : {}),
        ...(acc.removeIntegrity !== undefined
          ? { oldIntegrity: acc.removeIntegrity }
          : {}),
        ...(acc.addIntegrity !== undefined ? { integrity: acc.addIntegrity } : {}),
      });
    }
    // Else: marker-only inside a context block — ignore.
  }
  return out;
}

// pnpm — walk hunks; match `+/-  /<name>@<version>:` spec lines.
// Group by name; if both + and - versions exist, it's an upgrade.
// Track integrity from the immediate-following indented line.
function extractPnpm(diff: string): CompactedPackageDelta[] {
  interface PnpmEntry {
    name: string;
    version: string;
    integrity?: string;
  }
  const adds: PnpmEntry[] = [];
  const removes: PnpmEntry[] = [];
  const lines = diff.split("\n");
  const specRe = /^([+\- ])\s*\/(@?[^@/]+(?:\/[^@/]+)?)@([^:()]+)(?:\([^)]+\))?:/;
  const integrityRe = /^([+\- ])\s*integrity:\s*(\S+)/;

  let pending: PnpmEntry | null = null;
  let pendingSign: "+" | "-" | null = null;
  let saw = false;

  function flush() {
    if (!pending || !pendingSign) return;
    (pendingSign === "+" ? adds : removes).push(pending);
    pending = null;
    pendingSign = null;
  }

  for (const line of lines) {
    const m = specRe.exec(line);
    if (m && (m[1] === "+" || m[1] === "-")) {
      saw = true;
      flush();
      pending = { name: m[2] ?? "", version: m[3] ?? "" };
      pendingSign = m[1] as "+" | "-";
      continue;
    }
    if (pending && pendingSign) {
      const im = integrityRe.exec(line);
      if (im && (im[1] === pendingSign)) {
        pending.integrity = im[2] ?? "";
        continue;
      }
      // Any non-matching line ends the pending block.
      // (We don't flush eagerly — wait for next spec or EOF.)
    }
  }
  flush();

  if (!saw) {
    throw new Error("pnpm: no /<name>@<version>: entries found in diff");
  }

  const byName = new Map<string, { add?: PnpmEntry; remove?: PnpmEntry }>();
  for (const a of adds) {
    const e = byName.get(a.name) ?? {};
    e.add = a;
    byName.set(a.name, e);
  }
  for (const r of removes) {
    const e = byName.get(r.name) ?? {};
    e.remove = r;
    byName.set(r.name, e);
  }

  const out: CompactedPackageDelta[] = [];
  for (const [name, e] of byName) {
    if (e.add && e.remove) {
      out.push({
        kind: "upgrade",
        name,
        oldVersion: e.remove.version,
        newVersion: e.add.version,
        ...(e.remove.integrity !== undefined ? { oldIntegrity: e.remove.integrity } : {}),
        ...(e.add.integrity !== undefined ? { integrity: e.add.integrity } : {}),
      });
    } else if (e.add) {
      out.push({
        kind: "add",
        name,
        version: e.add.version,
        ...(e.add.integrity !== undefined ? { integrity: e.add.integrity } : {}),
      });
    } else if (e.remove) {
      out.push({
        kind: "remove",
        name,
        oldVersion: e.remove.version,
      });
    }
  }
  return out;
}

// yarn — walk hunks; match `+/-<name>@<spec>:` top-level entries.
// Each entry's body has `version "X"` and `integrity sha512-...`
// lines (also +/-).
function extractYarn(diff: string): CompactedPackageDelta[] {
  interface YarnEntry {
    name: string;
    version?: string;
    integrity?: string;
  }
  const adds = new Map<string, YarnEntry>();
  const removes = new Map<string, YarnEntry>();
  const lines = diff.split("\n");
  // yarn spec line: ^<sign><name>@<range>: (no leading whitespace
  // for the spec line; nested entries are indented two spaces).
  const specRe = /^([+\-])(@?[^@\s]+)@[^:]+:/;
  const versionRe = /^([+\- ])\s+version\s+"([^"]+)"/;
  const integrityRe = /^([+\- ])\s+integrity\s+(\S+)/;

  let currentSign: "+" | "-" | null = null;
  let currentName: string | null = null;
  let saw = false;
  // Context-line spec matcher: same as specRe but with a leading
  // single space (` `) in place of `+`/`-`. Matching a context spec
  // line ENDS the current +/- block so a context-line body doesn't
  // leak into the previous +/- block's fields (the yarn case where
  // `qux@^3.1.0:` follows `-baz@^0.5.1:` without separator).
  const contextSpecRe = /^ (@?[^@\s]+)@[^:]+:/;

  for (const line of lines) {
    const m = specRe.exec(line);
    if (m) {
      saw = true;
      currentSign = m[1] as "+" | "-";
      currentName = m[2] ?? null;
      if (currentName) {
        const map = currentSign === "+" ? adds : removes;
        if (!map.has(currentName)) map.set(currentName, { name: currentName });
      }
      continue;
    }
    // A context spec line clears the current +/- block context so
    // its body's version/integrity (also context) don't overwrite
    // the prior block's fields.
    if (contextSpecRe.test(line)) {
      currentSign = null;
      currentName = null;
      continue;
    }
    if (!currentName || !currentSign) continue;
    const map = currentSign === "+" ? adds : removes;
    const entry = map.get(currentName);
    if (!entry) continue;
    const vm = versionRe.exec(line);
    if (vm) {
      // Only accept body lines whose sign matches the current
      // block's sign. Context (` `) lines belong to context-block
      // sections, NOT to +/- blocks.
      if (vm[1] === currentSign) {
        entry.version = vm[2] ?? "";
      }
      continue;
    }
    const im = integrityRe.exec(line);
    if (im) {
      if (im[1] === currentSign) {
        entry.integrity = im[2] ?? "";
      }
      continue;
    }
  }

  if (!saw) {
    throw new Error("yarn: no top-level <name>@<range>: entries found in diff");
  }

  const allNames = new Set<string>([...adds.keys(), ...removes.keys()]);
  const out: CompactedPackageDelta[] = [];
  for (const name of allNames) {
    const a = adds.get(name);
    const r = removes.get(name);
    if (a && r) {
      out.push({
        kind: "upgrade",
        name,
        ...(r.version !== undefined ? { oldVersion: r.version } : {}),
        ...(a.version !== undefined ? { newVersion: a.version } : {}),
        ...(r.integrity !== undefined ? { oldIntegrity: r.integrity } : {}),
        ...(a.integrity !== undefined ? { integrity: a.integrity } : {}),
      });
    } else if (a) {
      out.push({
        kind: "add",
        name,
        ...(a.version !== undefined ? { version: a.version } : {}),
        ...(a.integrity !== undefined ? { integrity: a.integrity } : {}),
      });
    } else if (r) {
      out.push({
        kind: "remove",
        name,
        ...(r.version !== undefined ? { oldVersion: r.version } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderDiffStub(delta: CompactedLockfileDelta): string {
  if (delta.parseError !== undefined) {
    return [
      `diff --git a/${delta.path} b/${delta.path}`,
      `[DF-COMPACT v1 PARSE-ERROR]`,
      `files:`,
      `  - +${delta.addedLines} -${delta.removedLines} patch-sha256: ${delta.patchSha256}`,
      `error: ${delta.parseError}`,
      `[DF-COMPACT end]`,
      ``,
    ].join("\n");
  }

  const sortedPackages = sortPackages(delta.packages);
  const pkgLines = sortedPackages.map(renderPackageLine);
  const lines: string[] = [
    `diff --git a/${delta.path} b/${delta.path}`,
    `[DF-COMPACT v1 ${delta.lockfileKind}]`,
    `files:`,
    `  - +${delta.addedLines} -${delta.removedLines} patch-sha256: ${delta.patchSha256}`,
  ];
  if (sortedPackages.length === 0) {
    lines.push(`notes: ${(delta.notes ?? []).join(",") || "lockfile-metadata-only"}`);
  } else {
    lines.push(`packages:`);
    lines.push(...pkgLines);
  }
  lines.push(`[DF-COMPACT end]`);
  lines.push(``);
  return lines.join("\n");
}

function sortPackages(pkgs: CompactedPackageDelta[]): CompactedPackageDelta[] {
  return [...pkgs].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    const order: Record<string, number> = { add: 0, remove: 1, upgrade: 2 };
    return (order[a.kind] ?? 99) - (order[b.kind] ?? 99);
  });
}

function renderPackageLine(p: CompactedPackageDelta): string {
  if (p.kind === "add") {
    const v = p.version ?? "unknown";
    const i = p.integrity ?? "unknown";
    return `  + ${p.name}@${v} integrity=${i}`;
  }
  if (p.kind === "remove") {
    const v = p.oldVersion ?? "unknown";
    return `  - ${p.name}@${v}`;
  }
  // upgrade
  const ov = p.oldVersion ?? "unknown";
  const nv = p.newVersion ?? "unknown";
  const oi = p.oldIntegrity ?? "unknown";
  const ni = p.integrity ?? "unknown";
  return `  ~ ${p.name} ${ov} → ${nv}  (integrity: ${oi} → ${ni})`;
}

// renderContentStub: produces a packages-after stub for the
// `<file>` block. Cap at MAX_COMPACTED_CONTENT_BYTES with truncation
// marker. content-sha256 always hashes the full pre-truncation body
// so audit recovery is possible.
export function renderContentStub(input: CompactedContentInput): string {
  const header = [
    `[DF-COMPACT v1 ${input.lockfileKind} full-content omitted]`,
    `files:`,
    `  - bytes: ${input.bytesBefore}`,
    `  - content-sha256: ${input.contentSha256}`,
    `packages-after:`,
  ];
  const headerJoined = header.join("\n") + "\n";

  // Sort packages by name for determinism.
  const sorted = [...input.packagesAfter].sort((a, b) => (a.name < b.name ? -1 : 1));

  const out: string[] = [...header];
  let runningBytes = Buffer.byteLength(headerJoined, "utf8");
  let elided = 0;
  for (const p of sorted) {
    const line = `  - ${p.name}@${p.version} integrity=${p.integrity ?? "unknown"}`;
    const lineBytes = Buffer.byteLength(line + "\n", "utf8");
    // Budget for the truncation marker + final newline.
    const reserve = 80;
    if (runningBytes + lineBytes + reserve > MAX_COMPACTED_CONTENT_BYTES) {
      elided++;
      continue;
    }
    if (elided > 0) {
      // We're past the budget — keep counting.
      elided++;
      continue;
    }
    out.push(line);
    runningBytes += lineBytes;
  }
  if (elided > 0) {
    out.push(`[DF-COMPACT TRUNCATED — ${elided} more packages elided]`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Diff-walker — splits a fullDiff into per-file sections and routes
// matched paths through the extractor/renderer. § 2.1.1 (pipeline
// order): operates on the UNTRUNCATED fullDiff so source-file hunks
// that previously overflowed now fit after lockfile sections collapse.
// ---------------------------------------------------------------------------

export function compactDiff(
  fullDiff: string,
  policy: GeneratedFilePolicy,
): CompactDiffOutput {
  const sections = splitDiffByFile(fullDiff);
  const outSections: string[] = [];
  const matchedFiles = new Map<string, LockfileKind>();
  const parseErrorPaths: string[] = [];
  let elidedLockfileSections = 0;
  let runningBytes = 0;
  let capHit = false;

  for (const section of sections) {
    const path = section.path;
    if (path === null) {
      // Header-only section (no path discovered, e.g. binary diff).
      pushSection(outSections, section.text, runningBytes);
      runningBytes += Buffer.byteLength(section.text, "utf8");
      continue;
    }
    const mode = effectiveMode(path, policy);
    if (mode === "full") {
      const sectionBytes = Buffer.byteLength(section.text, "utf8");
      if (runningBytes + sectionBytes > MAX_COMPACTED_DIFF_BYTES) {
        capHit = true;
        break;
      }
      outSections.push(section.text);
      runningBytes += sectionBytes;
      continue;
    }
    if (mode === "omit") {
      const stub =
        `diff --git a/${path} b/${path}\n` +
        `[DF-COMPACT v1 omit-by-policy ${path}]\n\n`;
      const stubBytes = Buffer.byteLength(stub, "utf8");
      if (runningBytes + stubBytes > MAX_COMPACTED_DIFF_BYTES) {
        capHit = true;
        elidedLockfileSections++;
        break;
      }
      outSections.push(stub);
      runningBytes += stubBytes;
      const kind = identifyLockfileKind(path);
      if (kind !== undefined) matchedFiles.set(path, kind);
      continue;
    }
    // mode === "compact"
    const extracted = extractFromUnifiedDiff(section.text, path);
    if (extracted.parseError !== undefined) parseErrorPaths.push(path);
    const stub = renderDiffStub(extracted);
    const stubBytes = Buffer.byteLength(stub, "utf8");
    if (runningBytes + stubBytes > MAX_COMPACTED_DIFF_BYTES) {
      capHit = true;
      elidedLockfileSections++;
      break;
    }
    outSections.push(stub);
    runningBytes += stubBytes;
    matchedFiles.set(path, extracted.lockfileKind);
  }

  if (capHit) {
    outSections.push(
      `[DF-COMPACT TRUNCATED — ${elidedLockfileSections} more lockfile sections elided (cap=${MAX_COMPACTED_DIFF_BYTES})]\n`,
    );
  }

  return {
    compactedDiff: outSections.join(""),
    matchedFiles,
    parseErrorPaths,
  };
}

function pushSection(
  outSections: string[],
  text: string,
  runningBytes: number,
): void {
  // Helper kept for clarity; cap-check happens at caller.
  outSections.push(text);
}

interface DiffSection {
  // null when the section is header-only / unparseable.
  path: string | null;
  text: string;
}

// Split a unified diff into per-file sections, preserving each
// section's trailing newline. A section starts at "diff --git " and
// ends at the next "diff --git " (or EOF).
export function splitDiffByFile(diff: string): DiffSection[] {
  const out: DiffSection[] = [];
  const headerRe = /^diff --git a\/(.+?) b\/(.+?)$/;
  const lines = diff.split("\n");
  let current: string[] = [];
  let currentPath: string | null = null;

  function flush() {
    if (current.length === 0) return;
    const text = current.join("\n") + (current[current.length - 1] === "" ? "" : "\n");
    out.push({ path: currentPath, text });
    current = [];
    currentPath = null;
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = headerRe.exec(line);
      currentPath = m?.[2] ?? null;
    }
    current.push(line);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function countAddedRemoved(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
