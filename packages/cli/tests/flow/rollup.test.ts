import { describe, expect, it } from "vitest";

import {
  DfAssessmentsClient,
  FixtureFetcher,
} from "../../src/flow/_lib/df-assessments-client.js";
import {
  buildRollupSummary,
  cmdRollup,
  normalizeCycleRef,
  normalizeIssueRef,
  parseRollupArgs,
} from "../../src/flow/rollup.js";
import type {
  AssessmentArtifact,
  RollupSummary,
} from "../../src/flow/types.js";
import { fixturePath } from "../_helpers.js";

const FIXTURE_ROOT = fixturePath("df-assessments");

function mkClient(): DfAssessmentsClient {
  return new DfAssessmentsClient(new FixtureFetcher(FIXTURE_ROOT));
}

describe("normalizeCycleRef", () => {
  it("strips a 'cycle' prefix (case-insensitive)", () => {
    expect(normalizeCycleRef("cycle333")).toBe("333");
    expect(normalizeCycleRef("CYCLE333")).toBe("333");
    expect(normalizeCycleRef("333")).toBe("333");
  });

  it("preserves non-numeric ids", () => {
    expect(normalizeCycleRef("331.5")).toBe("331.5");
    expect(normalizeCycleRef("cycle331.5")).toBe("331.5");
  });
});

describe("normalizeIssueRef", () => {
  it("accepts bare integers", () => {
    expect(normalizeIssueRef("38")).toBe(38);
  });

  it("accepts hash-prefixed", () => {
    expect(normalizeIssueRef("#38")).toBe(38);
  });

  it("accepts org/repo#N", () => {
    expect(normalizeIssueRef("dark-factory-platform#38")).toBe(38);
    expect(normalizeIssueRef("momentiq-ai/sage3c#38")).toBe(38);
  });

  it("rejects garbage", () => {
    expect(() => normalizeIssueRef("abc")).toThrow(/cannot parse/);
    expect(() => normalizeIssueRef("0")).toThrow(/cannot parse/);
    expect(() => normalizeIssueRef("-1")).toThrow(/cannot parse/);
  });
});

describe("parseRollupArgs", () => {
  it("accepts --cycle alone", () => {
    const f = parseRollupArgs(["--cycle", "333"]);
    expect(f.cycle).toBe("333");
    expect(f.issue).toBeUndefined();
  });

  it("accepts --issue alone", () => {
    const f = parseRollupArgs(["--issue", "#38"]);
    expect(f.issue).toBe("#38");
  });
});

describe("buildRollupSummary", () => {
  it("aggregates scores + sums cost + unions patterns", () => {
    const s = buildRollupSummary(
      { kind: "cycle", value: "333" },
      [
        mkArtifact({
          pr_number: 2310,
          outcome_quality: 0.88,
          process_quality: 0.52,
          cost_observed: mkCost(0.045),
          patterns_detected: [
            { pattern_id: "p-a", confidence: 0.9, evidence_snippets: [] },
          ],
        }),
        mkArtifact({
          pr_number: 2308,
          outcome_quality: 0.82,
          process_quality: 0.68,
          cost_observed: mkCost(0.02),
          patterns_detected: [
            { pattern_id: "p-a", confidence: 0.9, evidence_snippets: [] },
            { pattern_id: "p-b", confidence: 0.7, evidence_snippets: [] },
          ],
        }),
      ],
    );
    expect(s.contributing_prs).toEqual([2308, 2310]);
    expect(s.total_cost_usd).toBeCloseTo(0.065);
    expect(s.aggregate_scores!.avg_outcome_quality).toBeCloseTo(0.85);
    expect(s.aggregate_scores!.avg_process_quality).toBeCloseTo(0.6);
    expect(s.patterns_detected).toEqual(["p-a", "p-b"]);
  });

  it("returns null aggregate_scores on empty match", () => {
    const s = buildRollupSummary({ kind: "cycle", value: "999" }, []);
    expect(s.aggregate_scores).toBeNull();
    expect(s.contributing_prs).toEqual([]);
    expect(s.total_cost_usd).toBe(0);
    expect(s.patterns_detected).toEqual([]);
  });
});

describe("cmdRollup", () => {
  it("matches PR 2310 on --cycle 333 (live fixture)", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdRollup({
      client: mkClient(),
      args: ["--cycle", "333", "--json"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout) as RollupSummary;
    expect(parsed.query.kind).toBe("cycle");
    expect(parsed.query.value).toBe("333");
    expect(parsed.contributing_prs).toContain(2310);
  });

  it("treats cycle333 same as 333", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdRollup({
      client: mkClient(),
      args: ["--cycle", "cycle333", "--json"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout) as RollupSummary;
    expect(parsed.contributing_prs).toContain(2310);
  });

  it("matches issue 38 (live fixture)", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdRollup({
      client: mkClient(),
      args: ["--issue", "38", "--json"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout) as RollupSummary;
    expect(parsed.contributing_prs).toContain(2310);
  });

  it("returns empty rollup for unknown cycle (no error)", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdRollup({
      client: mkClient(),
      args: ["--cycle", "9999", "--json"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout) as RollupSummary;
    expect(parsed.contributing_prs).toEqual([]);
    expect(parsed.aggregate_scores).toBeNull();
  });

  it("exits 1 when neither --cycle nor --issue is set", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdRollup({
      client: mkClient(),
      args: [],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(1);
    expect(cap.stderr).toContain("exactly one");
  });

  it("exits 1 when both flags are set", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdRollup({
      client: mkClient(),
      args: ["--cycle", "333", "--issue", "38"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(1);
    expect(cap.stderr).toContain("not both");
  });
});

function mkCost(total: number) {
  return {
    tier1_haiku_input_tokens: 0,
    tier1_haiku_output_tokens: 0,
    tier1_haiku_cost_usd: 0,
    total_cost_usd: total,
  };
}

function mkArtifact(
  overrides: Partial<AssessmentArtifact> = {},
): AssessmentArtifact {
  return {
    schema_version: 1,
    pr_number: 1,
    merged_at: "2026-05-27T00:00:00Z",
    merged_commit_sha: "abc",
    base_commit_sha: "def",
    outcome_quality: 0.5,
    input_quality: 0.5,
    process_quality: 0.5,
    iteration_count: 0,
    push_count: 0,
    time_to_merge_hours: 0,
    regressions_introduced: 0,
    admin_merge_used: false,
    bypass_used: false,
    patterns_detected: [],
    root_causes: [],
    improvement_actions: [],
    cost_observed: mkCost(0),
    critic_evidence_missing: false,
    degraded: false,
    assessment_run_id: "test",
    attempts: [],
    ...overrides,
  };
}
