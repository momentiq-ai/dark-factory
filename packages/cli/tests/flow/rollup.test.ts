import { describe, expect, it } from "vitest";
import {
  EXIT_ARG_ERROR,
  EXIT_NOT_FOUND,
  EXIT_OK,
} from "../../src/commands/flow/common.js";
import {
  aggregateRollup,
  formatRollupText,
  matchesQuery,
  normalizeCycleArg,
  normalizeIssueArg,
  parseRollupArgs,
  runRollup,
} from "../../src/commands/flow/rollup.js";
import { makeArtifact, makeIo, stubFetcher } from "./_fixtures.js";

describe("flow/rollup — normalizeCycleArg", () => {
  it("plain id passes through lowercased", () => {
    expect(normalizeCycleArg("333")).toBe("333");
    expect(normalizeCycleArg("Cycle333")).toBe("333");
  });
  it("dotted ids preserved", () => {
    expect(normalizeCycleArg("331.5")).toBe("331.5");
    expect(normalizeCycleArg("cycle331.5")).toBe("331.5");
  });
  it("rejects garbage", () => {
    expect(normalizeCycleArg("")).toBeNull();
    expect(normalizeCycleArg("not a cycle")).toBeNull();
  });
});

describe("flow/rollup — normalizeIssueArg", () => {
  it("bare integer", () => {
    expect(normalizeIssueArg("38")).toBe(38);
  });
  it("#NN", () => {
    expect(normalizeIssueArg("#38")).toBe(38);
  });
  it("repo#NN", () => {
    expect(normalizeIssueArg("momentiq-ai/sage3c#38")).toBe(38);
    expect(normalizeIssueArg("dark-factory-platform#101")).toBe(101);
  });
  it("rejects garbage", () => {
    expect(normalizeIssueArg("")).toBeNull();
    expect(normalizeIssueArg("0")).toBeNull();
    expect(normalizeIssueArg("foo")).toBeNull();
  });
});

describe("flow/rollup — parseRollupArgs", () => {
  it("requires one of --cycle | --issue", () => {
    const r = parseRollupArgs({});
    expect("error" in r && r.error).toMatch(/required/);
  });
  it("rejects both --cycle and --issue", () => {
    const r = parseRollupArgs({ cycle: "333", issue: "38" });
    expect("error" in r && r.error).toMatch(/mutually exclusive/);
  });
  it("malformed --cycle exits 1", () => {
    const r = parseRollupArgs({ cycle: " " });
    expect("error" in r).toBe(true);
  });
  it("malformed --issue exits 1", () => {
    const r = parseRollupArgs({ issue: "not-a-number" });
    expect("error" in r).toBe(true);
  });
  it("happy path --cycle 333", () => {
    const r = parseRollupArgs({ cycle: "333" });
    expect("opts" in r && r.opts.query).toEqual({ kind: "cycle", cycleId: "333" });
  });
});

describe("flow/rollup — matchesQuery", () => {
  it("cycle id (case-insensitive)", () => {
    const a = makeArtifact({ cycle_id: "333" });
    expect(matchesQuery(a, { kind: "cycle", cycleId: "333" })).toBe(true);
    expect(matchesQuery(a, { kind: "cycle", cycleId: "334" })).toBe(false);
  });
  it("missing cycle_id never matches", () => {
    const a = makeArtifact({});
    delete a.cycle_id;
    expect(matchesQuery(a, { kind: "cycle", cycleId: "333" })).toBe(false);
  });
  it("issue number presence in issue_ids", () => {
    const a = makeArtifact({ issue_ids: [38, 39] });
    expect(matchesQuery(a, { kind: "issue", issueNumber: 38 })).toBe(true);
    expect(matchesQuery(a, { kind: "issue", issueNumber: 99 })).toBe(false);
  });
  it("absent issue_ids never matches", () => {
    const a = makeArtifact({});
    delete a.issue_ids;
    expect(matchesQuery(a, { kind: "issue", issueNumber: 38 })).toBe(false);
  });
});

