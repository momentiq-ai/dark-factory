// `df onboard` CLI smoke tests — Phase A surface only.
//
// Mirror the upstream pattern (tests/cli-help.test.ts,
// tests/cli-subcommands.test.ts): spawn the BUILT binary in dist/ so
// these assertions cover the final shipped artifact, including the
// commands/onboard.ts → cli.ts wire-up.
import { spawn } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "..", "dist", "cli.js");
const ex = promisify(execFile);

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runDfCli(args: string[]): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => rejectPromise(err));
    child.on("close", (code) => {
      resolvePromise({ exitCode: code === null ? -1 : code, stdout, stderr });
    });
  });
}

describe("df onboard CLI (Phase A)", () => {
  it("--analysis-only --json emits a valid JSON to stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-onboard-cli-"));
    try {
      // Need a git repo so the git analyzer doesn't return null and the
      // CLI exits cleanly; the human summary path also depends on it.
      await ex("git", ["init", "-b", "main"], { cwd: root });
      await ex("git", ["config", "user.email", "t@x"], { cwd: root });
      await ex("git", ["config", "user.name", "T"], { cwd: root });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "x" }));
      await ex("git", ["add", "."], { cwd: root });
      await ex("git", ["commit", "-m", "feat: bootstrap"], { cwd: root });

      const r = await runDfCli(["onboard", "--analysis-only", "--json", root]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.repoRoot).toBe(root);
      expect(Array.isArray(parsed.stacks)).toBe(true);
      expect(parsed.stacks.some((s: { language: string }) => s.language === "typescript")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("without --analysis-only, exits 1 with a 'Phase A only' message", async () => {
    const r = await runDfCli(["onboard"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Phase A only");
  });

  it("--help prints the usage and exits 0", async () => {
    const r = await runDfCli(["onboard", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df onboard");
    expect(r.stdout).toContain("--analysis-only");
    expect(r.stdout).toContain("--json");
  });

  it("rejects an unknown flag with exit 2", async () => {
    const r = await runDfCli(["onboard", "--bogus"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown flag");
  });

  it("without --json, writes a human summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-onboard-cli-"));
    try {
      await ex("git", ["init", "-b", "main"], { cwd: root });
      await ex("git", ["config", "user.email", "t@x"], { cwd: root });
      await ex("git", ["config", "user.name", "T"], { cwd: root });
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "x" }));
      await ex("git", ["add", "."], { cwd: root });
      await ex("git", ["commit", "-m", "feat: bootstrap"], { cwd: root });

      const r = await runDfCli(["onboard", "--analysis-only", root]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Repo:");
      expect(r.stdout).toContain("Stacks:");
      expect(r.stdout).toContain("DF gate:");
      expect(r.stdout).toContain("Agent context set:");
      // Not JSON
      expect(() => JSON.parse(r.stdout)).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
