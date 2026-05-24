// Service #7 — TS wrapper smoke test.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";

import {
  getAuditBranchProtectionScriptPath,
  getBundledDefaultSpecPath,
  runAuditBranchProtection,
} from "../../src/branch-protection/index.js";

describe("branch-protection wrapper", () => {
  it("resolves the bundled Python script path", () => {
    const p = getAuditBranchProtectionScriptPath();
    expect(p).toMatch(/audit_branch_protection\.py$/);
    expect(existsSync(p)).toBe(true);
  });

  it("resolves the bundled default spec yaml path", () => {
    const p = getBundledDefaultSpecPath();
    expect(p).toMatch(/spec-default\.yaml$/);
    expect(existsSync(p)).toBe(true);
  });

  it("--help returns exit 0 and prints argparse banner", async () => {
    const result = await runAuditBranchProtection({
      args: ["--help"],
      inheritStdio: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: audit_branch_protection.py");
    expect(result.stdout).toContain("--use-bundled-default-spec");
  });
});