describe("flow/rollup — aggregateRollup", () => {
  it("averages scores + sums cost + dedupes patterns", () => {
    const a = [
      makeArtifact({
        pr_number: 1,
        cycle_id: "333",
        outcome_quality: 0.8,
        input_quality: 0.6,
        process_quality: 0.4,
        iteration_count: 1,
        cost_observed: {
          tier1_haiku_input_tokens: 0,
          tier1_haiku_output_tokens: 0,
          tier1_haiku_cost_usd: 0,
          total_cost_usd: 0.05,
        },
        patterns_detected: [
          { pattern_id: "p1", confidence: 1, evidence_snippets: [] },
        ],
      }),
      makeArtifact({
        pr_number: 2,
        cycle_id: "333",
        outcome_quality: 1.0,
        input_quality: 0.8,
        process_quality: 0.6,
        iteration_count: 3,
        cost_observed: {
          tier1_haiku_input_tokens: 0,
          tier1_haiku_output_tokens: 0,
          tier1_haiku_cost_usd: 0,
          total_cost_usd: 0.07,
        },
        patterns_detected: [
          { pattern_id: "p1", confidence: 1, evidence_snippets: [] },
          { pattern_id: "p2", confidence: 1, evidence_snippets: [] },
        ],
      }),
      makeArtifact({ pr_number: 3, cycle_id: "334" }),
    ];
    const s = aggregateRollup(a, { kind: "cycle", cycleId: "333" });
    expect(s.pr_count).toBe(2);
    expect(s.contributing_prs).toEqual([1, 2]);
    expect(s.aggregate_scores.avg_outcome_quality).toBeCloseTo(0.9, 4);
    expect(s.aggregate_scores.avg_input_quality).toBeCloseTo(0.7, 4);
    expect(s.aggregate_scores.avg_process_quality).toBeCloseTo(0.5, 4);
    expect(s.aggregate_scores.avg_iteration_count).toBeCloseTo(2, 4);
    expect(s.total_cost_usd).toBeCloseTo(0.12, 6);
    expect(s.total_iterations).toBe(4);
    expect(s.patterns_detected).toEqual(["p1", "p2"]);
  });
  it("empty match still returns the query envelope", () => {
    const s = aggregateRollup([], { kind: "cycle", cycleId: "999" });
    expect(s.pr_count).toBe(0);
    expect(s.contributing_prs).toEqual([]);
    expect(s.query).toEqual({ kind: "cycle", cycle_id: "999" });
  });
});

describe("flow/rollup — formatRollupText", () => {
  it("empty-match path", () => {
    const text = formatRollupText(
      aggregateRollup([], { kind: "cycle", cycleId: "x" }),
      "sage3c",
    );
    expect(text).toMatch(/No PR assessments matched/);
  });
  it("renders aggregate scores + PR list", () => {
    const a = aggregateRollup(
      [makeArtifact({ cycle_id: "333", pr_number: 2310 })],
      { kind: "cycle", cycleId: "333" },
    );
    const text = formatRollupText(a, "sage3c");
    expect(text).toMatch(/Cycle 333/);
    expect(text).toMatch(/PR numbers:\s+2310/);
  });
});

describe("flow/rollup — runRollup", () => {
  it("--help exits 0", async () => {
    const ctx = makeIo();
    expect(await runRollup(["--help"], ctx.io)).toBe(EXIT_OK);
  });
  it("--cycle without value exits 1 (bare flag triggers the error path)", async () => {
    const ctx = makeIo();
    // parseFlags turns a bare `--cycle` into `cycle: true`; the validator
    // surfaces that as "neither --cycle nor --issue was set" — exit 1.
    expect(await runRollup(["--cycle"], ctx.io)).toBe(EXIT_ARG_ERROR);
  });
  it("404 on pr/ exits 2", async () => {
    const fetcher = stubFetcher({ dirs: { "store/tenant/sage3c/pr": null } });
    const ctx = makeIo({ fetcher });
    expect(await runRollup(["--cycle", "333"], ctx.io)).toBe(EXIT_NOT_FOUND);
  });
  it("--json emits RollupSummary", async () => {
    const fetcher = stubFetcher({
      dirs: {
        "store/tenant/sage3c/pr": [
          { name: "2310.json", type: "file", size: 100, path: "p", sha: "s", download_url: null },
        ],
      },
      files: {
        "store/tenant/sage3c/pr/2310.json": JSON.stringify(
          makeArtifact({ pr_number: 2310, cycle_id: "333" }),
        ),
      },
    });
    const ctx = makeIo({ fetcher });
    expect(await runRollup(["--cycle", "333", "--json"], ctx.io)).toBe(EXIT_OK);
    const parsed = JSON.parse(ctx.out());
    expect(parsed.contributing_prs).toEqual([2310]);
    expect(parsed.query).toEqual({ kind: "cycle", cycle_id: "333" });
  });
});
