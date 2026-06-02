// Tests for the bounded lockfile strategy.
//
// Authored alongside ADR 0001 (docs/ADR/0001-bounded-lockfile-strategy.md).
// Each test cites the ADR section / test number it implements.

import { describe, it, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractFromUnifiedDiff,
  identifyLockfileKind,
  renderDiffStub,
  renderContentStub,
  effectiveMode,
  compactDiff,
  DEFAULT_GENERATED_LOCKFILE_GLOBS,
  MAX_COMPACTED_DIFF_BYTES,
  MAX_COMPACTED_CONTENT_BYTES,
} from "../../src/compact/lockfile.js";
import type { GeneratedFilePolicy } from "@momentiq/dark-factory-schemas";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ----------------------------------------------------------------------------
// ADR § 5.2 #1 — extracts-npm-add-remove-upgrade
// ----------------------------------------------------------------------------

test("extracts npm add/remove/upgrade deltas (ADR § 5.2 #1)", () => {
  const diff = loadFixture("npm-mixed.diff");
  const result = extractFromUnifiedDiff(diff, "package-lock.json");

  expect(result.lockfileKind).toBe("npm");
  expect(result.path).toBe("package-lock.json");
  expect(result.parseError).toBeUndefined();

  // Find each by name; order is enforced separately in the renderer test.
  const byName = new Map(result.packages.map((p) => [p.name, p]));

  const foo = byName.get("foo");
  expect(foo?.kind).toBe("upgrade");
  expect(foo?.oldVersion).toBe("1.2.3");
  expect(foo?.newVersion).toBe("1.2.4");
  expect(foo?.oldIntegrity).toBe("sha512-OLDFOOHASH==");
  expect(foo?.integrity).toBe("sha512-NEWFOOHASH==");

  const bar = byName.get("bar");
  expect(bar?.kind).toBe("add");
  expect(bar?.version).toBe("2.0.0");
  expect(bar?.integrity).toBe("sha512-NEWBARHASH==");

  const baz = byName.get("baz");
  expect(baz?.kind).toBe("remove");
  expect(baz?.oldVersion).toBe("0.5.1");
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #2 — extracts-pnpm-shapes
// ----------------------------------------------------------------------------

test("extracts pnpm add/remove/upgrade deltas (ADR § 5.2 #2)", () => {
  const diff = loadFixture("pnpm-mixed.diff");
  const result = extractFromUnifiedDiff(diff, "pnpm-lock.yaml");

  expect(result.lockfileKind).toBe("pnpm");
  expect(result.parseError).toBeUndefined();

  const byName = new Map(result.packages.map((p) => [p.name, p]));

  const foo = byName.get("foo");
  expect(foo?.kind).toBe("upgrade");
  expect(foo?.oldVersion).toBe("1.2.3");
  expect(foo?.newVersion).toBe("1.2.4");
  expect(foo?.oldIntegrity).toBe("sha512-OLDFOOHASH==");
  expect(foo?.integrity).toBe("sha512-NEWFOOHASH==");

  const bar = byName.get("bar");
  expect(bar?.kind).toBe("add");
  expect(bar?.version).toBe("2.0.0");
  expect(bar?.integrity).toBe("sha512-NEWBARHASH==");

  const baz = byName.get("baz");
  expect(baz?.kind).toBe("remove");
  expect(baz?.oldVersion).toBe("0.5.1");
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #3 — extracts-yarn-shapes
// ----------------------------------------------------------------------------

test("extracts yarn add/remove/upgrade deltas (ADR § 5.2 #3)", () => {
  const diff = loadFixture("yarn-mixed.diff");
  const result = extractFromUnifiedDiff(diff, "yarn.lock");

  expect(result.lockfileKind).toBe("yarn");
  expect(result.parseError).toBeUndefined();

  const byName = new Map(result.packages.map((p) => [p.name, p]));

  const foo = byName.get("foo");
  expect(foo?.kind).toBe("upgrade");
  expect(foo?.oldVersion).toBe("1.2.3");
  expect(foo?.newVersion).toBe("1.2.4");
  expect(foo?.oldIntegrity).toBe("sha512-OLDFOOHASH==");
  expect(foo?.integrity).toBe("sha512-NEWFOOHASH==");

  const bar = byName.get("bar");
  expect(bar?.kind).toBe("add");
  expect(bar?.version).toBe("2.0.0");
  expect(bar?.integrity).toBe("sha512-NEWBARHASH==");

  const baz = byName.get("baz");
  expect(baz?.kind).toBe("remove");
  expect(baz?.oldVersion).toBe("0.5.1");
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #4 — renders-stub-deterministically
// ----------------------------------------------------------------------------

test("renders the diff stub deterministically and with sorted packages (ADR § 5.2 #4)", () => {
  const diff = loadFixture("npm-mixed.diff");
  const extracted = extractFromUnifiedDiff(diff, "package-lock.json");
  const stub1 = renderDiffStub(extracted);
  const stub2 = renderDiffStub(extracted);
  expect(stub1).toBe(stub2);

  // Sentinel brackets present.
  expect(stub1).toContain("[DF-COMPACT v1 npm]");
  expect(stub1).toContain("[DF-COMPACT end]");

  // Package lines appear sorted by name. Find the package lines block.
  const lines = stub1.split("\n");
  const pkgLines = lines.filter((l) => /^  [+\-~]/.test(l));
  const names = pkgLines.map((l) => {
    const match = /^  [+\-~]\s*([@\w\/-]+)/.exec(l);
    return match?.[1] ?? "";
  });
  // Stable sort by name (then by + / - / ~ within same name).
  const sorted = [...names].sort();
  expect(names).toEqual(sorted);

  // patch-sha256 matches the input section.
  const expectedHash = sha256Hex(diff);
  expect(stub1).toContain(`patch-sha256: ${expectedHash}`);
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #5 — parse-error-refuse-and-block
// ADR § 5.2 #6 — parse-error-compact-with-warning-opt-out
// (these are integration-flavored; rebind/runner cover them end-to-end.
// Here we just confirm the extractor returns parseError on malformed input
// and the renderer surfaces the PARSE-ERROR stub.)
// ----------------------------------------------------------------------------

test("extractor returns parseError on a malformed per-file diff (ADR § 5.2 #5)", () => {
  const malformed =
    "diff --git a/package-lock.json b/package-lock.json\n" +
    "garbage that doesn't match any extractor\n";
  const result = extractFromUnifiedDiff(malformed, "package-lock.json");
  expect(result.parseError).toBeDefined();
  expect(result.packages).toEqual([]);

  const stub = renderDiffStub(result);
  expect(stub).toContain("[DF-COMPACT v1 PARSE-ERROR]");
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #10 — compacted-diff-cap-truncates
// ----------------------------------------------------------------------------

test("compactDiff caps output at MAX_COMPACTED_DIFF_BYTES with truncation marker (ADR § 5.2 #10)", () => {
  // Build a synthetic fullDiff that exceeds MAX_COMPACTED_DIFF_BYTES even
  // after compaction by stamping many short stub sections together.
  // Each stub is ~150 bytes; we need >1700 stubs to exceed 250KB.
  let synthetic = "";
  const sections = 2500;
  for (let i = 0; i < sections; i++) {
    synthetic += `diff --git a/svc-${i}/package-lock.json b/svc-${i}/package-lock.json\n`;
    synthetic += `index abc..def 100644\n`;
    synthetic += `--- a/svc-${i}/package-lock.json\n`;
    synthetic += `+++ b/svc-${i}/package-lock.json\n`;
    synthetic += `@@ -1,5 +1,9 @@\n`;
    synthetic += `+    "node_modules/pkg-${i}": {\n`;
    synthetic += `+      "version": "1.0.${i}",\n`;
    synthetic += `+      "resolved": "https://r/pkg-${i}.tgz",\n`;
    synthetic += `+      "integrity": "sha512-HASH${i}=="\n`;
    synthetic += `+    },\n`;
  }

  const policy: GeneratedFilePolicy = {
    mode: "compact",
    globs: ["**/package-lock.json"],
  };
  const out = compactDiff(synthetic, policy);

  expect(out.compactedDiff).toBeDefined();
  expect(out.compactedDiff!.length).toBeLessThanOrEqual(MAX_COMPACTED_DIFF_BYTES);
  expect(out.compactedDiff).toContain("[DF-COMPACT TRUNCATED");
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #11 — compacted-content-cap-truncates
// ----------------------------------------------------------------------------

test("renderContentStub caps at MAX_COMPACTED_CONTENT_BYTES with truncation marker (ADR § 5.2 #11)", () => {
  // Build a synthetic post-commit lockfile state with many packages.
  const packagesAfter: { name: string; version: string; integrity?: string }[] = [];
  for (let i = 0; i < 5000; i++) {
    packagesAfter.push({
      name: `pkg-${i}`,
      version: `1.0.${i}`,
      integrity: `sha512-AAAA${i}==`,
    });
  }
  const stub = renderContentStub({
    path: "package-lock.json",
    lockfileKind: "npm",
    bytesBefore: 200000,
    contentSha256: "0".repeat(64),
    packagesAfter,
  });

  expect(stub.length).toBeLessThanOrEqual(MAX_COMPACTED_CONTENT_BYTES);
  expect(stub).toContain("[DF-COMPACT TRUNCATED");
  // The content-sha256 is over the full pre-truncation content; assert it's present unchanged.
  expect(stub).toContain("content-sha256: " + "0".repeat(64));
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #12 — pipeline-order-untruncated-fulldiff
// (covered by rebind.test integration later; here we assert compactDiff
// operates on the input without truncating first.)
// ----------------------------------------------------------------------------

test("compactDiff replaces matched lockfile sections inline, leaving unmatched sections verbatim (ADR § 5.2 #12)", () => {
  const fullDiff =
    loadFixture("npm-mixed.diff") +
    "diff --git a/src/app.ts b/src/app.ts\n" +
    "index aaa..bbb 100644\n" +
    "--- a/src/app.ts\n" +
    "+++ b/src/app.ts\n" +
    "@@ -1,3 +1,3 @@\n" +
    " function foo() {\n" +
    "-  return 1;\n" +
    "+  return 2;\n" +
    " }\n";

  const policy: GeneratedFilePolicy = {
    mode: "compact",
    globs: ["**/package-lock.json"],
  };
  const out = compactDiff(fullDiff, policy);

  expect(out.compactedDiff).toContain("[DF-COMPACT v1 npm]");
  // Source file section copied through verbatim.
  expect(out.compactedDiff).toContain("function foo() {");
  expect(out.compactedDiff).toContain("+  return 2;");
  // The matched files map carries the compacted path.
  expect(out.matchedFiles.get("package-lock.json")).toBe("npm");
  // app.ts is NOT compacted (unmatched).
  expect(out.matchedFiles.has("src/app.ts")).toBe(false);
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #13 — effective-mode-override-fires-under-mode-full
// ----------------------------------------------------------------------------

test("effectiveMode honors per-path override under top-level mode: 'full' (ADR § 5.2 #13)", () => {
  const policy: GeneratedFilePolicy = {
    mode: "full",
    globs: ["**/package-lock.json"],
    overrides: [
      {
        glob: "**/services/event-ingest/package-lock.json",
        mode: "compact",
      },
    ],
  };

  // Path covered by override → compact.
  expect(
    effectiveMode("services/event-ingest/package-lock.json", policy),
  ).toBe("compact");

  // Path covered by globs but no override → policy.mode (full → no-op).
  expect(effectiveMode("other/package-lock.json", policy)).toBe("full");

  // Path not in globs and not in overrides → "full" (implicit no-op).
  expect(effectiveMode("src/app.ts", policy)).toBe("full");
});

test("effectiveMode falls back to DEFAULT_GENERATED_LOCKFILE_GLOBS when globs is omitted", () => {
  const policy: GeneratedFilePolicy = { mode: "compact" };
  // Default list includes **/package-lock.json
  expect(effectiveMode("foo/package-lock.json", policy)).toBe("compact");
  expect(effectiveMode("nested/deep/yarn.lock", policy)).toBe("compact");
  // Unmatched path
  expect(effectiveMode("src/app.ts", policy)).toBe("full");
});

// ----------------------------------------------------------------------------
// identifyLockfileKind round-trip
// ----------------------------------------------------------------------------

test("identifyLockfileKind detects npm/pnpm/yarn from path", () => {
  expect(identifyLockfileKind("package-lock.json")).toBe("npm");
  expect(identifyLockfileKind("a/b/package-lock.json")).toBe("npm");
  expect(identifyLockfileKind("npm-shrinkwrap.json")).toBe("npm");
  expect(identifyLockfileKind("pnpm-lock.yaml")).toBe("pnpm");
  expect(identifyLockfileKind("a/pnpm-lock.yaml")).toBe("pnpm");
  expect(identifyLockfileKind("yarn.lock")).toBe("yarn");
  expect(identifyLockfileKind("a/b/yarn.lock")).toBe("yarn");
  expect(identifyLockfileKind("src/app.ts")).toBeUndefined();
});

// ----------------------------------------------------------------------------
// Default globs export (cited from ADR § 2.2)
// ----------------------------------------------------------------------------

test("DEFAULT_GENERATED_LOCKFILE_GLOBS contains the shipped four lockfile patterns", () => {
  expect(DEFAULT_GENERATED_LOCKFILE_GLOBS).toContain("**/package-lock.json");
  expect(DEFAULT_GENERATED_LOCKFILE_GLOBS).toContain("**/npm-shrinkwrap.json");
  expect(DEFAULT_GENERATED_LOCKFILE_GLOBS).toContain("**/pnpm-lock.yaml");
  expect(DEFAULT_GENERATED_LOCKFILE_GLOBS).toContain("**/yarn.lock");
});
