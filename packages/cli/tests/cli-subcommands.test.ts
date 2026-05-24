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

describe("df CLI — Phase D subcommands (services #6 + #8)", () => {
  it("--help lists Phase D subcommands", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df audit stats");
    expect(r.stdout).toContain("df admit-pr");
  });

  it("audit --help prints subcommand help", async () => {
    const r = await runDfCli(["audit", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df audit");
    expect(r.stdout).toContain("stats");
  });

  it("audit stats with no NDJSON exits 1 with a clear error", async () => {
    // Run from a tmp dir so there is no .git/agent-reviews around.
    const tmp = await new Promise<string>((res) => {
      // tiny helper — avoid a Node.js fs import for one path.
      res("/tmp");
    });
    const r = await new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [CLI_PATH, "audit", "stats"], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: tmp,
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
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no audit trail found");
  });

  it("audit stats reads a supplied --path", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "df-cli-audit-"));
    const ndjson = join(tmp, "_runs.ndjson");
    writeFileSync(
      ndjson,
      JSON.stringify({ event: "gate_passed" }) +
        "\n" +
        JSON.stringify({ event: "gate_bypassed", bypassReason: "test" }) +
        "\n",
      "utf8",
    );
    const r = await runDfCli(["audit", "stats", "--path", ndjson]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("gate passes:       1");
    expect(r.stdout).toContain("gate bypasses:     1");
  });

  it("admit-pr --help prints classifier docs", async () => {
    const r = await runDfCli(["admit-pr", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("admit-pr");
    expect(r.stdout).toContain("plan");
    expect(r.stdout).toContain("code");
  });

  it("admit-pr --files classifies a pure cycle doc as plan", async () => {
    const r = await runDfCli([
      "admit-pr",
      "--files",
      "docs/roadmap/cycles/cycle331.md",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("plan");
  });

  it("admit-pr --files classifies a code PR as code", async () => {
    const r = await runDfCli([
      "admit-pr",
      "--files",
      "docs/roadmap/cycles/cycle331.md,packages/cli/src/cli.ts",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("code");
  });

  it("admit-pr without flags exits 2 with usage hint", async () => {
    const r = await runDfCli(["admit-pr"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--files-stdin");
  });
});

describe("df CLI — Phase E reusable-workflow stubs", () => {
  // Phase E ships `status-check` and `critic` as exit-0 stubs so the five
  // reusable workflow shapes can satisfy dark-factory's own main1 ruleset
  // (`PR Status Check`, `agent-critic`) while real implementations land
  // in later phases. These tests pin the contract: stubs must exit 0
  // and surface a structured no-op message so reviewers can tell the
  // stub apart from real work — see cycle 331.1 Phase E in
  // docs/roadmap/cycles/cycle331.1-extract-from-sage3c.md.
  it("--help lists Phase E stubs", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df status-check");
    expect(r.stdout).toContain("df critic");
  });

  it("status-check exits 0 with a no-op stub message", async () => {
    const r = await runDfCli(["status-check"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no-op stub");
  });

  it("status-check ignores arbitrary trailing args (aggregator contract)", async () => {
    const r = await runDfCli(["status-check", "--pr-number", "42", "extra"]);
    expect(r.exitCode).toBe(0);
  });

  it("critic exits 0 with a no-op stub message + Phase F pointer", async () => {
    const r = await runDfCli(["critic"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no-op stub");
    expect(r.stdout).toContain("Phase F");
  });

  it("critic ignores arbitrary trailing args", async () => {
    const r = await runDfCli([
      "critic",
      "--config",
      "darkfactory.yaml",
      "--critics",
      "cursor,codex",
    ]);
    expect(r.exitCode).toBe(0);
  });
});
