// Unit tests for the df_doctor MCP tool — cycle5 Phase 1 step 2.
//
// What these tests pin:
//   - mapDoctorChecks: DoctorCheck[] → spec output shape with the
//     'pass' / 'fail' / 'warn' status enum.
//       * passed=true                → status: 'pass'
//       * passed=false && optional   → status: 'warn' (not gating)
//       * passed=false && !optional  → status: 'fail' (gates ok=false)
//   - ok = no 'fail' entries. 'warn' entries do NOT gate ok=false.
//   - The mapped `message` includes the remediation hint when present
//     on a non-pass check (so an MCP client doesn't need to render
//     remediation separately).
//
// The integration test that exercises the tool through the live MCP
// server (registerTool + tools/list + tools/call) lives in
// tests/mcp/server.test.ts so the skeleton-side schema assertions
// stay alongside the rest of the conformance pins.

import { describe, expect, it, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DoctorCheck } from "@momentiq/dark-factory-schemas";

import { mapDoctorChecks, runDfDoctorTool } from "../../../src/mcp/tools/doctor.js";

function runGit(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, env: process.env });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
}

describe("mapDoctorChecks (cycle5 Phase 1 step 2)", () => {
  it("translates a passed check to status: 'pass' with detail as the message", () => {
    const input: DoctorCheck[] = [
      { name: "node_version", passed: true, detail: "node v20.10.0" },
    ];
    const out = mapDoctorChecks(input);
    expect(out.ok).toBe(true);
    expect(out.checks).toEqual([
      { name: "node_version", status: "pass", message: "node v20.10.0" },
    ]);
  });

  it("translates a non-optional failed check to status: 'fail' and ok: false", () => {
    const input: DoctorCheck[] = [
      {
        name: "hooks_directory_exists",
        passed: false,
        detail: ".husky missing",
        remediation: "create .husky/ at repo root",
      },
    ];
    const out = mapDoctorChecks(input);
    expect(out.ok).toBe(false);
    expect(out.checks).toEqual([
      {
        name: "hooks_directory_exists",
        status: "fail",
        // remediation is appended to the message so a client sees it
        // without needing to render remediation separately.
        message: ".husky missing — fix: create .husky/ at repo root",
      },
    ]);
  });

  it("translates an optional failed check to status: 'warn' and DOES NOT gate ok", () => {
    const input: DoctorCheck[] = [
      {
        name: "grok-sdk.api_key_present",
        passed: false,
        detail: "XAI_API_KEY not set",
        optional: true,
      },
    ];
    const out = mapDoctorChecks(input);
    expect(out.ok).toBe(true); // optional failures do not gate ok
    expect(out.checks).toEqual([
      { name: "grok-sdk.api_key_present", status: "warn", message: "XAI_API_KEY not set" },
    ]);
  });

  it("ok=false when ANY non-optional check is failed (mix of pass/warn/fail)", () => {
    const input: DoctorCheck[] = [
      { name: "node_version", passed: true, detail: "node v20.10.0" },
      {
        name: "grok-sdk.api_key_present",
        passed: false,
        detail: "XAI_API_KEY not set",
        optional: true,
      },
      {
        name: "hooks_directory_exists",
        passed: false,
        detail: ".husky missing",
      },
    ];
    const out = mapDoctorChecks(input);
    expect(out.ok).toBe(false);
    expect(out.checks.map((c) => c.status)).toEqual(["pass", "warn", "fail"]);
  });

  it("ok=true with all-pass and ok=true with pass+warn (warn does not gate)", () => {
    const allPass = mapDoctorChecks([
      { name: "node_version", passed: true, detail: "node v20.10.0" },
    ]);
    expect(allPass.ok).toBe(true);

    const passPlusWarn = mapDoctorChecks([
      { name: "node_version", passed: true, detail: "node v20.10.0" },
      {
        name: "grok-sdk.api_key_present",
        passed: false,
        detail: "XAI_API_KEY not set",
        optional: true,
      },
    ]);
    expect(passPlusWarn.ok).toBe(true);
  });

  it("a passed check with a remediation field is still 'pass' and omits the remediation from message", () => {
    // Defensive: remediation should only appear in the message when the
    // check failed. A passed check with leftover remediation (legacy
    // edge case) should render cleanly.
    const input: DoctorCheck[] = [
      {
        name: "config_loaded",
        passed: true,
        detail: ".agent-review/config.json parsed",
        remediation: "n/a",
      },
    ];
    const out = mapDoctorChecks(input);
    expect(out.ok).toBe(true);
    expect(out.checks[0]).toEqual({
      name: "config_loaded",
      status: "pass",
      message: ".agent-review/config.json parsed",
    });
  });

  it("handles an empty input array (degenerate case)", () => {
    // Defensive: if runDoctor returns no checks (caller bug, not
    // currently reachable), the tool still returns a well-formed
    // response — ok is true (no failures by vacuous truth), checks is [].
    const out = mapDoctorChecks([]);
    expect(out.ok).toBe(true);
    expect(out.checks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adapter-registry parity: the MCP doctor's RUNDOCTOR_LOADER_CLASSES must
// mirror src/cli.ts ADAPTER_LOADERS so a critic config that names
// `static-schema-lint` does NOT produce a false `adapter_..._registered:
// false` check via the MCP tool path.

function writeStaticSchemaLintConfig(dir: string): void {
  const config = {
    version: 1,
    critics: [
      {
        id: "schema-lint-chief-engineer",
        name: "Schema-Lint Critic",
        adapter: "static-schema-lint",
        required: false,
        runtime: "local",
        model: { id: "deterministic-1.0", params: [] },
      },
      {
        // Second critic to satisfy min-complete-quorum >= 2; the test
        // only inspects doctor checks for the static-schema-lint critic.
        id: "cursor-local-chief-engineer",
        name: "Cursor Local Critic",
        adapter: "cursor-sdk",
        required: false,
        runtime: "local",
        model: { id: "gpt-5.5", params: [] },
      },
    ],
    profiles: {
      local: {
        criticIds: ["schema-lint-chief-engineer", "cursor-local-chief-engineer"],
        quorum: 2,
      },
    },
    aggregation: {
      policy: "min-complete-quorum",
      blockingSeverities: ["blocker", "high"],
      quorum: 2,
    },
    git: {
      hookPath: ".husky",
      artifactDir: "agent-reviews",
      artifactScope: "git-common-dir",
    },
    policy: {
      blockOnMissingReview: false,
      blockOnReviewError: false,
      allowEmergencyBypass: true,
      postCommitMode: "async",
    },
    context: {
      guidanceFiles: [],
      promptFragments: [],
      maxChangedFileBytes: 200000,
      includeFullChangedFiles: true,
    },
    validation: {
      runBeforeReview: false,
      resultFile: "agent-reviews/quality-gates/latest.json",
      requiredQualityGates: [],
      optionalQualityGates: [],
      verificationRoutes: [],
    },
    security: {
      redactSecretsInDiagnostics: true,
      treatDiffAsUntrustedInput: true,
    },
  };
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(
    join(dir, ".agent-review/config.json"),
    JSON.stringify(config),
  );
}

test("runDfDoctorTool registers static-schema-lint via the MCP loader list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "df-mcp-doctor-static-schema-"));
  runGit(["init", "-q", "-b", "main", dir], process.cwd());
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# repo\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "initial"], dir);
  writeStaticSchemaLintConfig(dir);
  const result = await runDfDoctorTool({ cwd: dir });
  // If the loader list omits static-schema-lint, runDoctor emits a fail
  // entry shaped `adapter_static-schema-lint_registered`. With the loader
  // wired the per-adapter doctor entries appear under the critic id
  // prefix (e.g. `schema-lint-chief-engineer.static_schema_lint_registry`).
  const missing = result.checks.find(
    (c) => c.name === "adapter_static-schema-lint_registered",
  );
  expect(missing).toBeUndefined();
  const registryCheck = result.checks.find((c) =>
    c.name.endsWith(".static_schema_lint_registry"),
  );
  // The adapter's doctor() reports the registry compiled successfully —
  // a passing check maps to status: 'pass' (the `optional` modifier
  // applied for non-required critics only flips FAILED checks to 'warn').
  expect(registryCheck?.status).toBe("pass");
  // cursor critic #116 — CONSUMER-ADOPTION.md §4.1 instructs operators
  // to verify BOTH the registry probe AND the smoke probe. If a
  // regression broke or removed `static_schema_lint_smoke` (e.g. ajv got
  // tree-shaken away in a packaging change), this assertion catches it
  // at CI time instead of at consumer onboarding time.
  const smokeCheck = result.checks.find((c) =>
    c.name.endsWith(".static_schema_lint_smoke"),
  );
  expect(smokeCheck?.status).toBe("pass");
});
