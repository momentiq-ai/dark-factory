import { describe, expect, it } from "vitest";
import {
  EXIT_ARG_ERROR,
  EXIT_GH_ERROR,
  EXIT_NOT_FOUND,
  EXIT_OK,
} from "../../src/commands/flow/common.js";
import {
  formatShowText,
  parseShowArgs,
  runShow,
} from "../../src/commands/flow/show.js";
import { makeArtifact, makeIo, stubFetcher } from "./_fixtures.js";

describe("flow/show — parseShowArgs", () => {
  it("requires --pr", () => {
    const r = parseShowArgs({});
    expect("error" in r && r.error).toMatch(/--pr <N> is required/);
  });
  it("rejects non-integer --pr", () => {
    const r = parseShowArgs({ pr: "abc" });
    expect("error" in r && r.error).toMatch(/not a positive integer/);
  });
  it("rejects --pr 0 and negatives", () => {
    expect("error" in parseShowArgs({ pr: "0" })).toBe(true);
    expect("error" in parseShowArgs({ pr: "-1" })).toBe(true);
  });
  it("accepts a valid --pr", () => {
    const r = parseShowArgs({ pr: "2310" });
    expect("opts" in r && r.opts).toEqual({ pr: 2310, tenant: "sage3c", json: false });
  });
  it("threads --json + --tenant", () => {
    const r = parseShowArgs({ pr: "2310", tenant: "acme", json: true });
    expect("opts" in r && r.opts).toEqual({ pr: 2310, tenant: "acme", json: true });
  });
});

describe("flow/show — formatShowText", () => {
  const text = formatShowText(makeArtifact(), "sage3c");
  it("includes the PR number and tenant in the header", () => {
    expect(text).toMatch(/PR 2310 — tenant: sage3c/);
  });
  it("renders all three quality scores", () => {
    expect(text).toMatch(/outcome_quality:\s+88%/);
    expect(text).toMatch(/input_quality:\s+84%/);
    expect(text).toMatch(/process_quality:\s+52%/);
  });
  it("lists the detected pattern with confidence", () => {
    expect(text).toMatch(/- agent-thrash-high-push-count\s+\(confidence 96%\)/);
  });
  it("renders the cost summary", () => {
    expect(text).toMatch(/tier1 \(Haiku triage\):\s+\$0\.0023/);
    expect(text).toMatch(/tier2 \(Opus deep\):\s+\$0\.0430/);
    expect(text).toMatch(/total:\s+\$0\.0454/);
  });
  it("surfaces degraded artifacts with a visible badge", () => {
    const t = formatShowText(makeArtifact({ degraded: true }), "sage3c");
    expect(t).toMatch(/Degraded assessment: yes/);
  });
  it("collapses multi-root-cause to top + counter", () => {
    const a = makeArtifact({
      root_causes: [
        { description: "first cause", links_to_components: [] },
        { description: "second cause", links_to_components: [] },
      ],
    });
    const t = formatShowText(a, "sage3c");
    expect(t).toMatch(/Top root cause/);
    expect(t).toMatch(/first cause/);
    expect(t).toMatch(/\+ 1 more — see --json/);
  });
  it("handles no-pattern artifact gracefully", () => {
    const t = formatShowText(makeArtifact({ patterns_detected: [] }), "sage3c");
    expect(t).toMatch(/Patterns: \(none detected\)/);
  });
});

describe("flow/show — runShow", () => {
  it("--help exits 0", async () => {
    const ctx = makeIo();
    const code = await runShow(["--help"], ctx.io);
    expect(code).toBe(EXIT_OK);
    expect(ctx.out()).toMatch(/df flow show/);
  });
  it("missing --pr exits 1", async () => {
    const ctx = makeIo();
    const code = await runShow([], ctx.io);
    expect(code).toBe(EXIT_ARG_ERROR);
    expect(ctx.err()).toMatch(/--pr <N> is required/);
  });
  it("404 exits 2 with attributable message", async () => {
    const fetcher = stubFetcher({
      files: { "store/tenant/sage3c/pr/2999.json": null },
    });
    const ctx = makeIo({ fetcher });
    const code = await runShow(["--pr", "2999"], ctx.io);
    expect(code).toBe(EXIT_NOT_FOUND);
    expect(ctx.err()).toMatch(/no assessment found for PR 2999/);
  });
  it("transport failure surfaces and exits 3", async () => {
    const fetcher = stubFetcher({
      files: { "store/tenant/sage3c/pr/2310.json": null },
    });
    // Replace fetchFileText with a transport-error simulation.
    const { DfFlowGhError } = await import("../../src/commands/flow/gh-api.js");
    fetcher.fetchFileText = () => {
      throw new DfFlowGhError("rate limit", 1, "API rate limit exceeded");
    };
    const ctx = makeIo({ fetcher });
    const code = await runShow(["--pr", "2310"], ctx.io);
    expect(code).toBe(EXIT_GH_ERROR);
    expect(ctx.err()).toMatch(/rate limit/);
  });
  it("returns the full artifact via --json", async () => {
    const art = makeArtifact();
    const fetcher = stubFetcher({
      files: { "store/tenant/sage3c/pr/2310.json": JSON.stringify(art) },
    });
    const ctx = makeIo({ fetcher });
    const code = await runShow(["--pr", "2310", "--json"], ctx.io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(ctx.out());
    expect(parsed.pr_number).toBe(2310);
    expect(parsed.cost_observed.total_cost_usd).toBeCloseTo(0.045378, 6);
  });
  it("malformed JSON exits 3 with parse error", async () => {
    const fetcher = stubFetcher({
      files: { "store/tenant/sage3c/pr/2310.json": "{not-json" },
    });
    const ctx = makeIo({ fetcher });
    const code = await runShow(["--pr", "2310"], ctx.io);
    expect(code).toBe(EXIT_GH_ERROR);
    expect(ctx.err()).toMatch(/failed to parse/);
  });
});
