// Gold-file test for `df --help` (issue #89).
//
// Pins the user-facing help text against silent re-introduction of
// internal cycle framing. The Status paragraph that printHelp() used to
// emit referenced "Phase A-G", the private `sage3c` repo, and a
// hardcoded `0.1.0-alpha.6` version that drifted from the shipped
// artifact's actual `1.0.0`. Bot reviewers (Cursor Bugbot / Codex) flag
// every PR that re-introduces those tokens; this test catches it before
// the PR opens.
//
// Approach: spawn the built binary (so cli.ts → dist/cli.js → the same
// stdout users see), capture --help, and assert:
//
//   1. Negative — none of the forbidden substrings appear anywhere in
//      the help text:
//        - `sage3c`       (private upstream repo, scrubbed in PR #88)
//        - `Phase [A-Z]`  (internal extraction cycle framing)
//        - `alpha`        (lies about the shipped artifact's stability)
//   2. Positive — the help text sources its version from meta.version
//      (matched by the same regex as `--version`'s output), confirming
//      no hardcoded version string snuck back in.
//   3. Positive — the help text references the docs URL, confirming
//      the operator has a way to go deeper.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "dist", "cli.js");
const PKG_PATH = resolve(HERE, "..", "package.json");

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

describe("df --help — user-facing surface scrub (issue #89)", () => {
  it("never references the private upstream `sage3c` repo", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/sage3c/i);
  });

  it("never references internal `Phase A-Z` extraction framing", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    // `Phase ` followed by a single capital letter — the internal
    // cycle-extraction labels (Phase A, Phase B-PUBLISH, Phase F-LOCAL,
    // etc.). External users have no context for these.
    expect(r.stdout).not.toMatch(/\bPhase [A-Z]\b/);
  });

  it("never claims the shipped artifact is `alpha`", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/alpha/i);
  });

  it("sources the printed version from package.json meta", async () => {
    const r = await runDfCli(["--help"]);
    const meta = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
      version?: string;
    };
    expect(typeof meta.version).toBe("string");
    expect(r.exitCode).toBe(0);
    // Version must appear at least once in the help text (the header)
    // and must match what --version prints.
    expect(r.stdout).toContain(meta.version as string);
    const versionResult = await runDfCli(["--version"]);
    expect(versionResult.stdout.trim()).toBe(meta.version);
  });

  it("points operators at the docs URL", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("https://github.com/momentiq-ai/dark-factory");
  });

  it("lists `df show` and `df status` as available subcommands (closes #55 surface)", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df show");
    expect(r.stdout).toContain("df status");
  });
});

describe("notImplemented (issue #89)", () => {
  it("the unknown-subcommand error message has no Phase labels or `alpha`", async () => {
    const r = await runDfCli(["definitely-not-a-real-subcommand-x"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not implemented");
    expect(r.stderr).not.toMatch(/\bPhase [A-Z]\b/);
    expect(r.stderr).not.toMatch(/alpha/i);
    expect(r.stderr).not.toMatch(/sage3c/i);
    // Points to the issue tracker per the issue #89 ask.
    expect(r.stderr).toContain("https://github.com/momentiq-ai/dark-factory");
  });
});
