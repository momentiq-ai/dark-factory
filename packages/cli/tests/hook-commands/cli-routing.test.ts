// Cycle 331.1 Phase F-LOCAL — CLI routing smoke tests for the five
// hook-facing subcommands. Verifies each subcommand exists, its --help
// produces the expected one-liner, and the top-level help lists them
// under the right section.
//
// These are intentionally smoke tests, not end-to-end critic invocations
// (which would need vendor SDKs configured + live network). The
// adapter-level subscription-auth verification lives in the per-adapter
// tests (codex-adapter.test.ts, cursor-adapter.test.ts, etc.) and is
// already covered by the Phase B extraction.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "..", "dist", "cli.js");

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runDfCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
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

describe("top-level help lists the local-critic / hook-facing subcommands", () => {
  it("--help mentions all 5 hook subcommands", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    // Issue #89 scrubbed the internal "Phase F-LOCAL" framing from user-
    // facing text; what matters is that each subcommand is listed by
    // name so operators can find it.
    expect(r.stdout).toContain("df review");
    expect(r.stdout).toContain("df gate-push");
    expect(r.stdout).toContain("df doctor");
    expect(r.stdout).toContain("df gates");
    expect(r.stdout).toContain("df stats");
  });

  it("--help advertises the subscription cost model", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    // The cost-control posture is load-bearing — verify the help text
    // explicitly calls out subscription auth vs API-key fallback.
    expect(r.stdout).toContain("SUBSCRIPTIONS");
    expect(r.stdout).toContain("API key");
  });
});

describe("Phase F-LOCAL — df review", () => {
  it("--help prints the review usage banner", async () => {
    const r = await runDfCli(["review", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df review");
    expect(r.stdout).toContain("--commit");
    expect(r.stdout).toContain("--profile");
    expect(r.stdout).toContain("--foreground");
    // Subscription-auth wording is load-bearing here too.
    expect(r.stdout).toContain("SUBSCRIPTIONS");
  });
});

describe("Phase F-LOCAL — df gate-push", () => {
  it("--help prints the gate-push usage banner with bypass note", async () => {
    const r = await runDfCli(["gate-push", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df gate-push");
    expect(r.stdout).toContain("AGENT_REVIEW_BYPASS");
    expect(r.stdout).toContain("CI replay");
  });

  it("AGENT_REVIEW_BYPASS short-circuits the gate with exit 0", async () => {
    const r = await runDfCli(["gate-push"], {
      AGENT_REVIEW_BYPASS: "test-bypass-for-routing-smoke",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("BYPASSED");
    expect(r.stderr).toContain("test-bypass-for-routing-smoke");
  });

  it("--commit without --ci returns exit 2 (input validation)", async () => {
    const r = await runDfCli(["gate-push", "--commit", "abc1234"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--commit requires --ci");
  });

  it("no stdin push updates exits 0 with allowing message", async () => {
    const r = await runDfCli(["gate-push"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no push updates received");
  });
});

describe("Phase F-LOCAL — df doctor", () => {
  it("--help prints the doctor usage banner", async () => {
    const r = await runDfCli(["doctor", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df doctor");
    // Banner mentions the per-adapter doctor() probe (string wrapped
     // across two lines in the formatted banner).
    expect(r.stdout).toMatch(/per-adapter\s+doctor\(\)/);
    expect(r.stdout).toContain("DF_DOCTOR_CI");
  });

  it("runs the doctor checks and exits with a determinable code", async () => {
    // Doctor against the dark-factory worktree itself. We expect at
    // least a FAIL on hooks_directory_exists (dark-factory doesn't have
    // .husky/ — this is the OSS tool, consumer repos wire hooks
    // themselves). But the CLI must NOT crash; that's the smoke.
    const r = await runDfCli(["doctor"], { DF_DOCTOR_CI: "1" });
    // Either 0 (all passed) or 1 (some failed) — both are valid; what we
    // want is "not 2" (input validation) and "not a crash".
    expect([0, 1]).toContain(r.exitCode);
    expect(r.stdout).toContain("node_version");
    expect(r.stdout).toContain("artifact_dir_writable");
  });

  it("--json emits a stable machine-readable DoctorReportV1", async () => {
    // Consumer issue dark-factory-platform#56 — `df doctor --json` is
    // the surface consumer-side pre-push hooks call to fail-fast on
    // auth_pending before invoking the rest of the gate. The shape is
    // pinned by `DoctorReportV1` in packages/schemas/src/index.ts.
    const r = await runDfCli(["doctor", "--json"], { DF_DOCTOR_CI: "1" });
    expect([0, 1]).toContain(r.exitCode);
    // First line of stdout must parse as JSON of the documented shape.
    const parsed: unknown = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({
      version: 1,
      schema: "df-doctor-report-v1",
      triage: {
        state: expect.stringMatching(/^(config_missing|auth_pending|ok)$/),
        line: expect.any(String),
      },
      cloudEnv: {
        detected: expect.any(Boolean),
        markers: expect.any(Array),
      },
      ok: expect.any(Boolean),
      checks: expect.any(Array),
    });
    // `ok` mirrors the exit code (0 ⇒ true, 1 ⇒ false).
    expect((parsed as { ok: boolean }).ok).toBe(r.exitCode === 0);
  });

  it("--help mentions --json + the cloud-env markers", async () => {
    const r = await runDfCli(["doctor", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--json");
    expect(r.stdout).toContain("CODESPACES");
    expect(r.stdout).toContain("CLAUDE_CODE_SANDBOX");
  });
});

describe("Phase F-LOCAL — df gates", () => {
  it("--help prints the gates usage banner with no-LLM note", async () => {
    const r = await runDfCli(["gates", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df gates");
    expect(r.stdout).toContain("No LLM calls");
  });

  it("runs the configured gates and reports a count", async () => {
    // dark-factory's config has empty requiredQualityGates — `df gates`
    // should report 0 run / 0 failed.
    const r = await runDfCli(["gates"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/df gates: \d+ run, \d+ failed/);
  });
});

describe("Phase F-LOCAL — df stats", () => {
  it("--help prints the stats usage banner as an audit-stats alias", async () => {
    const r = await runDfCli(["stats", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df stats");
    expect(r.stdout).toContain("df audit stats");
  });
});
