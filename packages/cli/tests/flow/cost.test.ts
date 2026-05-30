import { describe, expect, it } from "vitest";
import {
  EXIT_ARG_ERROR,
  EXIT_NOT_FOUND,
  EXIT_OK,
  parseDateRange,
} from "../../src/commands/flow/common.js";
import {
  aggregateCost,
  formatCostText,
  parseCostArgs,
  runCost,
} from "../../src/commands/flow/cost.js";
import { makeCostRow, makeIo, stubFetcher } from "./_fixtures.js";

describe("flow/cost — parseCostArgs", () => {
  it("defaults to open range", () => {
    const r = parseCostArgs({});
    expect("opts" in r && r.opts).toMatchObject({ tenant: "sage3c", json: false });
  });
  it("rejects malformed --from", () => {
    const r = parseCostArgs({ from: "garbage" });
    expect("error" in r && r.error).toMatch(/--from/);
  });
});

describe("flow/cost — aggregateCost", () => {
  const openRange = parseDateRange({}).range;
  it("excludes replay and backfill rows", () => {
    const rows = [
      makeCostRow({ pr_number: 1, cost_usd: 0.05, tier: "deep" }),
      makeCostRow({ pr_number: 2, cost_usd: 99, replay: true }),
      makeCostRow({ pr_number: 3, cost_usd: 999, backfill: true }),
    ];
    const s = aggregateCost(rows, openRange);
    expect(s.total_usd).toBeCloseTo(0.05, 6);
    expect(s.pr_count).toBe(1);
  });
  it("preserves tier1/tier2 split", () => {
    const rows = [
      makeCostRow({ pr_number: 1, cost_usd: 0.002, tier: "triage" }),
      makeCostRow({ pr_number: 1, cost_usd: 0.05, tier: "deep" }),
    ];
    const s = aggregateCost(rows, openRange);
    expect(s.tier1_usd).toBeCloseTo(0.002, 6);
    expect(s.tier2_usd).toBeCloseTo(0.05, 6);
    expect(s.total_usd).toBeCloseTo(0.052, 6);
    expect(s.pr_count).toBe(1);
  });
  it("groups by UTC day", () => {
    const rows = [
      makeCostRow({ pr_number: 1, cost_usd: 0.01, tier: "deep", timestamp: "2026-05-27T00:00:00Z" }),
      makeCostRow({ pr_number: 2, cost_usd: 0.02, tier: "deep", timestamp: "2026-05-27T23:59:59Z" }),
      makeCostRow({ pr_number: 3, cost_usd: 0.04, tier: "deep", timestamp: "2026-05-28T00:00:01Z" }),
    ];
    const s = aggregateCost(rows, openRange);
    expect(s.days).toHaveLength(2);
    expect(s.days[0]?.date).toBe("2026-05-27");
    expect(s.days[0]?.total_usd).toBeCloseTo(0.03, 6);
    expect(s.days[0]?.pr_count).toBe(2);
    expect(s.days[1]?.date).toBe("2026-05-28");
  });
  it("respects date range (inclusive day boundary)", () => {
    const rows = [
      makeCostRow({ pr_number: 1, cost_usd: 1, timestamp: "2026-04-30T23:59:59Z" }),
      makeCostRow({ pr_number: 2, cost_usd: 1, timestamp: "2026-05-01T00:00:00Z" }),
      makeCostRow({ pr_number: 3, cost_usd: 1, timestamp: "2026-05-31T23:59:59Z" }),
      makeCostRow({ pr_number: 4, cost_usd: 1, timestamp: "2026-06-01T00:00:00Z" }),
    ];
    const range = parseDateRange({ from: "2026-05-01", to: "2026-05-31" }).range;
    const s = aggregateCost(rows, range);
    expect(s.total_usd).toBeCloseTo(2, 6);
    expect(s.pr_count).toBe(2);
  });
  it("avg_per_pr is zero when no PRs", () => {
    const s = aggregateCost([makeCostRow({ replay: true })], openRange);
    expect(s.avg_per_pr_usd).toBe(0);
  });
});

describe("flow/cost — formatCostText", () => {
  it("renders empty range message when no operational rows", () => {
    const s = aggregateCost([makeCostRow({ replay: true })], parseDateRange({}).range);
    const text = formatCostText(s, "sage3c", parseDateRange({}).range);
    expect(text).toMatch(/replay\/backfill are always excluded/);
  });
  it("renders daily breakdown with PR count", () => {
    const rows = [makeCostRow({ tier: "deep", cost_usd: 0.5, timestamp: "2026-05-27T00:00:00Z" })];
    const s = aggregateCost(rows, parseDateRange({}).range);
    const text = formatCostText(s, "sage3c", parseDateRange({}).range);
    expect(text).toMatch(/total:\s+\$0\.5000/);
    expect(text).toMatch(/2026-05-27/);
  });
});

describe("flow/cost — runCost", () => {
  it("404 exits 2", async () => {
    const fetcher = stubFetcher({
      files: { "store/tenant/sage3c/cost-tracking.ndjson": null },
    });
    const ctx = makeIo({ fetcher });
    expect(await runCost([], ctx.io)).toBe(EXIT_NOT_FOUND);
  });
  it("--json emits CostSummary", async () => {
    const ndjson =
      JSON.stringify(makeCostRow({ tier: "triage", cost_usd: 0.002 })) +
      "\n" +
      JSON.stringify(makeCostRow({ tier: "deep", cost_usd: 0.045 })) +
      "\n";
    const fetcher = stubFetcher({
      files: { "store/tenant/sage3c/cost-tracking.ndjson": ndjson },
    });
    const ctx = makeIo({ fetcher });
    expect(await runCost(["--json"], ctx.io)).toBe(EXIT_OK);
    const parsed = JSON.parse(ctx.out());
    expect(parsed.tier1_usd).toBeCloseTo(0.002, 6);
    expect(parsed.tier2_usd).toBeCloseTo(0.045, 6);
  });
  it("malformed --from exits 1", async () => {
    const ctx = makeIo();
    expect(await runCost(["--from", "garbage"], ctx.io)).toBe(EXIT_ARG_ERROR);
  });
});
