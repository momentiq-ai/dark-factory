// Service #5 — TS wrapper smoke test.
//
// Verifies the wrapper resolves the bundled Python script path, spawns
// it, and forwards stdout/stderr/exit-code. The wrapped script's full
// behavior is covered by the bundled pytest corpus
// (tests/cycle-doc-validator/test_validate_cycle_doc.py) which we run
// via `npm run test:python`.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";

import {
  getValidateCycleDocScriptPath,
  runValidateCycleDoc,
} from "../../src/cycle-doc-validator/index.js";

describe("cycle-doc-validator wrapper", () => {
  it("resolves the bundled Python script path", () => {
    const p = getValidateCycleDocScriptPath();
    expect(p).toMatch(/validate_cycle_doc\.py$/);
    expect(existsSync(p)).toBe(true);
  });

  it("--help returns exit 0 and prints argparse banner", async () => {
    const result = await runValidateCycleDoc({
      args: ["--help"],
      inheritStdio: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: validate_cycle_doc.py");
  });
});
