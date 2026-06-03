// Unit tests for the `darkfactory.yaml` loader.
//
// Pins:
//  - Missing file → empty config + isDefault: true (no throw).
//  - Empty file → empty config + isDefault: false (file exists, parses to null).
//  - Malformed YAML → loader throws with a useful prefix.
//  - Schema violation → loader throws with the path of the bad key.
//  - resolveSkillOverrides maps every documented config key to its variable.
//  - enabledSkillNames filters to enabled: true entries.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  enabledSkillNames,
  inferGitOriginOwnerRepo,
  loadDarkFactoryConfig,
  resolveSkillOverrides,
  CONFIG_FILENAME,
} from "../../src/skills/config.js";

describe("loadDarkFactoryConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns isDefault=true when darkfactory.yaml is missing", () => {
    const loaded = loadDarkFactoryConfig(dir);
    expect(loaded.isDefault).toBe(true);
    expect(loaded.config).toEqual({});
    expect(loaded.configPath).toBe(join(dir, CONFIG_FILENAME));
  });

  it("returns isDefault=false for an empty YAML file (file exists, parses to null)", () => {
    writeFileSync(join(dir, CONFIG_FILENAME), "");
    const loaded = loadDarkFactoryConfig(dir);
    expect(loaded.isDefault).toBe(false);
    expect(loaded.config).toEqual({});
  });

  it("parses a full config and returns the structured shape", () => {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      `repo:
  displayName: "Dark Factory Platform"
  slug: "dark-factory-platform"
  ownerRepo: "momentiq-ai/dark-factory-platform"
docs:
  manifesto: "docs/PRINCIPLES.md"
  adrDir: "docs/ADR"
  cycleDocsDir: "docs/roadmap/cycles"
qualityGates:
  - "make quality-gates"
  - "make test"
skills:
  chief-engineer-review:
    enabled: true
  chief-engineer-blitz:
    enabled: false
`,
    );
    const loaded = loadDarkFactoryConfig(dir);
    expect(loaded.isDefault).toBe(false);
    expect(loaded.config.repo?.displayName).toBe("Dark Factory Platform");
    expect(loaded.config.docs?.adrDir).toBe("docs/ADR");
    expect(loaded.config.qualityGates).toEqual([
      "make quality-gates",
      "make test",
    ]);
    expect(loaded.config.skills).toEqual({
      "chief-engineer-review": { enabled: true },
      "chief-engineer-blitz": { enabled: false },
    });
  });

  it("throws on malformed YAML (useful prefix)", () => {
    writeFileSync(join(dir, CONFIG_FILENAME), "foo: [bar\n  baz");
    expect(() => loadDarkFactoryConfig(dir)).toThrow(
      /YAML parse error/,
    );
  });

  it("throws on schema violation (unknown top-level key)", () => {
    // `unknownKey` is not in the schema and the schema is `.strict()`.
    writeFileSync(join(dir, CONFIG_FILENAME), `unknownKey: 1\n`);
    expect(() => loadDarkFactoryConfig(dir)).toThrow(
      /schema validation failed/,
    );
  });
});

