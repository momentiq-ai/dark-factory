// Service #9 — TS wrapper smoke test.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";

import {
  getSyncCycleTrackersScriptPath,
  getAttributePrCycleRefScriptPath,
  runSyncCycleTrackers,
  runAttributePrCycleRef,
} from "../../src/cycle-tracker-sync/index.js";

describe("cycle-tracker-sync wrappers", () => {
  it("resolves both bundled Python script paths", () => {
    const sync = getSyncCycleTrackersScriptPath();
    const attr = getAttributePrCycleRefScriptPath();
    expect(sync).toMatch(/sync_cycle_trackers\.py$/);
    expect(attr).toMatch(/attribute_pr_cycle_ref\.py$/);
    expect(existsSync(sync)).toBe(true);
    expect(existsSync(attr)).toBe(true);
  });

  it("sync_cycle_trackers.py --help returns exit 0", async () => {
    const result = await runSyncCycleTrackers({
      args: ["--help"],
      inheritStdio: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: sync_cycle_trackers.py");
  });

  it("attribute_pr_cycle_ref.py errors clearly when PR_NUMBER env var is empty", async () => {
    // The attribute script doesn't use argparse — it reads env vars
    // directly. Calling it with `--help` is treated as an unknown arg,
    // so we instead invoke it without env vars and assert it exits
    // non-zero with the expected error annotation. This confirms the
    // wrapper resolves the script + spawns Python + propagates exit
    // codes end-to-end.
    const result = await runAttributePrCycleRef({
      args: [],
      inheritStdio: false,
      env: { PR_NUMBER: "", PR_NODE_ID: "", PR_BODY_FILE: "", PROJECT_TOKEN: "" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("PR_NUMBER");
  });
});
