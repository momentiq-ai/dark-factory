// Unit tests for `df flow show`. Uses FixtureFetcher backed by the real
// assessment artifact for sage3c PR 2310 (copied from live df-assessments
// on the day this test was written).

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DfAssessmentsClient,
  FixtureFetcher,
} from "../../src/flow/_lib/df-assessments-client.js";
import { cmdShow, parseShowArgs, renderShowText } from "../../src/flow/show.js";
import type { AssessmentArtifact } from "../../src/flow/types.js";
import { fixturePath } from "../_helpers.js";

const FIXTURE_ROOT = fixturePath("df-assessments");

function mkClient(): DfAssessmentsClient {
  return new DfAssessmentsClient(new FixtureFetcher(FIXTURE_ROOT));
}

interface Captured {
  stdout: string;
  stderr: string;
}

async function runShow(args: string[]): Promise<{ code: number } & Captured> {
  const cap: Captured = { stdout: "", stderr: "" };
  const code = await cmdShow({
    client: mkClient(),
    args,
    stdout: (s) => {
      cap.stdout += s;
    },
    stderr: (s) => {
      cap.stderr += s;
    },
  });
  return { code, ...cap };
}

describe("parseShowArgs", () => {
  it("accepts --pr N and applies default tenant", () => {
    const f = parseShowArgs(["--pr", "2310"]);
    expect(f.pr).toBe(2310);
    expect(f.tenant).toBe("sage3c");
    expect(f.json).toBe(false);
  });

  it("accepts --json and --tenant overrides", () => {
    const f = parseShowArgs(["--pr", "1", "--tenant", "acme", "--json"]);
    expect(f.tenant).toBe("acme");
    expect(f.json).toBe(true);
  });

  it("rejects non-integer --pr", () => {
    expect(() => parseShowArgs(["--pr", "abc"])).toThrow(/positive integer/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseShowArgs(["--bogus"])).toThrow(/unknown flag/);
  });

  it("rejects flags with no value", () => {
    expect(() => parseShowArgs(["--pr"])).toThrow(/requires a value/);
  });

  it("recognises --help", () => {
    expect(parseShowArgs(["--help"]).help).toBe(true);
  });
});

describe("renderShowText", () => {
  it("renders the canonical fixture (PR 2310)", () => {
    const artifact = loadFixture(2310);
    const text = renderShowText(artifact);
    expect(text).toContain("PR #2310");
    expect(text).toContain("outcome_quality:  88%");
    expect(text).toContain("process_quality:  52%");
    expect(text).toContain("agent-thrash-high-push-count");
    expect(text).toContain("Cycle: 333");
    expect(text).toContain("Issues: #38");
    expect(text).toContain("$0.0454"); // total cost
    // Live data has degraded=false, so the badge must NOT appear.
    expect(text).not.toContain("DEGRADED");
  });

  it("renders a degraded badge when degraded=true", () => {
    const artifact = loadFixture(2310);
    const text = renderShowText({ ...artifact, degraded: true });
    expect(text).toContain("⚠ DEGRADED ASSESSMENT");
  });

  it("omits cycle/issues blocks when absent", () => {
    const artifact = loadFixture(2310);
    const { cycle_id: _c, issue_ids: _i, ...rest } = artifact;
    void _c;
    void _i;
    const text = renderShowText(rest as AssessmentArtifact);
    expect(text).not.toContain("Cycle:");
    expect(text).not.toContain("Issues:");
  });
});

describe("cmdShow", () => {
  it("exits 0 and emits text for known PR", async () => {
    const r = await runShow(["--pr", "2310"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("PR #2310");
    expect(r.stderr).toBe("");
  });

  it("emits minified JSON with --json", async () => {
    const r = await runShow(["--pr", "2310", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as AssessmentArtifact;
    expect(parsed.pr_number).toBe(2310);
    expect(parsed.outcome_quality).toBeCloseTo(0.88);
    // No extra whitespace beyond the trailing newline.
    const newlines = r.stdout.split("\n").length - 1;
    expect(newlines).toBe(1);
  });

  it("exits 2 when the PR has no artifact", async () => {
    const r = await runShow(["--pr", "9999999"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no assessment artifact");
  });

  it("exits 1 when --pr is missing", async () => {
    const r = await runShow(["--json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--pr <N> is required");
  });

  it("exits 1 on bad flag value", async () => {
    const r = await runShow(["--pr", "abc"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("positive integer");
  });
});

// ---------------------------------------------------------------------------
// Helpers

function loadFixture(prNumber: number): AssessmentArtifact {
  const path = `${FIXTURE_ROOT}/store/tenant/sage3c/pr/${prNumber}.json`;
  return JSON.parse(readFileSync(path, "utf8")) as AssessmentArtifact;
}
