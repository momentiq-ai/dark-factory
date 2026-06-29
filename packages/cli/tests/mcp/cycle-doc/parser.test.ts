// Unit tests for the cycle doc parser — cycle5 Phase 1 step 3a.
//
// Pins:
//   - listCycleDocs returns summaries (id, title, status, owner?, target?)
//     for every cycle doc in the resolved cycle-docs directory.
//   - readCycleDoc returns { id, frontmatter, sections } where sections
//     keys are the h2 section names lowercased and snake_cased.
//   - resolveCyclesDir picks the directory by precedence:
//       1. darkfactory.yaml#docs.cycleDocsDir
//       2. docs/roadmap/cycles/ (when it exists)
//       3. docs/cycles/ (when it exists)
//       4. docs/roadmap/cycles/ (fallback)
//   - Filenames matching cycleN-slug.md OR cycleN.M-slug.md parse the
//     cycle id correctly (dotted variants used by sage-style cycles).
//   - Frontmatter parses YAML scalars + arrays + null/booleans.
//   - Robust to: missing frontmatter, empty sections, h2 with surrounding
//     whitespace, sections containing nested heading levels (### / ####).
//
// Tests use a temp dir + real markdown files instead of mocks because
// the parser's contract IS "read these files," and a fixture-on-disk
// test catches encoding/glob/path edge cases real-world consumers hit.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listCycleDocs,
  readCycleDoc,
  resolveCyclesDir,
} from "../../../src/mcp/cycle-doc/parser.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "df-cycle-doc-parser-"));
  mkdirSync(join(workdir, "docs", "roadmap", "cycles"), { recursive: true });
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function writeCycle(slug: string, content: string): void {
  writeFileSync(join(workdir, "docs", "roadmap", "cycles", `${slug}.md`), content, "utf8");
}

const CYCLE_1 = `---
title: "Cycle 1 — First cycle"
status: "done"
owner: "@pj"
started: "2026-01-01"
target: "2026-01-15"
closed: "2026-01-14"
---

# Cycle 1 — First cycle

## Scope

First thing.

## Exit criteria

Done when X.

## Decisions

- Use Y.
`;

const CYCLE_2 = `---
title: "Cycle 2 — Second cycle"
status: "active"
owner: "@lyra"
started: "2026-02-01"
target: "2026-03-01"
closed: null
tags: [foo, bar]
related_cycles: []
---

# Cycle 2 — Second cycle

## Scope

Second thing.

## Risks

Some risk.
`;

const CYCLE_DOTTED = `---
title: "Cycle 3.1 — Dotted variant"
status: "draft"
owner: "@team"
target: "2026-12-01"
---

# Cycle 3.1 — Dotted variant

## Scope

Dotted.
`;

const CYCLE_NESTED_HEADINGS = `---
title: "Cycle 4 — Nested"
status: "active"
---

# Cycle 4

## Scope

Top text.

### Sub-section

Nested under Scope.

#### Deeper

Even deeper.

## Risks

Risk text.
`;

