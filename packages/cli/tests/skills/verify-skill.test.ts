// Cycle 22 (momentiq-ai/dark-factory#193) — the `verify` skill + the reusable
// playwright (UI) route producer.
//
// The SKILL.md is rendered by `df skills install verify` (don't-hand-edit,
// darkfactory-driven). The producer is the OPPOSITE — copy-once + own — so it
// ships as REFERENCE files under skills/verify/producer/ that are NOT part of
// skill.json#files and therefore NOT written by the render system. This test
// pins both halves of that contract.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installSkill,
  KNOWN_SKILLS,
  resolveSkillsRoot,
} from "../../src/skills/install.js";

describe("verify skill (#193)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-verify-skill-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a known bundled skill", () => {
    expect(KNOWN_SKILLS).toContain("verify");
  });

  it("renders REPO_NAME + ARTIFACT_DIR overrides into SKILL.md", () => {
    writeFileSync(
      join(dir, "darkfactory.yaml"),
      `repo:
  displayName: "Acme App"
`,
    );
    const r = installSkill({ cwd: dir, skillName: "verify" });
    const skillMd = r.files.find((f) => f.relTarget === "SKILL.md");
    expect(skillMd).toBeDefined();
    const body = readFileSync(skillMd!.absoluteTarget, "utf8");
    expect(body).toContain("Acme App");
    expect(body).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
    // ARTIFACT_DIR is a fixed-default display var (the canonical artifact dir).
    expect(body).toContain(".git/agent-reviews/quality-gates");
    // The skill drives the graduated subcommand, not the bespoke DFP scripts.
    expect(body).toContain("df verify");
    expect(body).not.toContain("df-run-routes.mjs");
  });

  it("render installs ONLY SKILL.md — the producer is copy-once, never rendered", () => {
    const r = installSkill({ cwd: dir, skillName: "verify" });
    expect(r.files.map((f) => f.relTarget)).toEqual(["SKILL.md"]);
    // The render system must NOT drop the producer reference files into the
    // consumer's .claude/skills/verify/ install dir (they are theirs to copy +
    // own; re-render must never clobber their SURFACES[]).
    const installDir = join(dir, ".claude", "skills", "verify");
    expect(existsSync(join(installDir, "producer"))).toBe(false);
    expect(existsSync(join(installDir, "producer", "playwright-route.sh"))).toBe(false);
  });

  it("ships the reusable producer reference files in the bundled skill dir (npm tarball)", () => {
    const producerDir = join(resolveSkillsRoot(), "verify", "producer");
    for (const f of [
      "playwright-route.sh",
      "playwright.ui-route.config.ts",
      "ui-route.producer.spec.ts",
      "coverage.ts",
      "README.md",
    ]) {
      expect(existsSync(join(producerDir, f))).toBe(true);
    }
  });
});
