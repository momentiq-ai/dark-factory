// Regression test for the `agent_context.agents_md_canonical` doctor check.
//
// Non-Claude agents (OpenCode, Codex, Cursor, Copilot, Gemini) read ONLY
// AGENTS.md and ignore CLAUDE.md when both exist. The check flags repos where
// CLAUDE.md carries standalone doctrine instead of importing AGENTS.md, so that
// CLAUDE.md-only rules can't silently stay invisible to those agents while the
// gate judges against them. The warning is non-blocking (`optional: true`).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkAgentsCanonical } from "../../src/doctor.js";

describe("checkAgentsCanonical", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agents-canonical-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes when CLAUDE.md imports AGENTS.md (@AGENTS.md)", async () => {
    await writeFile(join(dir, "AGENTS.md"), "# AGENTS\nuniversal doctrine\n");
    await writeFile(
      join(dir, "CLAUDE.md"),
      "@AGENTS.md\n\n# CLAUDE overlay\n- model default\n",
    );
    const check = checkAgentsCanonical(dir);
    expect(check.passed).toBe(true);
    expect(check.name).toBe("agent_context.agents_md_canonical");
  });

  it("warns when CLAUDE.md imports AGENTS.md but ALSO restates a shared section (import is necessary, not sufficient)", async () => {
    await writeFile(
      join(dir, "AGENTS.md"),
      "# AGENTS\n\n## Change Discipline\nno backcompat shortcuts\n\n## Non-Negotiable Rules\nrun gates\n",
    );
    await writeFile(
      join(dir, "CLAUDE.md"),
      // imports AGENTS.md, but a large standalone body still restates doctrine
      "@AGENTS.md\n\n# CLAUDE overlay\n\n## Model + thinking defaults\nopus\n\n## Change Discipline\nstale divergent copy\n",
    );
    const check = checkAgentsCanonical(dir);
    expect(check.passed).toBe(false); // import alone must not green-light drift
    expect(check.optional).toBe(true); // still non-blocking
    expect(check.detail).toMatch(/Change Discipline/);
    expect(check.remediation).toMatch(/duplicated|import/i);
  });

  it("does NOT count a shared heading that appears only inside a fenced code block", async () => {
    await writeFile(
      join(dir, "AGENTS.md"),
      "# AGENTS\n\n## Change Discipline\nx\n",
    );
    await writeFile(
      join(dir, "CLAUDE.md"),
      "@AGENTS.md\n\n## Claude Code tooling\nExample doctrine heading:\n```md\n## Change Discipline\n```\n",
    );
    expect(checkAgentsCanonical(dir).passed).toBe(true);
  });

  it("warns (non-blocking) when CLAUDE.md carries standalone doctrine", async () => {
    await writeFile(join(dir, "AGENTS.md"), "# AGENTS\nuniversal doctrine\n");
    await writeFile(
      join(dir, "CLAUDE.md"),
      "# CLAUDE\nstandalone rule not in AGENTS.md\n",
    );
    const check = checkAgentsCanonical(dir);
    expect(check.passed).toBe(false);
    expect(check.optional).toBe(true); // does NOT fail the gate
    expect(check.remediation).toMatch(/canonical/i);
  });

  it("passes when CLAUDE.md is a symlink to AGENTS.md, even when AGENTS.md has H2 sections", async () => {
    // Regression: the symlink is the strongest overlay (identical content), but
    // reading through it makes every AGENTS.md heading look "duplicated" — so the
    // duplication check must be short-circuited for the symlink case. AGENTS.md
    // MUST carry a real H2 here to exercise that path.
    await writeFile(
      join(dir, "AGENTS.md"),
      "# AGENTS\n\n## Non-Negotiable Rules\nrun gates\n\n## Change Discipline\nno backcompat\n",
    );
    await symlink("AGENTS.md", join(dir, "CLAUDE.md"));
    expect(checkAgentsCanonical(dir).passed).toBe(true);
  });

  it("passes when AGENTS.md is the sole contract (no CLAUDE.md)", async () => {
    await writeFile(join(dir, "AGENTS.md"), "# AGENTS\n");
    expect(checkAgentsCanonical(dir).passed).toBe(true);
  });

  it("does NOT count an @AGENTS.md mention inside a code block as an import", async () => {
    await writeFile(join(dir, "AGENTS.md"), "# AGENTS\n");
    await writeFile(
      join(dir, "CLAUDE.md"),
      "# CLAUDE\nWrite the import like:\n```\n@AGENTS.md\n```\nbut this file does not actually import it.\n",
    );
    const check = checkAgentsCanonical(dir);
    expect(check.passed).toBe(false);
    expect(check.optional).toBe(true);
  });

  it("is not applicable when AGENTS.md is absent (passes, optional)", async () => {
    await writeFile(join(dir, "CLAUDE.md"), "# CLAUDE\n");
    const check = checkAgentsCanonical(dir);
    expect(check.passed).toBe(true);
    expect(check.optional).toBe(true);
  });
});
