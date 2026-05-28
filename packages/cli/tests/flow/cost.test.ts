import { describe, expect, it } from "vitest";

import {
  DfAssessmentsClient,
  FixtureFetcher,
} from "../../src/flow/_lib/df-assessments-client.js";
import {
  buildCostSummary,
  cmdCost,
  parseCostArgs,
} from "../../src/flow/cost.js";
import type { CostSummary, CostTrackingRow } from "../../src/flow/types.js";
import { fixturePath } from "../_helpers.js";

const FIXTURE_ROOT = fixturePath("df-assessments");

function mkClient(): DfAssessmentsClient {
  return new DfAssessmentsClient(new FixtureFetcher(FIXTURE_ROOT));
}

describe("parseCostArgs", () => {
  it("defaults to no range, tenant=sage3c", () => {
    const f = parseCostArgs([]);
    expect(f.from).toBeUndefined();
    expect(f.to).toBeUndefined();
    expect(f.tenant).toBe("sage3c");
  });

  it("accepts --from and --to", () => {
    const f = parseCostArgs(["--from", "2026-05-01", "--to", "2026-05-31"]);
    expect(f.from).toBe("2026-05-01");
    expect(f.to).toBe("2026-05-31");
  });
});

describe("buildCostSummary", () => {
  it("excludes replay and backfill rows", () => {
    const rows: CostTrackingRow[] = [
      mkRow({ tier: "triage", cost_usd: 1.0, replay: false, backfill: false }),
      mkRow({ tier: "triage", cost_usd: 99.0, replay: true, backfill: false }),
      mkRow({ tier: "deep", cost_usd: 99.0, replay: false, backfill: true }),
    ];
    const s = buildCostSummary(rows, undefined, undefined);
    expect(s.total_usd).toBeCloseTo(1.0);
    expect(s.tier1_usd).toBeCloseTo(1.0);
    expect(s.tier2_usd).toBeCloseTo(0);
  });

  it("splits tier1 (triage) vs tier2 (deep)", () => {
    const rows: CostTrackingRow[] = [
      mkRow({ tier: "triage", cost_usd: 0.01 }),
      mkRow({ tier: "deep", cost_usd: 0.5 }),
      mkRow({ tier: "deep", cost_usd: 0.25 }),
    ];
    const s = buildCostSummary(rows, undefined, undefined);
    expect(s.tier1_usd).toBeCloseTo(0.01);
    expect(s.tier2_usd).toBeCloseTo(0.75);
    expect(s.total_usd).toBeCloseTo(0.76);
  });

  it("computes avg_per_pr from distinct PR count", () => {
    const rows: CostTrackingRow[] = [
      mkRow({ pr_number: 1, tier: "deep", cost_usd: 0.4 }),
      mkRow({ pr_number: 1, tier: "deep", cost_usd: 0.2 }),
      mkRow({ pr_number: 2, tier: "deep", cost_usd: 0.4 }),
    ];
    const s = buildCostSummary(rows, undefined, undefined);
    expect(s.pr_count).toBe(2);
    expect(s.avg_per_pr_usd).toBeCloseTo(0.5);
  });

  it("filters by from/to date range", () => {
    const rows: CostTrackingRow[] = [
      mkRow({
        timestamp: "2026-05-10T12:00:00Z",
        tier: "deep",
        cost_usd: 1.0,
      }),
      mkRow({
        timestamp: "2026-05-20T12:00:00Z",
        tier: "deep",
        cost_usd: 2.0,
      }),
      mkRow({
        timestamp: "2026-05-30T12:00:00Z",
        tier: "deep",
        cost_usd: 4.0,
      }),
    ];
    const s = buildCostSummary(rows, "2026-05-15", "2026-05-25");
    expect(s.total_usd).toBeCloseTo(2.0);
    expect(s.from).toBe("2026-05-15");
    expect(s.to).toBe("2026-05-25");
  });

  it("returns zero totals when no rows survive", () => {
    const s = buildCostSummary([], undefined, undefined);
    expect(s.total_usd).toBe(0);
    expect(s.pr_count).toBe(0);
    expect(s.avg_per_pr_usd).toBe(0);
    expect(s.days).toEqual([]);
  });

  it("emits sorted daily breakdown", () => {
    const rows: CostTrackingRow[] = [
      mkRow({
        timestamp: "2026-05-12T01:00:00Z",
        pr_number: 1,
        tier: "deep",
        cost_usd: 0.1,
      }),
      mkRow({
        timestamp: "2026-05-10T01:00:00Z",
        pr_number: 2,
        tier: "triage",
        cost_usd: 0.2,
      }),
      mkRow({
        timestamp: "2026-05-12T23:00:00Z",
        pr_number: 3,
        tier: "triage",
        cost_usd: 0.05,
      }),
    ];
    const s = buildCostSummary(rows, undefined, undefined);
    expect(s.days.map((d) => d.date)).toEqual(["2026-05-10", "2026-05-12"]);
    expect(s.days[1]?.pr_count).toBe(2);
    expect(s.days[1]?.total_usd).toBeCloseTo(0.15);
  });
});

describe("cmdCost", () => {
  it("emits text against the live cost fixture", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdCost({
      client: mkClient(),
      args: [],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(0);
    expect(cap.stdout).toContain("Cost summary");
    expect(cap.stdout).toContain("tier1 (Haiku triage)");
    expect(cap.stdout).toContain("tier2 (Opus deep)");
    expect(cap.stdout).toContain("PR count:");
  });

  it("emits valid JSON shape", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdCost({
      client: mkClient(),
      args: ["--json"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout) as CostSummary;
    expect(typeof parsed.total_usd).toBe("number");
    expect(parsed.total_usd).toBeGreaterThanOrEqual(0);
    expect(parsed.pr_count).toBeGreaterThan(0);
    expect(parsed.tier1_usd + parsed.tier2_usd).toBeLessThanOrEqual(
      parsed.total_usd + 1e-9,
    );
    expect(Array.isArray(parsed.days)).toBe(true);
  });
});

function mkRow(overrides: Partial<CostTrackingRow>): CostTrackingRow {
  return {
    schema_version: 1,
    timestamp: "2026-05-27T12:00:00Z",
    pr_number: 100,
    model: "test",
    tier: "deep",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    latency_ms: 0,
    retry_count: 0,
    attempt_number: 1,
    assessment_run_id: "test",
    replay: false,
    backfill: false,
    degraded: false,
    ...overrides,
  };
}
