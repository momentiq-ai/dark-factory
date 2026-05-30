import { describe, expect, it } from "vitest";
import {
  EXIT_ARG_ERROR,
  EXIT_NOT_FOUND,
  EXIT_OK,
} from "../../src/commands/flow/common.js";
import {
  aggregateTrends,
  formatTrendsText,
  parseTrendsArgs,
  runTrends,
  sparkline,
  SUPPORTED_METRICS,
  summarizeTrend,
} from "../../src/commands/flow/trends.js";
import { makeArtifact, makeIo, stubFetcher } from "./_fixtures.js";

describe("flow/trends — parseTrendsArgs", () => {
  it("requires --metric", () => {
    const r = parseTrendsArgs({});
    expect("error" in r && r.error).toMatch(/--metric/);
  });
  it("rejects unknown metric", () => {
    const r = parseTrendsArgs({ metric: "made-up-metric" });
    expect("error" in r && r.error).toMatch(/not supported/);
  });
  it("accepts every supported metric", () => {
    for (const m of SUPPORTED_METRICS) {
      const r = parseTrendsArgs({ metric: m });
      expect("opts" in r && r.opts.metric).toBe(m);
    }
  });
});

describe("flow/trends — aggregateTrends", () => {
  it("averages quality metrics inside a bucket", () => {
    const a = [
      makeArtifact({ pr_number: 1, merged_at: "2026-05-04T00:00:00Z", process_quality: 0.4 }),
      makeArtifact({ pr_number: 2, merged_at: "2026-05-05T00:00:00Z", process_quality: 0.6 }),
      makeArtifact({ pr_number: 3, merged_at: "2026-05-11T00:00:00Z", process_quality: 0.9 }),
    ];
    const s = aggregateTrends(a, "process_quality");
    expect(s.buckets).toHaveLength(2);
    expect(s.buckets[0]).toMatchObject({ week_start: "2026-05-04", value: 0.5, pr_count: 2 });
    expect(s.buckets[1]).toMatchObject({ week_start: "2026-05-11", value: 0.9, pr_count: 1 });
  });
  it("sums cost inside a bucket", () => {
    const a = [
      makeArtifact({
        merged_at: "2026-05-04T00:00:00Z",
        cost_observed: {
          tier1_haiku_input_tokens: 0,
          tier1_haiku_output_tokens: 0,
          tier1_haiku_cost_usd: 0,
          total_cost_usd: 0.05,
        },
      }),
      makeArtifact({
        merged_at: "2026-05-05T00:00:00Z",
        cost_observed: {
          tier1_haiku_input_tokens: 0,
          tier1_haiku_output_tokens: 0,
          tier1_haiku_cost_usd: 0,
          total_cost_usd: 0.07,
        },
      }),
    ];
    const s = aggregateTrends(a, "cost");
    expect(s.buckets[0]?.value).toBeCloseTo(0.12, 6);
  });
  it("buckets are sorted ascending by week_start", () => {
    const a = [
      makeArtifact({ pr_number: 1, merged_at: "2026-06-01T00:00:00Z" }),
      makeArtifact({ pr_number: 2, merged_at: "2026-05-04T00:00:00Z" }),
    ];
    const s = aggregateTrends(a, "process_quality");
    expect(s.buckets[0]?.week_start.localeCompare(s.buckets[1]?.week_start ?? "")).toBeLessThan(0);
  });
  it("skips artifacts whose merged_at is unparseable", () => {
    const a = [makeArtifact({ merged_at: "garbage" })];
    const s = aggregateTrends(a, "process_quality");
    expect(s.buckets).toHaveLength(0);
  });
});

