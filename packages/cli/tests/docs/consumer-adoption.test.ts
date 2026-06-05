// Cycle 15 Phase C — pin the new "Onboard agent context" step at the top
// of docs/CONSUMER-ADOPTION.md. Adoption-doc renumbering shifts every other
// numbered section by +2 (e.g. old "## 0. Choose your PR-gate critic" →
// "## 2.") so the agent-context step is the FIRST thing a consumer does,
// before wiring the critic gate.
//
// These assertions catch silent regressions if a future doc edit:
//   - drops the new section,
//   - forgets to mention the `df onboard` verb in it,
//   - or re-renumbers the prior "## 0" away from "## 2".
//
// Package is ESM (`"type": "module"`), so `__dirname` is undefined; we
// resolve via `import.meta.url` per the sibling-test convention (see
// cli-help.test.ts).

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const docPath = resolve(HERE, "../../../..", "docs", "CONSUMER-ADOPTION.md");

describe("docs/CONSUMER-ADOPTION.md", () => {
  it("has the new '1. Onboard agent context' section (cycle 15)", async () => {
    const body = await readFile(docPath, "utf8");
    expect(body).toMatch(/^## 1\. Onboard agent context.*Cycle 15/m);
  });

  it("references `df onboard` as a verb in the new section", async () => {
    const body = await readFile(docPath, "utf8");
    expect(body).toContain("./node_modules/.bin/df onboard");
  });

  it("renumbered the prior section 0 to section 2", async () => {
    const body = await readFile(docPath, "utf8");
    expect(body).toMatch(/^## 2\. Choose your PR-gate critic/m);
  });
});
