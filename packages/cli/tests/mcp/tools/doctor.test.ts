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

import { describe, expect, it } from "vitest";

import type { DoctorCheck } from "@momentiq/dark-factory-schemas";

import { mapDoctorChecks } from "../../../src/mcp/tools/doctor.js";

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
