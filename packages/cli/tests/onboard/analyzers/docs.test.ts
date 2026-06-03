// packages/cli/tests/onboard/analyzers/docs.test.ts
//
// Cycle 15 Phase A — Task 8 tests. Pins the schema-shape contract from
// schema.ts (docs.{existing, hasClaudeMd, hasAgentsMd, agentContextSetPresent,
// claudeMd, agentsMd} and dfPresence.{hooks, configJson, prWorkflow, cliPin}),
// plus the heading-extraction edge cases (>50 truncation, fenced code blocks).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsAnalyzer } from "../../../src/onboard/analyzers/docs.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "docs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("docsAnalyzer", () => {
  it("returns empty/false shape for a bare repo (no docs, no DF)", async () => {
    const r = await docsAnalyzer.detect(root);
    expect(r?.docs?.existing).toEqual([]);
    expect(r?.docs?.hasClaudeMd).toBe(false);
    expect(r?.docs?.hasAgentsMd).toBe(false);
    expect(r?.docs?.agentContextSetPresent).toBe(false);
    expect(r?.docs?.claudeMd).toBeNull();
    expect(r?.docs?.agentsMd).toBeNull();
    expect(r?.dfPresence?.hooks).toBe(false);
    expect(r?.dfPresence?.configJson).toBe(false);
    expect(r?.dfPresence?.prWorkflow).toBe(false);
    expect(r?.dfPresence?.cliPin).toBeNull();
  });

  it("populates docs.existing with root README and docs/**/*.md", async () => {
    await writeFile(join(root, "README.md"), "# readme");
    await mkdir(join(root, "docs", "guides"), { recursive: true });
    await writeFile(join(root, "docs", "architecture.md"), "# arch");
    await writeFile(join(root, "docs", "guides", "howto.md"), "# howto");
    const r = await docsAnalyzer.detect(root);
    expect(r?.docs?.existing).toEqual([
      "README.md",
      "docs/architecture.md",
      "docs/guides/howto.md",
    ]);
  });

  it("sets hasClaudeMd=true and populates claudeMd envelope when CLAUDE.md exists alone", async () => {
    const body = "# Title\n\nintro\n\n## Section A\n\nbody\n\n## Section B\n";
    await writeFile(join(root, "CLAUDE.md"), body);
    const r = await docsAnalyzer.detect(root);
    expect(r?.docs?.hasClaudeMd).toBe(true);
    expect(r?.docs?.hasAgentsMd).toBe(false);
    expect(r?.docs?.claudeMd).toEqual({
      sizeBytes: Buffer.byteLength(body, "utf8"),
      headings: ["Title", "Section A", "Section B"],
    });
    expect(r?.docs?.agentsMd).toBeNull();
    // CLAUDE.md alone is not enough for agentContextSetPresent — needs AGENTS.md
    // and a docs/ entry too.
    expect(r?.docs?.agentContextSetPresent).toBe(false);
  });

  it("agentContextSetPresent is false when AGENTS.md is missing", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# c");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "x.md"), "# x");
    const r = await docsAnalyzer.detect(root);
    expect(r?.docs?.agentContextSetPresent).toBe(false);
  });

  it("agentContextSetPresent is false when CLAUDE.md is missing", async () => {
    await writeFile(join(root, "AGENTS.md"), "# a");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "x.md"), "# x");
    const r = await docsAnalyzer.detect(root);
    expect(r?.docs?.agentContextSetPresent).toBe(false);
  });

  it("agentContextSetPresent is false when no docs/ entries exist", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# c");
    await writeFile(join(root, "AGENTS.md"), "# a");
    const r = await docsAnalyzer.detect(root);
    expect(r?.docs?.agentContextSetPresent).toBe(false);
  });

  it("agentContextSetPresent is true when all three conditions are met", async () => {
    await writeFile(join(root, "CLAUDE.md"), "# c");
    await writeFile(join(root, "AGENTS.md"), "# a");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "x.md"), "# x");
    const r = await docsAnalyzer.detect(root);
    expect(r?.docs?.agentContextSetPresent).toBe(true);
    expect(r?.docs?.hasClaudeMd).toBe(true);
    expect(r?.docs?.hasAgentsMd).toBe(true);
  });

  it("cliPin parses from dependencies", async () => {
    const pkg = {
      name: "x",
      dependencies: { "@momentiq/dark-factory-cli": "1.0.0" },
    };
    await writeFile(join(root, "package.json"), JSON.stringify(pkg));
    const r = await docsAnalyzer.detect(root);
    expect(r?.dfPresence?.cliPin).toBe("1.0.0");
  });

  it("cliPin parses from devDependencies when not in dependencies", async () => {
    const pkg = {
      name: "x",
      devDependencies: { "@momentiq/dark-factory-cli": "^0.4.0-alpha.9" },
    };
    await writeFile(join(root, "package.json"), JSON.stringify(pkg));
    const r = await docsAnalyzer.detect(root);
    expect(r?.dfPresence?.cliPin).toBe("^0.4.0-alpha.9");
  });

  it("cliPin prefers dependencies over devDependencies when both present", async () => {
    const pkg = {
      name: "x",
      dependencies: { "@momentiq/dark-factory-cli": "2.0.0" },
      devDependencies: { "@momentiq/dark-factory-cli": "1.0.0" },
    };
    await writeFile(join(root, "package.json"), JSON.stringify(pkg));
    const r = await docsAnalyzer.detect(root);
    expect(r?.dfPresence?.cliPin).toBe("2.0.0");
  });

  it("cliPin is null when package.json lacks the CLI dependency", async () => {
    const pkg = { name: "x", dependencies: { other: "1.0.0" } };
    await writeFile(join(root, "package.json"), JSON.stringify(pkg));
    const r = await docsAnalyzer.detect(root);
    expect(r?.dfPresence?.cliPin).toBeNull();
  });

  it("truncates the heading list at 50 with no error on > 50 H1+H2 lines", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(`# heading ${i}`);
    const body = lines.join("\n") + "\n";
    await writeFile(join(root, "CLAUDE.md"), body);
    const r = await docsAnalyzer.detect(root);
    expect(r?.docs?.claudeMd?.headings.length).toBe(50);
    expect(r?.docs?.claudeMd?.headings[0]).toBe("heading 0");
    expect(r?.docs?.claudeMd?.headings[49]).toBe("heading 49");
    expect(r?.docs?.claudeMd?.sizeBytes).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("ignores `# foo` lines inside fenced code blocks", async () => {
    const body = [
      "# real heading 1",
      "",
      "```bash",
      "# not a heading",
      "## also not a heading",
      "```",
      "",
      "## real heading 2",
      "",
      "```",
      "# still not a heading",
      "```",
      "",
      "# real heading 3",
      "",
    ].join("\n");
    await writeFile(join(root, "CLAUDE.md"), body);
    const r = await docsAnalyzer.detect(root);
    expect(r?.docs?.claudeMd?.headings).toEqual([
      "real heading 1",
      "real heading 2",
      "real heading 3",
    ]);
  });

  it("dfPresence.hooks flips true when .husky/ exists", async () => {
    await mkdir(join(root, ".husky"), { recursive: true });
    const r = await docsAnalyzer.detect(root);
    expect(r?.dfPresence?.hooks).toBe(true);
    expect(r?.dfPresence?.configJson).toBe(false);
    expect(r?.dfPresence?.prWorkflow).toBe(false);
  });

  it("dfPresence.configJson flips true when .agent-review/config.json exists", async () => {
    await mkdir(join(root, ".agent-review"), { recursive: true });
    await writeFile(join(root, ".agent-review", "config.json"), "{}");
    const r = await docsAnalyzer.detect(root);
    expect(r?.dfPresence?.configJson).toBe(true);
    expect(r?.dfPresence?.hooks).toBe(false);
    expect(r?.dfPresence?.prWorkflow).toBe(false);
  });

  it("dfPresence.prWorkflow flips true when the gate workflow file exists", async () => {
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(root, ".github", "workflows", "dark-factory-pr.yml"),
      "name: df\n",
    );
    const r = await docsAnalyzer.detect(root);
    expect(r?.dfPresence?.prWorkflow).toBe(true);
    expect(r?.dfPresence?.hooks).toBe(false);
    expect(r?.dfPresence?.configJson).toBe(false);
  });

  it("agentsMd envelope is populated when AGENTS.md exists", async () => {
    const body = "# A title\n\n## sub\n";
    await writeFile(join(root, "AGENTS.md"), body);
    const r = await docsAnalyzer.detect(root);
    expect(r?.docs?.hasAgentsMd).toBe(true);
    expect(r?.docs?.agentsMd).toEqual({
      sizeBytes: Buffer.byteLength(body, "utf8"),
      headings: ["A title", "sub"],
    });
  });
});