describe("listCycleDocs (cycle5 Phase 1 step 3a)", () => {
  it("returns one summary per docs/roadmap/cycles/*.md file", async () => {
    writeCycle("cycle1-first", CYCLE_1);
    writeCycle("cycle2-second", CYCLE_2);
    const cycles = await listCycleDocs(workdir);
    expect(cycles.map((c) => c.id).sort()).toEqual(["cycle1", "cycle2"]);
  });

  it("extracts id from filenames like cycleN-slug.md", async () => {
    writeCycle("cycle1-first", CYCLE_1);
    const cycles = await listCycleDocs(workdir);
    expect(cycles[0]?.id).toBe("cycle1");
    expect(cycles[0]?.title).toBe("Cycle 1 — First cycle");
    expect(cycles[0]?.status).toBe("done");
    expect(cycles[0]?.owner).toBe("@pj");
    expect(cycles[0]?.target).toBe("2026-01-15");
  });

  it("handles dotted cycle ids (sage-style: cycle331.6-slug.md → cycle331.6)", async () => {
    writeCycle("cycle3.1-dotted", CYCLE_DOTTED);
    const cycles = await listCycleDocs(workdir);
    expect(cycles[0]?.id).toBe("cycle3.1");
    expect(cycles[0]?.title).toMatch(/Dotted/);
  });

  it("returns [] when docs/roadmap/cycles/ is empty or missing", async () => {
    // Empty dir
    let cycles = await listCycleDocs(workdir);
    expect(cycles).toEqual([]);

    // No dir at all
    const emptyRoot = mkdtempSync(join(tmpdir(), "df-cycle-doc-empty-"));
    try {
      cycles = await listCycleDocs(emptyRoot);
      expect(cycles).toEqual([]);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("ignores files that don't match the cycleN[-...].md pattern", async () => {
    writeCycle("cycle1-real", CYCLE_1);
    writeCycle("README", "# not a cycle doc");
    writeCycle("template", "# also not");
    const cycles = await listCycleDocs(workdir);
    expect(cycles.map((c) => c.id)).toEqual(["cycle1"]);
  });

  it("includes summaries even when frontmatter is missing optional fields", async () => {
    // Minimal valid frontmatter — just title + status. Others omitted.
    writeCycle(
      "cycle9-minimal",
      `---
title: "Minimal"
status: "draft"
---

# Minimal

## Scope

x
`,
    );
    const cycles = await listCycleDocs(workdir);
    expect(cycles[0]).toEqual({
      id: "cycle9",
      title: "Minimal",
      status: "draft",
    });
    // No `owner` or `target` keys when absent.
    expect((cycles[0] as Record<string, unknown>).owner).toBeUndefined();
    expect((cycles[0] as Record<string, unknown>).target).toBeUndefined();
  });
});

describe("readCycleDoc (cycle5 Phase 1 step 3a)", () => {
  it("returns id, full frontmatter, and h2 sections keyed by snake_case name", async () => {
    writeCycle("cycle1-first", CYCLE_1);
    const doc = await readCycleDoc(workdir, "cycle1");
    expect(doc?.id).toBe("cycle1");
    expect(doc?.frontmatter).toMatchObject({
      title: "Cycle 1 — First cycle",
      status: "done",
      owner: "@pj",
    });
    expect(Object.keys(doc?.sections ?? {}).sort()).toEqual([
      "decisions",
      "exit_criteria",
      "scope",
    ]);
    expect(doc?.sections?.scope?.trim()).toBe("First thing.");
    expect(doc?.sections?.decisions?.trim()).toBe("- Use Y.");
  });

  it("returns null when the cycle id doesn't exist (no throw)", async () => {
    writeCycle("cycle1-first", CYCLE_1);
    const doc = await readCycleDoc(workdir, "cycle999");
    expect(doc).toBeNull();
  });

  it("handles YAML arrays + null + booleans in frontmatter", async () => {
    writeCycle("cycle2-second", CYCLE_2);
    const doc = await readCycleDoc(workdir, "cycle2");
    expect(doc?.frontmatter).toMatchObject({
      tags: ["foo", "bar"],
      related_cycles: [],
      closed: null,
    });
  });

  it("preserves nested headings inside an h2 section (### and #### stay as markdown)", async () => {
    writeCycle("cycle4-nested", CYCLE_NESTED_HEADINGS);
    const doc = await readCycleDoc(workdir, "cycle4");
    const scope = doc?.sections?.scope ?? "";
    expect(scope).toContain("Top text.");
    expect(scope).toContain("### Sub-section");
    expect(scope).toContain("Nested under Scope.");
    expect(scope).toContain("#### Deeper");
    expect(scope).not.toContain("## Risks");
  });

  it("matches dotted cycle ids (cycle3.1) by the full filename prefix", async () => {
    writeCycle("cycle3.1-dotted", CYCLE_DOTTED);
    const doc = await readCycleDoc(workdir, "cycle3.1");
    expect(doc).not.toBeNull();
    expect(doc?.id).toBe("cycle3.1");
    expect(doc?.sections?.scope?.trim()).toBe("Dotted.");
  });

  it("h2 names with spaces / mixed case snake_case correctly", async () => {
    writeCycle(
      "cycle5-mixed-case",
      `---
title: "Mixed case sections"
status: "draft"
---

# Mixed case sections

## Open Questions

q1

## Implementation Plan

Step 1
`,
    );
    const doc = await readCycleDoc(workdir, "cycle5");
    expect(Object.keys(doc?.sections ?? {}).sort()).toEqual([
      "implementation_plan",
      "open_questions",
    ]);
  });

  it("handles a cycle doc with frontmatter but no h2 sections (empty sections object)", async () => {
    writeCycle(
      "cycle7-no-sections",
      `---
title: "No sections"
status: "draft"
---

# No sections

Just body text, no h2 headers.
`,
    );
    const doc = await readCycleDoc(workdir, "cycle7");
    expect(doc?.frontmatter).toMatchObject({ title: "No sections" });
    expect(doc?.sections).toEqual({});
  });
});

describe("resolveCyclesDir (gh#252)", () => {
  let workdir: string;
  const outsideDirs: string[] = [];

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "df-cycle-doc-resolve-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    for (const d of outsideDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function writeConfig(content: string): void {
    writeFileSync(join(workdir, "darkfactory.yaml"), content, "utf8");
  }

  it("defaults to docs/roadmap/cycles when no config and no directories exist", () => {
    expect(resolveCyclesDir(workdir)).toBe("docs/roadmap/cycles");
  });

  it("defaults to docs/roadmap/cycles when only that directory exists", () => {
    mkdirSync(join(workdir, "docs", "roadmap", "cycles"), { recursive: true });
    expect(resolveCyclesDir(workdir)).toBe("docs/roadmap/cycles");
  });

  it("auto-detects docs/cycles when docs/roadmap/cycles is absent", () => {
    mkdirSync(join(workdir, "docs", "cycles"), { recursive: true });
    expect(resolveCyclesDir(workdir)).toBe("docs/cycles");
  });

  it("prefers docs/roadmap/cycles when both conventions exist", () => {
    mkdirSync(join(workdir, "docs", "roadmap", "cycles"), { recursive: true });
    mkdirSync(join(workdir, "docs", "cycles"), { recursive: true });
    expect(resolveCyclesDir(workdir)).toBe("docs/roadmap/cycles");
  });

  it("honors darkfactory.yaml#docs.cycleDocsDir override", () => {
    mkdirSync(join(workdir, "custom", "cycles"), { recursive: true });
    writeConfig(["docs:", '  cycleDocsDir: "custom/cycles"'].join("\n"));
    expect(resolveCyclesDir(workdir)).toBe("custom/cycles");
  });

  it("config override wins even when docs/roadmap/cycles exists", () => {
    mkdirSync(join(workdir, "docs", "roadmap", "cycles"), { recursive: true });
    mkdirSync(join(workdir, "custom", "cycles"), { recursive: true });
    writeConfig(["docs:", '  cycleDocsDir: "custom/cycles"'].join("\n"));
    expect(resolveCyclesDir(workdir)).toBe("custom/cycles");
  });

  it("falls back to auto-detection when configured cycleDocsDir escapes repoRoot", () => {
    mkdirSync(join(workdir, "docs", "cycles"), { recursive: true });
    writeConfig(["docs:", '  cycleDocsDir: "../outside"'].join("\n"));
    expect(resolveCyclesDir(workdir)).toBe("docs/cycles");
  });

  it("falls back to auto-detection when configured cycleDocsDir is an absolute outside path", () => {
    mkdirSync(join(workdir, "docs", "cycles"), { recursive: true });
    writeConfig(["docs:", '  cycleDocsDir: "/tmp/outside"'].join("\n"));
    expect(resolveCyclesDir(workdir)).toBe("docs/cycles");
  });

  it("falls back to auto-detection when configured cycleDocsDir uses '..' mid-path", () => {
    mkdirSync(join(workdir, "docs", "cycles"), { recursive: true });
    writeConfig(["docs:", '  cycleDocsDir: "foo/../../outside"'].join("\n"));
    expect(resolveCyclesDir(workdir)).toBe("docs/cycles");
  });

  it("allows configured cycleDocsDir resolving to repoRoot itself", () => {
    writeConfig(["docs:", '  cycleDocsDir: "."'].join("\n"));
    expect(resolveCyclesDir(workdir)).toBe(".");
  });

  it("falls back to auto-detection when configured cycleDocsDir is a symlink to outside repoRoot", () => {
    const outside = mkdtempSync(join(tmpdir(), "df-cycle-doc-outside-"));
    outsideDirs.push(outside);
    mkdirSync(join(workdir, "docs", "cycles"), { recursive: true });
    symlinkSync(outside, join(workdir, "symlinked-cycles"), "dir");
    writeConfig(["docs:", '  cycleDocsDir: "symlinked-cycles"'].join("\n"));
    expect(resolveCyclesDir(workdir)).toBe("docs/cycles");
  });

  it("falls back to docs/cycles when docs/roadmap/cycles is a symlink to outside repoRoot", () => {
    const outside = mkdtempSync(join(tmpdir(), "df-cycle-doc-outside-"));
    outsideDirs.push(outside);
    mkdirSync(join(workdir, "docs", "cycles"), { recursive: true });
    mkdirSync(join(workdir, "docs", "roadmap"), { recursive: true });
    symlinkSync(outside, join(workdir, "docs", "roadmap", "cycles"), "dir");
    expect(resolveCyclesDir(workdir)).toBe("docs/cycles");
  });

  it("falls back to lexical default when both conventional dirs are symlinks to outside repoRoot", () => {
    const outside = mkdtempSync(join(tmpdir(), "df-cycle-doc-outside-"));
    outsideDirs.push(outside);
    mkdirSync(join(workdir, "docs"), { recursive: true });
    mkdirSync(join(workdir, "docs", "roadmap"), { recursive: true });
    symlinkSync(outside, join(workdir, "docs", "cycles"), "dir");
    symlinkSync(outside, join(workdir, "docs", "roadmap", "cycles"), "dir");
    expect(resolveCyclesDir(workdir)).toBe("docs/roadmap/cycles");
  });
});
