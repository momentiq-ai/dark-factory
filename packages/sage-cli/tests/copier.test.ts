import { describe, expect, it } from "vitest";

import { buildCopyArgs, buildUpdateArgs } from "../src/copier.js";

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
