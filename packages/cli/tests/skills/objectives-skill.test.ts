// Cycle (objectives-authoring-core Phase 1) — the `/objectives` skill.
//
// The SKILL.md is rendered by `df skills install objectives` — a plan-time
// authoring guide that instructs a coding agent to author verifiable
// objectives from a PR's linked cycle-doc criteria at plan time, not at
// PR close. This test mirrors `tests/skills/verify-skill.test.ts` (the
// template for new skill discoverability tests).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installSkill,
  KNOWN_SKILLS,
} from "../../src/skills/install.js";

describe("objectives skill", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-objectives-skill-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a known bundled skill", () => {
    expect(KNOWN_SKILLS).toContain("objectives");
  });

  it("renders REPO_NAME override into SKILL.md", () => {
    writeFileSync(
      join(dir, "darkfactory.yaml"),
      `repo:
  displayName: "Acme App"
`,
    );
    const r = installSkill({ cwd: dir, skillName: "objectives" });
    const skillMd = r.files.find((f) => f.relTarget === "SKILL.md");
    expect(skillMd).toBeDefined();
    const body = readFileSync(skillMd!.absoluteTarget, "utf8");
    expect(body).toContain("Acme App");
  });

  it("renders with default values when no darkfactory.yaml is present", () => {
    const r = installSkill({ cwd: dir, skillName: "objectives" });
    const skillMd = r.files.find((f) => f.relTarget === "SKILL.md");
    expect(skillMd).toBeDefined();
    const body = readFileSync(skillMd!.absoluteTarget, "utf8");
    // No unresolved template placeholders after render.
    expect(body).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
    // Confirms the skill is about the objectives command.
    expect(body).toContain("df objectives");
  });

  it("installs only SKILL.md — no producer dir (guide-only skill)", () => {
    const r = installSkill({ cwd: dir, skillName: "objectives" });
    expect(r.files.map((f) => f.relTarget)).toEqual(["SKILL.md"]);
  });

  it("skill body covers the required planning-flow topics", () => {
    const r = installSkill({ cwd: dir, skillName: "objectives" });
    const skillMd = r.files.find((f) => f.relTarget === "SKILL.md");
    const body = readFileSync(skillMd!.absoluteTarget, "utf8");
    // The authoring command — must be present and accurate.
    expect(body).toContain("df objectives derive");
    // The local-check step.
    expect(body).toContain("df objectives check");
    // The closeout step — proving objectives.
    expect(body).toContain("df prove");
    // The weak-critic caveat — critic bindings are on-ramp only.
    expect(body.toLowerCase()).toMatch(/critic.*on.?ramp|on.?ramp.*critic/);
    // The ratification flow (inferred → text-hash).
    expect(body).toContain("inferred");
  });
});
