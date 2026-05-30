import { describe, expect, it } from "vitest";
import { EXIT_ARG_ERROR, EXIT_OK } from "../../src/commands/flow/common.js";
import {
  aggregatePattern,
  formatPatternsText,
  parsePatternsArgs,
  rankPatterns,
  runPatterns,
  type PatternRow,
} from "../../src/commands/flow/patterns.js";
import { PATTERN_CATALOG } from "../../src/commands/flow/pattern-catalog.js";
import { makeIo, makeRecurrence, stubFetcher } from "./_fixtures.js";

describe("flow/patterns — parsePatternsArgs", () => {
  it("defaults to --top 10", () => {
    const r = parsePatternsArgs({});
    expect("opts" in r && r.opts.top).toBe(10);
  });
  it("accepts a positive integer --top", () => {
    const r = parsePatternsArgs({ top: "3" });
    expect("opts" in r && r.opts.top).toBe(3);
  });
  it("rejects non-integer --top", () => {
    const r = parsePatternsArgs({ top: "0.5" });
    expect("error" in r && r.error).toMatch(/positive integer/);
  });
  it("rejects --top 0", () => {
    const r = parsePatternsArgs({ top: "0" });
    expect("error" in r).toBe(true);
  });
});

describe("flow/patterns — aggregatePattern", () => {
  it("counts events + distinct PRs + last_seen", () => {
    const events = [
      makeRecurrence({ pr_number: 1, observed_at: "2026-05-01T00:00:00Z" }),
      makeRecurrence({ pr_number: 2, observed_at: "2026-05-02T00:00:00Z" }),
      makeRecurrence({ pr_number: 1, observed_at: "2026-05-03T00:00:00Z" }),
    ];
    const row = aggregatePattern("agent-thrash", events);
    expect(row).toEqual({
      pattern_id: "agent-thrash",
      observations: 3,
      distinct_prs: 2,
      last_seen: "2026-05-03T00:00:00Z",
    });
  });
  it("handles empty events", () => {
    expect(aggregatePattern("p", [])).toEqual({
      pattern_id: "p",
      observations: 0,
      distinct_prs: 0,
      last_seen: null,
    });
  });
});

describe("flow/patterns — rankPatterns", () => {
  it("sorts by observations desc, then distinct_prs desc, then id asc", () => {
    const rows: PatternRow[] = [
      { pattern_id: "b", observations: 5, distinct_prs: 3, last_seen: null },
      { pattern_id: "a", observations: 5, distinct_prs: 5, last_seen: null },
      { pattern_id: "c", observations: 9, distinct_prs: 1, last_seen: null },
      { pattern_id: "d", observations: 5, distinct_prs: 5, last_seen: null },
    ];
    expect(rankPatterns(rows, 4).map((r) => r.pattern_id)).toEqual(["c", "a", "d", "b"]);
  });
  it("truncates to top N", () => {
    const rows = Array.from({ length: 20 }, (_, i): PatternRow => ({
      pattern_id: `p${i.toString().padStart(2, "0")}`,
      observations: 100 - i,
      distinct_prs: 0,
      last_seen: null,
    }));
    expect(rankPatterns(rows, 3)).toHaveLength(3);
  });
});

describe("flow/patterns — formatPatternsText", () => {
  it("renders rows + the catalog description", () => {
    const rows: PatternRow[] = [
      {
        pattern_id: "agent-thrash-high-push-count",
        observations: 7,
        distinct_prs: 4,
        last_seen: "2026-05-27T18:30:05Z",
      },
    ];
    const text = formatPatternsText(rows, "sage3c");
    expect(text).toMatch(/Patterns — tenant: sage3c\s+\(top 1\)/);
    expect(text).toMatch(/agent-thrash-high-push-count\s+7\s+4\s+2026-05-27T18:30:05Z/);
    expect(text).toMatch(/PR has >5 pushes before merge/);
  });
  it("renders empty state when no rows", () => {
    expect(formatPatternsText([], "sage3c")).toMatch(/\(no patterns observed\)/);
  });
});

describe("flow/patterns — runPatterns", () => {
  it("treats 404 on a pattern's recurrence file as zero observations (not an error)", async () => {
    // Program every catalog pattern's recurrence file as 404 except the
    // thrash one, which gets a single observation.
    const files: Record<string, string | null> = {};
    for (const p of PATTERN_CATALOG) {
      const key = `store/tenant/sage3c/recurrence/${p.id}.ndjson`;
      if (p.id === "agent-thrash-high-push-count") {
        files[key] = JSON.stringify(makeRecurrence({})) + "\n";
      } else {
        files[key] = null;
      }
    }
    const fetcher = stubFetcher({ files });
    const ctx = makeIo({ fetcher });
    const code = await runPatterns(["--json"], ctx.io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(ctx.out());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].pattern_id).toBe("agent-thrash-high-push-count");
    expect(parsed[0].observations).toBe(1);
    // Every other pattern row should still be present with observations=0.
    const zero = parsed.filter((r: PatternRow) => r.observations === 0);
    expect(zero.length).toBe(PATTERN_CATALOG.length - 1);
  });
  it("--help exits 0", async () => {
    const ctx = makeIo();
    expect(await runPatterns(["--help"], ctx.io)).toBe(EXIT_OK);
    expect(ctx.out()).toMatch(/df flow patterns/);
  });
  it("invalid --top exits 1", async () => {
    const ctx = makeIo();
    expect(await runPatterns(["--top", "0"], ctx.io)).toBe(EXIT_ARG_ERROR);
  });
});
