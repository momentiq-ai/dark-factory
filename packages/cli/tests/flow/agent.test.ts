import { describe, expect, it } from "vitest";
import {
  EXIT_ARG_ERROR,
  EXIT_NOT_FOUND,
  EXIT_OK,
} from "../../src/commands/flow/common.js";
import {
  formatAgentText,
  parseAgentArgs,
  runAgent,
} from "../../src/commands/flow/agent.js";
import { makeAgentSummary, makeIo, stubFetcher } from "./_fixtures.js";

describe("flow/agent — parseAgentArgs", () => {
  it("requires a positional agent-id", () => {
    const r = parseAgentArgs([], {});
    expect("error" in r && r.error).toMatch(/<agent-id> positional argument is required/);
  });
  it("rejects extra positional args", () => {
    const r = parseAgentArgs(["a", "b"], {});
    expect("error" in r && r.error).toMatch(/unexpected extra positional/);
  });
  it("accepts a single positional + tenant + json", () => {
    const r = parseAgentArgs(["claude-opus-4-7"], { tenant: "acme", json: true });
    expect("opts" in r && r.opts).toEqual({
      agentId: "claude-opus-4-7",
      tenant: "acme",
      json: true,
    });
  });
});

describe("flow/agent — formatAgentText", () => {
  it("renders all summary fields", () => {
    const text = formatAgentText(
      "claude-opus-4-7",
      {
        n_assessments: 4,
        avg_process_quality: 0.72,
        avg_iteration_count: 1.25,
        total_regressions_introduced: 0,
        admin_merge_count: 0,
        bypass_count: 1,
        last_seen_at: "2026-05-27T00:00:00Z",
      },
      "sage3c",
    );
    expect(text).toMatch(/Agent: claude-opus-4-7\s+\(tenant: sage3c\)/);
    expect(text).toMatch(/assessments seen:\s+4/);
    expect(text).toMatch(/avg process_quality:\s+72%/);
    expect(text).toMatch(/avg iteration_count:\s+1\.25/);
    expect(text).toMatch(/bypass uses:\s+1/);
    expect(text).toMatch(/last seen at:\s+2026-05-27T00:00:00Z/);
  });
});

describe("flow/agent — runAgent", () => {
  it("--help exits 0", async () => {
    const ctx = makeIo();
    const code = await runAgent(["--help"], ctx.io);
    expect(code).toBe(EXIT_OK);
    expect(ctx.out()).toMatch(/df flow agent/);
  });
  it("missing positional exits 1", async () => {
    const ctx = makeIo();
    const code = await runAgent([], ctx.io);
    expect(code).toBe(EXIT_ARG_ERROR);
  });
  it("summary 404 exits 2", async () => {
    const fetcher = stubFetcher({
      files: { "store/tenant/sage3c/agents-trust-summary.json": null },
    });
    const ctx = makeIo({ fetcher });
    const code = await runAgent(["claude-opus-4-7"], ctx.io);
    expect(code).toBe(EXIT_NOT_FOUND);
    expect(ctx.err()).toMatch(/no agents-trust-summary\.json/);
  });
  it("agent-not-in-summary exits 2", async () => {
    const summary = makeAgentSummary({});
    const fetcher = stubFetcher({
      files: { "store/tenant/sage3c/agents-trust-summary.json": JSON.stringify(summary) },
    });
    const ctx = makeIo({ fetcher });
    const code = await runAgent(["missing-agent"], ctx.io);
    expect(code).toBe(EXIT_NOT_FOUND);
    expect(ctx.err()).toMatch(/agent "missing-agent" not present/);
  });
  it("--json emits the row with agent_id included", async () => {
    const summary = makeAgentSummary({
      "claude-opus-4-7": {
        n_assessments: 4,
        avg_process_quality: 0.7,
        avg_iteration_count: 1.5,
        total_regressions_introduced: 0,
        admin_merge_count: 0,
        bypass_count: 0,
        last_seen_at: "2026-05-27T00:00:00Z",
      },
    });
    const fetcher = stubFetcher({
      files: { "store/tenant/sage3c/agents-trust-summary.json": JSON.stringify(summary) },
    });
    const ctx = makeIo({ fetcher });
    const code = await runAgent(["claude-opus-4-7", "--json"], ctx.io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(ctx.out());
    expect(parsed.agent_id).toBe("claude-opus-4-7");
    expect(parsed.n_assessments).toBe(4);
  });
});
