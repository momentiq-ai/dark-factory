// Behavioral tests for `df skills install/list` — exercise the cmdSkills
// surface end-to-end so we pin the CLI's exit-code contract + the
// up-front argument validation (findings 4 + 9 of PR #119 review).
//
// We invoke cmdSkills directly with argv pieces and a fake IO so we can
// assert on stderr without spawning a child process. The underlying
// installSkill is the real bundled one (tests/skills/install.test.ts
// owns its deep behavioral coverage).

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdSkills } from "../../src/commands/skills.js";

interface CapturedIo {
  stdout: string[];
  stderr: string[];
}

function makeIo(): CapturedIo & {
  stdoutFn: (s: string) => void;
  stderrFn: (s: string) => void;
} {
  const captured: CapturedIo = { stdout: [], stderr: [] };
  return {
    ...captured,
    stdoutFn: (s) => captured.stdout.push(s),
    stderrFn: (s) => captured.stderr.push(s),
  };
}

async function runSkills(
  args: string[],
  cwd: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const io = makeIo();
  const originalCwd = process.cwd();
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  process.chdir(cwd);
  process.stdout.write = ((chunk: string) => {
    io.stdoutFn(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    io.stderrFn(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = await cmdSkills(args);
    return {
      exit,
      stdout: io.stdout.join(""),
      stderr: io.stderr.join(""),
    };
  } finally {
    process.chdir(originalCwd);
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

describe("df skills install — argument validation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-skills-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects --all with an unknown skill key in darkfactory.yaml BEFORE installing any skill (finding 4)", async () => {
    writeFileSync(
      join(dir, "darkfactory.yaml"),
      `skills:
  chief-engineer-review:
    enabled: true
  not-a-real-skill:
    enabled: true
  chief-engineer-blitz:
    enabled: true
`,
    );
    const { exit, stderr } = await runSkills(["install", "--all"], dir);
    expect(exit).not.toBe(0);
    expect(stderr).toMatch(/not-a-real-skill|unknown skill/i);
    // CRITICAL: no skill should have been installed (no .claude/skills/<name>/
    // directory should exist because the validation runs BEFORE any install).
    expect(
      existsSync(join(dir, ".claude", "skills", "chief-engineer-review")),
    ).toBe(false);
    expect(
      existsSync(join(dir, ".claude", "skills", "chief-engineer-blitz")),
    ).toBe(false);
  });

  it("--all with only KNOWN_SKILLS enabled installs successfully", async () => {
    writeFileSync(
      join(dir, "darkfactory.yaml"),
      `skills:
  chief-engineer-review:
    enabled: true
  chief-engineer-blitz:
    enabled: true
`,
    );
    const { exit, stderr } = await runSkills(["install", "--all"], dir);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    expect(
      existsSync(join(dir, ".claude", "skills", "chief-engineer-review", "SKILL.md")),
    ).toBe(true);
    expect(
      existsSync(join(dir, ".claude", "skills", "chief-engineer-blitz", "SKILL.md")),
    ).toBe(true);
  });

  it("rejects --all with --target-dir because multiple skills with target SKILL.md would collide (finding 9)", async () => {
    writeFileSync(
      join(dir, "darkfactory.yaml"),
      `skills:
  chief-engineer-review:
    enabled: true
  chief-engineer-blitz:
    enabled: true
`,
    );
    const collisionDir = mkdtempSync(join(tmpdir(), "df-skills-target-"));
    try {
      const { exit, stderr } = await runSkills(
        ["install", "--all", "--target-dir", collisionDir],
        dir,
      );
      expect(exit).not.toBe(0);
      expect(stderr).toMatch(/--all|--target-dir|incompat|collide|overwrite/i);
      // No SKILL.md should have landed (a prior buggy implementation would
      // install the second on top of the first; this guarantees neither is
      // attempted).
      expect(existsSync(join(collisionDir, "SKILL.md"))).toBe(false);
    } finally {
      rmSync(collisionDir, { recursive: true, force: true });
    }
  });

  it("--target-dir without --all (single skill) still works", async () => {
    const customDir = mkdtempSync(join(tmpdir(), "df-skills-target-"));
    try {
      const { exit } = await runSkills(
        ["install", "chief-engineer-blitz", "--target-dir", customDir],
        dir,
      );
      expect(exit).toBe(0);
      expect(existsSync(join(customDir, "SKILL.md"))).toBe(true);
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });
});
