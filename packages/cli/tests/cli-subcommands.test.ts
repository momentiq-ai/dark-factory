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

describe("df CLI — Phase F reusable-workflow gates", () => {
  // Phase F upgrades `status-check` and `critic` from stubs to real
  // implementations while preserving the exit-0 contract that the five
  // reusable workflow shapes depend on. `status-check` stays a sentinel
  // (the merge queue's ALLGREEN rule is the real aggregator); `critic`
  // wires the real Critic Orchestrator with aggressive degrade-and-pass
  // so a single vendor flake or missing config never blocks the gate.
  // See cycle 331.1 Phase F in docs/roadmap/cycles/cycle331.1-extract-
  // from-sage3c.md.
  it("--help lists Phase F gates", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df status-check");
    expect(r.stdout).toContain("df critic");
  });

  it("status-check exits 0 with a sentinel message", async () => {
    const r = await runDfCli(["status-check"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("sentinel-pass");
  });

  it("status-check ignores arbitrary trailing args (aggregator contract)", async () => {
    const r = await runDfCli(["status-check", "--pr-number", "42", "extra"]);
    expect(r.exitCode).toBe(0);
  });

  it("critic --help prints Phase F usage", async () => {
    const r = await runDfCli(["critic", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--ref");
    expect(r.stdout).toContain("vendor adapters");
  });

  it("critic degrades-and-passes (exit 0) when no config is reachable", async () => {
    // Run from /tmp so the loader can't find .agent-review/config.json.
    // Must hit the catch path in cmdCritic and print [critic-degraded].
    const r = await new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [CLI_PATH, "critic"], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: "/tmp",
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
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("[critic-degraded]");
  });

  it("critic with GITHUB_STEP_SUMMARY set still degrades-and-passes (sage3c#2213 wiring)", async () => {
    // The observability fix adds an $GITHUB_STEP_SUMMARY append on the
    // success path. This spawn confirms the new import + env wiring loads
    // cleanly under a real binary invocation and that setting the env var
    // never perturbs the exit-0 degrade-and-pass contract — here the
    // catch path fires (no config under /tmp), so no summary is written,
    // but the binary must not crash on the changed code path.
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "df-cli-summary-"));
    const summaryFile = join(tmp, "step-summary.md");
    const r = await new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [CLI_PATH, "critic"], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: "/tmp",
        env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
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
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("[critic-degraded]");
  });

  it("critic ignores arbitrary trailing args (degrades-and-passes)", async () => {
    // Phase F still preserves the Phase E contract that arbitrary flags
    // do not block the gate. With no resolvable config, exit 0 via the
    // degraded path.
    const r = await new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          "critic",
          "--config",
          "darkfactory.yaml",
          "--critics",
          "cursor,codex",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: "/tmp",
        },
      );
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
    expect(r.exitCode).toBe(0);
  });
});

describe("df CLI — Cycle 12 handoff subcommands (v2 Issue-anchored)", () => {
  // These pin the cli.ts wiring (help routing + subcommand dispatch + arg
  // validation) for the four v2 handoff verbs. The behavior matrix lives
  // in tests/handoff/*-verb.test.ts; the spawned binary just confirms the
  // subcommands are registered, route to their own help printers (the
  // `--help` router gate in main() is the easy thing to forget), and that
  // requireSafeArgs/requireIssueNumber reject payload-shaped argv loudly
  // before any gh/git side-effect. Cycle 8 (PR-anchor) wording is gone —
  // the v1 source/tests were deleted at Task 22.

  it("--help lists the Cycle 12 handoff verbs under their own section", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Cycle 12 — agent handoff protocol, v2 Issue-anchored");
    expect(r.stdout).toContain("df handoff [issue]");
    expect(r.stdout).toContain("df handoffs");
    expect(r.stdout).toContain("df accept <issue>");
    expect(r.stdout).toContain("df rehydrate [issue]");
  });

  it("handoff --help routes to the subcommand's own help (v2 wording)", async () => {
    const r = await runDfCli(["handoff", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df handoff — put a work-stream on the handoff stack (v2 Issue-anchored).");
    expect(r.stdout).toContain("--link <ref>");
    expect(r.stdout).toContain("--unlink <ref>");
    expect(r.stdout).toContain("--new");
  });

  it("handoffs --help routes to the subcommand's own help (v2 wording)", async () => {
    const r = await runDfCli(["handoffs", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df handoffs — list the stack of handed-off Issues (v2 Issue-anchored).");
  });

  it("accept --help routes to the subcommand's own help (v2 wording)", async () => {
    const r = await runDfCli(["accept", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df accept — take the baton on a handoff Issue (v2 Issue-anchored).");
  });

  it("rehydrate --help routes to the subcommand's own help (v2 wording)", async () => {
    const r = await runDfCli(["rehydrate", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df rehydrate — read-only catch-up on a handoff Issue (v2 Issue-anchored).");
  });

  it("accept with no Issue arg exits 2 with a stack hint", async () => {
    const r = await runDfCli(["accept"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("df accept: which one?");
    expect(r.stderr).toContain("df handoffs");
  });

  it("handoff '0' exits 2 — requireIssueNumber rejects non-positive integers", async () => {
    const r = await runDfCli(["handoff", "0"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("df handoff: issue must be a positive integer");
    expect(r.stderr).toContain("'0'");
  });

  it("handoff with payload-shaped argv exits 2 — requireSafeArgs rejects shell metachars, never echoes payload", async () => {
    const r = await runDfCli(["handoff", "42; echo PWNED"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("df handoff: argument contains disallowed characters");
    expect(r.stderr).toContain("refusing for safety");
    // Hard contract: the payload's command-half must NEVER appear in any
    // stream — not echoed back, not executed, not leaked via diagnostics.
    expect(r.stdout).not.toContain("PWNED");
    expect(r.stderr).not.toContain("PWNED");
  });

  it("accept with payload-shaped argv exits 2 — same allow-list, no PWNED in output", async () => {
    const r = await runDfCli(["accept", "42; echo PWNED"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("df accept: argument contains disallowed characters");
    expect(r.stderr).toContain("refusing for safety");
    expect(r.stdout).not.toContain("PWNED");
    expect(r.stderr).not.toContain("PWNED");
  });
});

describe("df CLI — Cycle 11 flow subcommands", () => {
  // Pins the compiled-binary wiring for `df flow` end-to-end: the import in
  // cli.ts, the namespace help, and the early-help routing in main() that
  // forwards `flow --help` to cmdFlow's printer rather than the global one.
  // The behavior matrix per sub lives in tests/flow/*.test.ts.

  it("--help lists Cycle 11 flow", async () => {
    const r = await runDfCli(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df flow");
    expect(r.stdout).toContain("PR Flow Assessor");
  });

  it("flow with no sub prints the namespace help and exits 0", async () => {
    const r = await runDfCli(["flow"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df flow <subcommand>");
    expect(r.stdout).toContain("show");
    expect(r.stdout).toContain("rollup");
  });

  it("flow --help routes to the namespace help (not global)", async () => {
    const r = await runDfCli(["flow", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df flow — surface the PR Flow Assessor");
  });

  it("flow show --help routes to the sub's own help", async () => {
    const r = await runDfCli(["flow", "show", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("df flow show — render the AssessmentArtifact");
  });

  it("flow unknown-sub exits 1 (sub-arg error), NOT 2 (top-level not-implemented)", async () => {
    const r = await runDfCli(["flow", "nope"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('unknown subcommand "nope"');
  });

  it("flow show without --pr exits 1", async () => {
    const r = await runDfCli(["flow", "show"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--pr <N> is required");
  });
});
