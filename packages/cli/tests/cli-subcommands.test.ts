// CLI integration smoke test — verifies the `df` binary in `dist/` wires
// each Phase C subcommand to its Python wrapper and propagates exit codes.
//
// Spawns the compiled binary directly so this fails closed if the
// post-build copy-assets step is broken.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "dist", "cli.js");

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

describe("df CLI — Phase C subcommands", () => {
  it("--version prints semver", async () => {
    const r = await runDfCli(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help lists Phase C subcommands", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("validate-cycle-doc");
    expect(r.stdout).toContain("audit-branch-protection");
    expect(r.stdout).toContain("sync-trackers");
    expect(r.stdout).toContain("attribute-pr");
  });

  it("validate-cycle-doc --help forwards to Python and exits 0", async () => {
    const r = await runDfCli(["validate-cycle-doc", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("usage: validate_cycle_doc.py");
  });

  it("audit-branch-protection --help forwards to Python and exits 0", async () => {
    const r = await runDfCli(["audit-branch-protection", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("usage: audit_branch_protection.py");
  });

  it("sync-trackers --help forwards to Python and exits 0", async () => {
    const r = await runDfCli(["sync-trackers", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("usage: sync_cycle_trackers.py");
  });

  it("unknown subcommand exits 2", async () => {
    const r = await runDfCli(["does-not-exist"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not implemented");
  });
});
