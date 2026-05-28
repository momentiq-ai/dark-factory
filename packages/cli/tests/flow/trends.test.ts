import { describe, expect, it } from "vitest";

import {
  DfAssessmentsClient,
  FixtureFetcher,
} from "../../src/flow/_lib/df-assessments-client.js";
import {
  buildTrendSeries,
  cmdTrends,
  parseTrendsArgs,
  renderSparkline,
} from "../../src/flow/trends.js";
import type { AssessmentArtifact, TrendSeries } from "../../src/flow/types.js";
import { fixturePath } from "../_helpers.js";

const FIXTURE_ROOT = fixturePath("df-assessments");

function mkClient(): DfAssessmentsClient {
  return new DfAssessmentsClient(new FixtureFetcher(FIXTURE_ROOT));
}

describe("parseTrendsArgs", () => {
  it("defaults to process_quality", () => {
    expect(parseTrendsArgs([]).metric).toBe("process_quality");
  });

  it("accepts each supported metric", () => {
    for (const m of [
      "outcome_quality",
      "process_quality",
      "cost",
      "iteration_count",
    ]) {
      expect(parseTrendsArgs(["--metric", m]).metric).toBe(m);
    }
  });

  it("rejects unsupported metrics", () => {
    expect(() => parseTrendsArgs(["--metric", "bogus"])).toThrow(/--metric/);
  });
});

describe("renderSparkline", () => {
  it("returns empty string on empty input", () => {
    expect(renderSparkline([])).toBe("");
  });

  it("renders a flat line when all values are equal", () => {
    expect(renderSparkline([0.5, 0.5, 0.5])).toMatch(/^.{3}$/);
  });

  it("renders increasing values as a ramp", () => {
    const s = renderSparkline([0, 0.5, 1]);
    expect(s).toHaveLength(3);
    // Lowest char first, highest char last.
    expect(s[0]).toBe("▁");
    expect(s[2]).toBe("█");
  });
});

describe("buildTrendSeries", () => {
  it("buckets weekly and averages process_quality", () => {
    const series = buildTrendSeries(
      [
        mkArtifact({
          merged_at: "2026-05-04T00:00:00Z", // week of 2026-05-04
          process_quality: 0.6,
        }),
        mkArtifact({
          merged_at: "2026-05-06T00:00:00Z", // same week
          process_quality: 0.8,
        }),
        mkArtifact({
          merged_at: "2026-05-11T00:00:00Z", // next week
          process_quality: 0.9,
        }),
      ],
      "process_quality",
    );
    expect(series.buckets).toHaveLength(2);
    expect(series.buckets[0]?.week_start).toBe("2026-05-04");
    expect(series.buckets[0]?.value).toBeCloseTo(0.7);
    expect(series.buckets[0]?.pr_count).toBe(2);
    expect(series.buckets[1]?.value).toBeCloseTo(0.9);
    expect(series.direction).toBe("up");
  });

  it("sums per week for cost metric", () => {
    const series = buildTrendSeries(
      [
        mkArtifact({
          merged_at: "2026-05-04T00:00:00Z",
          cost_observed: mkCost(0.01),
        }),
        mkArtifact({
          merged_at: "2026-05-05T00:00:00Z",
          cost_observed: mkCost(0.02),
        }),
      ],
      "cost",
    );
    expect(series.buckets).toHaveLength(1);
    expect(series.buckets[0]?.value).toBeCloseTo(0.03);
  });

  it("emits empty series when no artifacts", () => {
    const series = buildTrendSeries([], "process_quality");
    expect(series.buckets).toEqual([]);
    expect(series.direction).toBe("flat");
  });
});

describe("cmdTrends", () => {
  it("emits text against the live fixture (2 PRs in one week)", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdTrends({
      client: mkClient(),
      args: ["--metric", "process_quality"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(0);
    expect(cap.stdout).toContain("Trend: process_quality");
    expect(cap.stdout).toContain("sparkline:");
  });

  it("emits JSON shape", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdTrends({
      client: mkClient(),
      args: ["--metric", "cost", "--json"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout) as TrendSeries;
    expect(parsed.metric).toBe("cost");
    expect(Array.isArray(parsed.buckets)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

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