describe("resolveSkillOverrides", () => {
  it("maps every documented config key to its install-time variable", () => {
    const overrides = resolveSkillOverrides({
      config: {
        repo: {
          displayName: "DF",
          slug: "df",
          ownerRepo: "momentiq-ai/dark-factory-platform",
        },
        docs: {
          manifesto: "docs/M.md",
          adrDir: "docs/ADR",
          cycleDocsDir: "docs/cycles",
          rfcDir: "docs/rfcs",
          prdDir: "docs/prds",
        },
        agents: { chiefEngineer: ".claude/agents/ce.md" },
        qualityGates: ["make a", "make b"],
        qualityGatesExtras: { apiTypes: "make api" },
        worktreeRoot: ".worktrees",
        agentCommitterOrg: "test-org",
      },
    });
    expect(overrides).toEqual({
      REPO_NAME: "DF",
      REPO_SLUG: "df",
      OWNER_REPO: "momentiq-ai/dark-factory-platform",
      MANIFESTO_PATH: "docs/M.md",
      ADR_DIR: "docs/ADR",
      CYCLE_DOCS_DIR: "docs/cycles",
      RFC_DIR: "docs/rfcs",
      PRD_DIR: "docs/prds",
      CE_AGENT_PATH: ".claude/agents/ce.md",
      QUALITY_GATE_TARGETS: ["make a", "make b"],
      API_TYPES_TARGET: "make api",
      WORKTREE_ROOT: ".worktrees",
      AGENT_COMMITTER_ORG: "test-org",
    });
  });

  it("returns an empty overrides map for an empty config + no repoRoot", () => {
    expect(resolveSkillOverrides({ config: {} })).toEqual({});
  });

  it("omits QUALITY_GATE_TARGETS when the config supplies an empty array (manifest default wins)", () => {
    const overrides = resolveSkillOverrides({
      config: { qualityGates: [] },
    });
    expect(overrides.QUALITY_GATE_TARGETS).toBeUndefined();
  });

  it("when yaml missing OWNER_REPO/REPO_SLUG, infers them from git remote origin", () => {
    const dir = mkdtempSync(join(tmpdir(), "df-cfg-git-"));
    try {
      execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
        cwd: dir,
      });
      execFileSync(
        "git",
        [
          "remote",
          "add",
          "origin",
          "git@github.com:some-org/some-repo.git",
        ],
        { cwd: dir },
      );
      const overrides = resolveSkillOverrides({
        config: {},
        repoRoot: dir,
      });
      expect(overrides.OWNER_REPO).toBe("some-org/some-repo");
      expect(overrides.REPO_SLUG).toBe("some-repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("yaml repo.ownerRepo wins over git remote inference", () => {
    const dir = mkdtempSync(join(tmpdir(), "df-cfg-git-"));
    try {
      execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
        cwd: dir,
      });
      execFileSync(
        "git",
        [
          "remote",
          "add",
          "origin",
          "https://github.com/other-org/other-repo.git",
        ],
        { cwd: dir },
      );
      const overrides = resolveSkillOverrides({
        config: { repo: { ownerRepo: "explicit/wins" } },
        repoRoot: dir,
      });
      expect(overrides.OWNER_REPO).toBe("explicit/wins");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("inferGitOriginOwnerRepo", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "df-git-infer-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when not a git repo", () => {
    expect(inferGitOriginOwnerRepo(dir)).toBeNull();
  });

  it("returns null when git repo has no origin remote", () => {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: dir,
    });
    expect(inferGitOriginOwnerRepo(dir)).toBeNull();
  });

  it("parses git@github.com:owner/repo.git form", () => {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: dir,
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:momentiq-ai/dark-factory.git"],
      { cwd: dir },
    );
    expect(inferGitOriginOwnerRepo(dir)).toBe("momentiq-ai/dark-factory");
  });

  it("parses https://github.com/owner/repo.git form", () => {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: dir,
    });
    execFileSync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://github.com/some-org/some-repo.git",
      ],
      { cwd: dir },
    );
    expect(inferGitOriginOwnerRepo(dir)).toBe("some-org/some-repo");
  });

  it("strips trailing .git extension", () => {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: dir,
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://github.com/o/r.git"],
      { cwd: dir },
    );
    expect(inferGitOriginOwnerRepo(dir)).toBe("o/r");
  });

  it("handles ssh url without .git suffix", () => {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: dir,
    });
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:o/r"],
      { cwd: dir },
    );
    expect(inferGitOriginOwnerRepo(dir)).toBe("o/r");
  });
});

describe("enabledSkillNames", () => {
  it("returns only entries with enabled: true", () => {
    expect(
      enabledSkillNames({
        skills: {
          a: { enabled: true },
          b: { enabled: false },
          c: { enabled: true },
          d: {},
        },
      }),
    ).toEqual(["a", "c"]);
  });

  it("returns [] when no skills key is present", () => {
    expect(enabledSkillNames({})).toEqual([]);
  });
});
