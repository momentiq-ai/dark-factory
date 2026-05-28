import { describe, expect, it } from "vitest";

import {
  DfAssessmentsClient,
  FixtureFetcher,
} from "../../src/flow/_lib/df-assessments-client.js";
import {
  buildPatternStats,
  cmdPatterns,
  parsePatternsArgs,
} from "../../src/flow/patterns.js";
import { TRACKED_PATTERN_IDS } from "../../src/flow/patterns-catalog.js";
import type { PatternStat, RecurrenceEvent } from "../../src/flow/types.js";
import { fixturePath } from "../_helpers.js";

const FIXTURE_ROOT = fixturePath("df-assessments");

function mkClient(): DfAssessmentsClient {
  return new DfAssessmentsClient(new FixtureFetcher(FIXTURE_ROOT));
}

describe("parsePatternsArgs", () => {
  it("defaults to top=10 and tenant=sage3c", () => {
    const f = parsePatternsArgs([]);
    expect(f.top).toBe(10);
    expect(f.tenant).toBe("sage3c");
  });

  it("rejects non-integer --top", () => {
    expect(() => parsePatternsArgs(["--top", "abc"])).toThrow(/positive integer/);
  });
});

describe("buildPatternStats", () => {
  it("ranks by observation count desc, stable on tie", () => {
    const stats = buildPatternStats([
      { pattern_id: "z", events: [mkEvent({ pr_number: 1 })] },
      { pattern_id: "a", events: [mkEvent({ pr_number: 1 })] },
      {
        pattern_id: "m",
        events: [mkEvent({ pr_number: 1 }), mkEvent({ pr_number: 2 })],
      },
    ]);
    expect(stats[0]?.pattern_id).toBe("m");
    expect(stats[1]?.pattern_id).toBe("a");
    expect(stats[2]?.pattern_id).toBe("z");
  });

  it("counts distinct PRs and tracks the latest observed_at", () => {
    const stats = buildPatternStats([
      {
        pattern_id: "p",
        events: [
          mkEvent({ pr_number: 1, observed_at: "2026-05-01T00:00:00Z" }),
          mkEvent({ pr_number: 1, observed_at: "2026-05-10T00:00:00Z" }),
          mkEvent({ pr_number: 2, observed_at: "2026-05-05T00:00:00Z" }),
        ],
      },
    ]);
    expect(stats[0]?.observations).toBe(3);
    expect(stats[0]?.distinct_prs).toBe(2);
    expect(stats[0]?.last_seen).toBe("2026-05-10T00:00:00Z");
  });

  it("emits last_seen=null when a pattern has zero events", () => {
    const stats = buildPatternStats([{ pattern_id: "p", events: [] }]);
    expect(stats[0]?.last_seen).toBeNull();
    expect(stats[0]?.observations).toBe(0);
  });
});

describe("cmdPatterns", () => {
  it("emits text table by default", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdPatterns({
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
    expect(cap.stdout).toContain("Pattern");
    expect(cap.stdout).toContain("agent-thrash-high-push-count");
    // The fixture has 1 observation for that pattern.
    expect(cap.stdout).toMatch(/agent-thrash-high-push-count\s+1/);
  });

  it("emits JSON of all 10 tracked patterns", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdPatterns({
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
    const parsed = JSON.parse(cap.stdout) as PatternStat[];
    expect(parsed).toHaveLength(TRACKED_PATTERN_IDS.length);
    const ids = parsed.map((p) => p.pattern_id);
    for (const expected of TRACKED_PATTERN_IDS) {
      expect(ids).toContain(expected);
    }
    // Top-ranked should be the one with a recurrence fixture.
    expect(parsed[0]?.pattern_id).toBe("agent-thrash-high-push-count");
    expect(parsed[0]?.observations).toBeGreaterThan(0);
  });

  it("--top truncates the text table", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdPatterns({
      client: mkClient(),
      args: ["--top", "3"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(0);
    // Header + separator + 3 rows + trailing newline = 5 lines.
    const dataRows = cap.stdout
      .split("\n")
      .filter((l) => l.length > 0).length;
    expect(dataRows).toBe(5);
  });
});

function mkEvent(overrides: Partial<RecurrenceEvent>): RecurrenceEvent {
  return {
    schema_version: 1,
    pattern_id: "x",
    pr_number: 1,
    observed_at: "2026-05-27T00:00:00Z",
    assessment_run_id: "test",
    ...overrides,
  };
}