describe("flow/trends — summarizeTrend", () => {
  it("returns flat for empty buckets", () => {
    expect(summarizeTrend([]).direction).toBe("n/a");
  });
  it("classifies upward trend", () => {
    const s = summarizeTrend([
      { week_start: "2026-05-04", value: 0.2, pr_count: 1 },
      { week_start: "2026-05-11", value: 0.8, pr_count: 1 },
    ]);
    expect(s.direction).toBe("up");
    expect(s.min).toBe(0.2);
    expect(s.max).toBe(0.8);
  });
  it("classifies downward trend", () => {
    expect(
      summarizeTrend([
        { week_start: "2026-05-04", value: 0.9, pr_count: 1 },
        { week_start: "2026-05-11", value: 0.1, pr_count: 1 },
      ]).direction,
    ).toBe("down");
  });
  it("flat when delta within 5% of span", () => {
    expect(
      summarizeTrend([
        { week_start: "2026-05-04", value: 0.5, pr_count: 1 },
        { week_start: "2026-05-11", value: 0.51, pr_count: 1 },
      ]).direction,
    ).toBe("flat");
  });
});

describe("flow/trends — sparkline", () => {
  it("empty → (no data)", () => {
    expect(sparkline([])).toBe("(no data)");
  });
  it("constant series → mid-height of same length", () => {
    const s = sparkline([0.5, 0.5, 0.5]);
    expect(s).toHaveLength(3);
  });
  it("monotonic increase → lowest char first, highest char last", () => {
    const s = sparkline([0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(s).toHaveLength(5);
    expect(s.charAt(0)).toBe("▁");
    expect(s.charAt(s.length - 1)).toBe("█");
  });
});

describe("flow/trends — formatTrendsText", () => {
  it("renders per-week breakdown + summary", () => {
    const summary = aggregateTrends(
      [
        makeArtifact({ pr_number: 1, merged_at: "2026-05-04T00:00:00Z", process_quality: 0.5 }),
        makeArtifact({ pr_number: 2, merged_at: "2026-05-11T00:00:00Z", process_quality: 0.7 }),
      ],
      "process_quality",
    );
    const text = formatTrendsText(summary, "sage3c");
    expect(text).toMatch(/Trends — tenant: sage3c\s+metric: process_quality/);
    expect(text).toMatch(/direction:\s+up/);
    expect(text).toMatch(/2026-05-04/);
  });
  it("empty range shows helpful message", () => {
    expect(formatTrendsText({ metric: "cost", buckets: [] }, "sage3c")).toMatch(
      /no buckets in range/,
    );
  });
});

describe("flow/trends — runTrends", () => {
  it("--help exits 0", async () => {
    const ctx = makeIo();
    expect(await runTrends(["--help"], ctx.io)).toBe(EXIT_OK);
  });
  it("missing pr/ dir exits 2", async () => {
    const fetcher = stubFetcher({
      dirs: { "store/tenant/sage3c/pr": null },
    });
    const ctx = makeIo({ fetcher });
    expect(await runTrends(["--metric", "cost"], ctx.io)).toBe(EXIT_NOT_FOUND);
  });
  it("malformed pr/<N>.json is logged + skipped, not fatal", async () => {
    const fetcher = stubFetcher({
      dirs: {
        "store/tenant/sage3c/pr": [
          { name: "2310.json", type: "file", size: 100, path: "p", sha: "s", download_url: null },
          { name: "2311.json", type: "file", size: 100, path: "p", sha: "s", download_url: null },
        ],
      },
      files: {
        "store/tenant/sage3c/pr/2310.json": JSON.stringify(makeArtifact()),
        "store/tenant/sage3c/pr/2311.json": "{garbage",
      },
    });
    const ctx = makeIo({ fetcher });
    const code = await runTrends(["--metric", "process_quality", "--json"], ctx.io);
    expect(code).toBe(EXIT_OK);
    expect(ctx.err()).toMatch(/skipping 2311.json: parse error/);
    const parsed = JSON.parse(ctx.out());
    expect(parsed.buckets.length).toBeGreaterThanOrEqual(1);
  });
  it("unknown metric exits 1", async () => {
    const ctx = makeIo();
    expect(await runTrends(["--metric", "garbage"], ctx.io)).toBe(EXIT_ARG_ERROR);
  });
});
