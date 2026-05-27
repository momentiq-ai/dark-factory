// Unit tests for the ADR parser — cycle5 Phase 1 step 3c.
//
// ADR format (from docs/ADR/ in dark-factory-platform):
//   # ADR <id-or-title> — <full title>
//   - **Status:** Accepted | Proposed | Superseded by ADR-... | Deprecated
//   - **Date:** YYYY-MM-DD
//   - **Deciders:** ...
//   - **Scope:** ...
//   - **Supersedes:** ... (optional)
//   - **Supersedes (in part):** ... (optional)
//
//   ## Context
//   ...
//
//   ## Decision
//   ...
//
// Pins:
//   - listAdrDocs returns one summary per *.md under docs/ADR/
//   - id = filename basename (without .md extension); full + unique
//   - title = h1 text after "ADR <prefix> — " (or the full h1 if no
//     em-dash separator)
//   - status / date / supersedes pulled from the bullet metadata
//   - readAdrDoc returns body markdown after the bullet metadata block

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import {
  listAdrDocs,
  readAdrDoc,
} from "../../../src/mcp/adr/parser.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "df-adr-parser-"));
  mkdirSync(join(workdir, "docs", "ADR"), { recursive: true });
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function writeAdr(slug: string, content: string): void {
  writeFileSync(join(workdir, "docs", "ADR", `${slug}.md`), content, "utf8");
}

const ADR_ACCEPTED = `# ADR 2026-05 — W1→W3 gate migration: hosted critic is authoritative

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** PJ (lead architect)
- **Scope:** Every repo enrolled in the W3 hosted Dark Factory App.
- **Supersedes (in part):** ADR 2026-04 (local critic posture).

## Context

The hosted W3 gate is now the authoritative critic.

## Decision

Keep local + W3; drop W1 CI agent-critic.
`;

const ADR_NO_SUPERSEDES = `# ADR 2026-03 — Migrate to KMS-vaulted vendor keys

- **Status:** Proposed
- **Date:** 2026-03-15
- **Deciders:** PJ

## Context

Vendor keys currently live as Actions secrets.

## Decision

Move to managed KMS envelope.
`;

const ADR_NO_EMDASH = `# Accept Claude as the default critic model

- **Status:** Accepted
- **Date:** 2026-02-01
- **Deciders:** PJ

## Context

Inertia from sage3c.

## Decision

Default to Claude Opus 4.7.
`;

describe("listAdrDocs (cycle5 Phase 1 step 3c)", () => {
  it("returns one summary per *.md under docs/ADR/", async () => {
    writeAdr("2026-05-w1-w3-gate-migration", ADR_ACCEPTED);
    writeAdr("2026-03-kms-vault", ADR_NO_SUPERSEDES);
    const adrs = await listAdrDocs(workdir);
    expect(adrs.map((a) => a.id).sort()).toEqual([
      "2026-03-kms-vault",
      "2026-05-w1-w3-gate-migration",
    ]);
  });

  it("returns id (full basename), title (h1 after em-dash), status, date", async () => {
    writeAdr("2026-05-w1-w3-gate-migration", ADR_ACCEPTED);
    const adrs = await listAdrDocs(workdir);
    const adr = adrs[0]!;
    expect(adr.id).toBe("2026-05-w1-w3-gate-migration");
    expect(adr.title).toBe(
      "W1→W3 gate migration: hosted critic is authoritative",
    );
    expect(adr.status).toBe("Accepted");
    expect(adr.date).toBe("2026-05-26");
  });

  it("title falls back to full h1 when no em-dash separator", async () => {
    writeAdr("2026-02-claude-default", ADR_NO_EMDASH);
    const adrs = await listAdrDocs(workdir);
    expect(adrs[0]?.title).toBe("Accept Claude as the default critic model");
  });

  it("returns [] when docs/ADR/ is empty or missing", async () => {
    expect(await listAdrDocs(workdir)).toEqual([]);
    const emptyRoot = mkdtempSync(join(tmpdir(), "df-adr-empty-"));
    try {
      expect(await listAdrDocs(emptyRoot)).toEqual([]);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("skips files without an h1 header (defensive against partial drafts)", async () => {
    writeAdr("2026-05-w1-w3-gate-migration", ADR_ACCEPTED);
    writeAdr("2026-04-draft", "- **Status:** WIP\n\nNo h1 yet.\n");
    const adrs = await listAdrDocs(workdir);
    // Strict mode — the draft without h1 is dropped from the catalog.
    expect(adrs.map((a) => a.id)).toEqual(["2026-05-w1-w3-gate-migration"]);
  });
});

describe("readAdrDoc (cycle5 Phase 1 step 3c)", () => {
  it("returns id, frontmatter (bullets), body, status, supersedes", async () => {
    writeAdr("2026-05-w1-w3-gate-migration", ADR_ACCEPTED);
    const doc = await readAdrDoc(workdir, "2026-05-w1-w3-gate-migration");
    expect(doc?.id).toBe("2026-05-w1-w3-gate-migration");
    expect(doc?.status).toBe("Accepted");
    expect(doc?.supersedes).toBe("ADR 2026-04 (local critic posture).");
    expect(doc?.frontmatter).toMatchObject({
      Status: "Accepted",
      Date: "2026-05-26",
      Deciders: "PJ (lead architect)",
      "Supersedes (in part)": "ADR 2026-04 (local critic posture).",
    });
    expect(doc?.body).toMatch(/## Context/);
    expect(doc?.body).toMatch(/## Decision/);
    // The body starts AFTER the bullet metadata, so the h1 + bullets
    // are NOT included.
    expect(doc?.body).not.toMatch(/^# ADR 2026-05/m);
    expect(doc?.body).not.toMatch(/^- \*\*Status:/m);
  });

  it("omits supersedes when the ADR doesn't carry that bullet", async () => {
    writeAdr("2026-03-kms-vault", ADR_NO_SUPERSEDES);
    const doc = await readAdrDoc(workdir, "2026-03-kms-vault");
    expect(doc?.supersedes).toBeUndefined();
    expect(doc?.status).toBe("Proposed");
  });

  it("returns null for an unknown id (no throw)", async () => {
    writeAdr("2026-05-w1-w3-gate-migration", ADR_ACCEPTED);
    expect(await readAdrDoc(workdir, "missing")).toBeNull();
  });

  it("accepts a plain 'Supersedes' bullet when present (no '(in part)' qualifier)", async () => {
    writeAdr(
      "2026-04-replaces-older",
      `# ADR 2026-04 — Replaces older

- **Status:** Accepted
- **Date:** 2026-04-01
- **Deciders:** PJ
- **Supersedes:** ADR 2026-01 (entirely)

## Context

old.

## Decision

new.
`,
    );
    const doc = await readAdrDoc(workdir, "2026-04-replaces-older");
    expect(doc?.supersedes).toBe("ADR 2026-01 (entirely)");
  });
});
