import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCopyArgs,
  buildUpdateArgs,
  verifyDestinationIsBundledTemplate,
} from "../src/copier.js";

describe("buildCopyArgs", () => {
  // The whole point of this test file: the bundled sage-blueprint
  // template uses Copier `_tasks` (npm install, lockfile generation,
  // formatter passes). Copier 9+ refuses templates with `_tasks`
  // unless `--trust` is explicitly passed, so the sage-cli wrapper
  // MUST emit `--trust` on every spawn. See
  // https://github.com/momentiq-ai/dark-factory/issues/153 for the
  // failure mode that motivated this regression test.
  it("always includes --trust", () => {
    const args = buildCopyArgs({
      templatePath: "/abs/template",
      destination: "/abs/dest",
      data: {},
    });
    expect(args).toContain("--trust");
  });

  it("starts with the copy subcommand + template + destination", () => {
    const args = buildCopyArgs({
      templatePath: "/abs/template",
      destination: "/abs/dest",
      data: {},
    });
    expect(args.slice(0, 3)).toEqual(["copy", "/abs/template", "/abs/dest"]);
  });

  it("appends --defaults when acceptDefaults is true", () => {
    const args = buildCopyArgs({
      templatePath: "/abs/template",
      destination: "/abs/dest",
      data: {},
      acceptDefaults: true,
    });
    expect(args).toContain("--defaults");
  });

  it("omits --defaults when acceptDefaults is false or unset", () => {
    const args = buildCopyArgs({
      templatePath: "/abs/template",
      destination: "/abs/dest",
      data: {},
    });
    expect(args).not.toContain("--defaults");
  });

  it("appends --vcs-ref <ref> when vcsRef is provided", () => {
    const args = buildCopyArgs({
      templatePath: "/abs/template",
      destination: "/abs/dest",
      data: {},
      vcsRef: "HEAD",
    });
    const idx = args.indexOf("--vcs-ref");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("HEAD");
  });

  it("appends --data key=value for each entry, coercing non-strings", () => {
    const args = buildCopyArgs({
      templatePath: "/abs/template",
      destination: "/abs/dest",
      data: { name: "smoke", count: 3, flag: false },
    });
    const dataPairs: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--data") dataPairs.push(args[i + 1] ?? "");
    }
    expect(dataPairs).toEqual(
      expect.arrayContaining(["name=smoke", "count=3", "flag=false"]),
    );
  });

  it("trust + defaults + vcs-ref + data all compose into one argv", () => {
    const args = buildCopyArgs({
      templatePath: "/abs/template",
      destination: "/abs/dest",
      data: { product: "demo" },
      acceptDefaults: true,
      vcsRef: "HEAD",
    });
    expect(args).toContain("--trust");
    expect(args).toContain("--defaults");
    expect(args).toContain("--vcs-ref");
    expect(args).toContain("--data");
  });
});

describe("buildUpdateArgs", () => {
  it("always includes --trust", () => {
    const args = buildUpdateArgs({ destination: "/abs/dest" });
    expect(args).toContain("--trust");
  });

  it("starts with the update subcommand", () => {
    const args = buildUpdateArgs({ destination: "/abs/dest" });
    expect(args[0]).toBe("update");
  });

  it("appends --pretend when dryRun is true", () => {
    const args = buildUpdateArgs({ destination: "/abs/dest", dryRun: true });
    expect(args).toContain("--pretend");
  });

  it("omits --pretend when dryRun is false or unset", () => {
    const args = buildUpdateArgs({ destination: "/abs/dest" });
    expect(args).not.toContain("--pretend");
  });
});

describe("verifyDestinationIsBundledTemplate", () => {
  // Defense-in-depth against the round-1 [high] security finding on
  // PR #156: runCopierUpdate passes --trust to copier, which grants
  // the template's _tasks shell-exec privileges. Without verifying
  // that the destination's recorded _src_path points to the template
  // this CLI bundled, a malicious actor could redirect _src_path in
  // .copier-answers.yml to a hostile template and --trust would
  // happily run its _tasks. The verifier is the trust boundary.
  let tmpDir: string;
  let trustedTemplate: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sage-verify-"));
    trustedTemplate = join(tmpDir, "bundled-template");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws when .copier-answers.yml is missing", () => {
    const dest = join(tmpDir, "no-answers");
    expect(() => verifyDestinationIsBundledTemplate(dest, trustedTemplate)).toThrow(
      /no \.copier-answers\.yml/i,
    );
  });

  it("throws when _src_path is missing from the answers file", () => {
    const dest = join(tmpDir, "no-srcpath");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, ".copier-answers.yml"), "_commit: abc123\nname: foo\n");
    expect(() => verifyDestinationIsBundledTemplate(dest, trustedTemplate)).toThrow(
      /no _src_path/i,
    );
  });

  it("throws when _src_path is a hostile URL", () => {
    const dest = join(tmpDir, "url");
    mkdirSync(dest, { recursive: true });
    writeFileSync(
      join(dest, ".copier-answers.yml"),
      '_src_path: "https://evil.example.com/hostile-template"\n_commit: abc\n',
    );
    expect(() => verifyDestinationIsBundledTemplate(dest, trustedTemplate)).toThrow(
      /does not match this CLI's bundled/i,
    );
  });

  it("throws when _src_path is an unrelated absolute path", () => {
    const dest = join(tmpDir, "evil-path");
    mkdirSync(dest, { recursive: true });
    writeFileSync(
      join(dest, ".copier-answers.yml"),
      '_src_path: "/tmp/evil-template"\n_commit: abc\n',
    );
    expect(() => verifyDestinationIsBundledTemplate(dest, trustedTemplate)).toThrow(
      /does not match this CLI's bundled/i,
    );
  });

  it("returns normally when _src_path resolves to the trusted bundled template", () => {
    const dest = join(tmpDir, "happy");
    mkdirSync(dest, { recursive: true });
    writeFileSync(
      join(dest, ".copier-answers.yml"),
      `_src_path: "${trustedTemplate}"\n_commit: abc123\n`,
    );
    expect(() => verifyDestinationIsBundledTemplate(dest, trustedTemplate)).not.toThrow();
  });

  it("accepts a relative _src_path that resolves to the trusted template", () => {
    // Copier may record _src_path as relative to the destination. Use
    // resolvePath semantics so legitimate relative paths still match.
    const dest = join(tmpDir, "relative");
    mkdirSync(dest, { recursive: true });
    // dest is <tmpDir>/relative; trustedTemplate is <tmpDir>/bundled-template;
    // so ../bundled-template from dest resolves to trustedTemplate.
    writeFileSync(
      join(dest, ".copier-answers.yml"),
      '_src_path: "../bundled-template"\n_commit: abc123\n',
    );
    expect(() => verifyDestinationIsBundledTemplate(dest, trustedTemplate)).not.toThrow();
  });

  it("throws on a YAML parse error", () => {
    const dest = join(tmpDir, "bad-yaml");
    mkdirSync(dest, { recursive: true });
    // Unbalanced quote -> YAML parse failure.
    writeFileSync(join(dest, ".copier-answers.yml"), '_src_path: "unterminated\n');
    expect(() => verifyDestinationIsBundledTemplate(dest, trustedTemplate)).toThrow(
      /failed to parse/i,
    );
  });
});
