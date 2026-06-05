// Cycle 15 Phase C — function-level unit tests for `checkAgentContextSet()`.
//
// Pins:
//   - Required-files walk runs UNCONDITIONALLY (per Decision #7 round-1).
//   - Missing required files → passed:false + structured remediation pointing
//     at `df onboard --apply`.
//   - cycle1_bootstrap is glob-matched (`cycle1-*.md` under
//     docs/roadmap/cycles/).
//   - When `guidanceFiles` is undefined OR [], the per-path walk is skipped
//     with a single informational marker (agent_context.guidance_not_configured,
//     passed:true, optional:true).
//   - When `guidanceFiles` is non-empty, each path is checked and failures
//     emit `agent_context.guidance_<i>`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkAgentContextSet } from "../../src/onboard/validate.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "validate-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("checkAgentContextSet", () => {
  it("runs the full required-file walk even when guidanceFiles is undefined (Decision #7 round-1 revision)", async () => {
    const checks = await checkAgentContextSet({
      repoRoot: root,
      guidanceFiles: undefined,
    });
    const names = checks.map((c) => c.name);
    // Required files are checked unconditionally — the policy is that a repo
    // without a `context.guidanceFiles` block still fails when CLAUDE.md etc.
    // are missing. The cycle 15 D3 required-files set is the floor.
    expect(names).toEqual(
      expect.arrayContaining([
        "agent_context.claude_md",
        "agent_context.agents_md",
        "agent_context.claude_settings",
        "agent_context.principles",
        "agent_context.cycle1_bootstrap",
        "agent_context.config",
      ]),
    );
    // The guidance walk is skipped with a single informational marker — NOT a
    // replacement for the required walk.
    const informational = checks.find(
      (c) => c.name === "agent_context.guidance_not_configured",
    );
    expect(informational?.passed).toBe(true);
    expect(informational?.optional).toBe(true);
  });

  it("runs the full required-file walk when guidanceFiles is empty array (same behavior as undefined)", async () => {
    const checks = await checkAgentContextSet({
      repoRoot: root,
      guidanceFiles: [],
    });
    const names = checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "agent_context.claude_md",
        "agent_context.agents_md",
        "agent_context.claude_settings",
        "agent_context.principles",
        "agent_context.cycle1_bootstrap",
        "agent_context.config",
      ]),
    );
    // Empty array also skips the per-path walk (with the same informational marker).
    const informational = checks.find(
      (c) => c.name === "agent_context.guidance_not_configured",
    );
    expect(informational?.passed).toBe(true);
  });

  it("each required-file check fails with structured remediation when the file is missing", async () => {
    const checks = await checkAgentContextSet({
      repoRoot: root,
      guidanceFiles: [],
    });
    const claudeCheck = checks.find(
      (c) => c.name === "agent_context.claude_md",
    );
    expect(claudeCheck?.passed).toBe(false);
    expect(claudeCheck?.detail).toContain("CLAUDE.md");
    expect(claudeCheck?.remediation).toContain("df onboard");
  });

  it("each required-file check passes when the file exists", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# claude\n");
    await writeFile(join(root, "AGENTS.md"), "# agents\n");
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.json"), "{}");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "PRINCIPLES.md"), "# principles\n");
    await mkdir(join(root, "docs", "roadmap", "cycles"), { recursive: true });
    await writeFile(
      join(root, "docs", "roadmap", "cycles", "cycle1-myrepo-bootstrap.md"),
      "# cycle 1\n",
    );
    await mkdir(join(root, ".agent-review"), { recursive: true });
    await writeFile(join(root, ".agent-review", "config.json"), "{}");

    const checks = await checkAgentContextSet({
      repoRoot: root,
      guidanceFiles: [],
    });
    const required = checks.filter(
      (c) =>
        c.name.startsWith("agent_context.") &&
        c.name !== "agent_context.guidance_not_configured",
    );
    for (const c of required) {
      expect(c.passed).toBe(true);
    }
  });

  it("matches the cycle1 bootstrap doc by glob (any cycle1-*.md under docs/roadmap/cycles/)", async () => {
    await mkdir(join(root, "docs", "roadmap", "cycles"), { recursive: true });
    await writeFile(
      join(root, "docs", "roadmap", "cycles", "cycle1-some-other-name.md"),
      "# cycle 1\n",
    );

    const checks = await checkAgentContextSet({
      repoRoot: root,
      guidanceFiles: [],
    });
    const c = checks.find((c) => c.name === "agent_context.cycle1_bootstrap");
    expect(c?.passed).toBe(true);
  });

  it("validates each guidance-file path resolves under repoRoot", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# claude\n");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "extra.md"), "# extra\n");

    const checks = await checkAgentContextSet({
      repoRoot: root,
      guidanceFiles: ["CLAUDE.md", "docs/extra.md", "docs/missing.md"],
    });
    const guidanceChecks = checks.filter((c) =>
      c.name.startsWith("agent_context.guidance_"),
    );
    expect(guidanceChecks).toHaveLength(3);
    expect(guidanceChecks[0]?.passed).toBe(true); // CLAUDE.md exists
    expect(guidanceChecks[1]?.passed).toBe(true); // docs/extra.md exists
    expect(guidanceChecks[2]?.passed).toBe(false); // docs/missing.md does not
  });
});
