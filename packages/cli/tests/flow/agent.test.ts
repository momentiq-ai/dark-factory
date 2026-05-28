import { describe, expect, it } from "vitest";

import {
  DfAssessmentsClient,
  FixtureFetcher,
} from "../../src/flow/_lib/df-assessments-client.js";
import {
  buildAgentRollup,
  cmdAgent,
  parseAgentArgs,
} from "../../src/flow/agent.js";
import type {
  AgentTrustAgentSummary,
  AgentTrustLedgerRow,
} from "../../src/flow/types.js";
import { fixturePath } from "../_helpers.js";

const FIXTURE_ROOT = fixturePath("df-assessments");

function mkClient(): DfAssessmentsClient {
  return new DfAssessmentsClient(new FixtureFetcher(FIXTURE_ROOT));
}

describe("parseAgentArgs", () => {
  it("accepts a positional agent id", () => {
    const f = parseAgentArgs(["claude-opus-4-7"]);
    expect(f.agentId).toBe("claude-opus-4-7");
    expect(f.tenant).toBe("sage3c");
    expect(f.json).toBe(false);
  });

  it("accepts --json + --tenant", () => {
    const f = parseAgentArgs(["claude-opus-4-7", "--tenant", "x", "--json"]);
    expect(f.tenant).toBe("x");
    expect(f.json).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(() => parseAgentArgs(["--bogus"])).toThrow(/unknown flag/);
  });

  it("rejects multiple positionals", () => {
    expect(() => parseAgentArgs(["a", "b"])).toThrow(/unexpected positional/);
  });
});

describe("buildAgentRollup", () => {
  it("returns null when both summary and ledger are absent", () => {
    expect(buildAgentRollup("nobody", null, [])).toBeNull();
  });

  it("computes avg_outcome_quality + most_frequent_pattern from ledger", () => {
    const rows: AgentTrustLedgerRow[] = [
      mkLedgerRow({
        outcome_quality: 0.8,
        patterns_attributed: ["pattern-a", "pattern-b"],
      }),
      mkLedgerRow({
        outcome_quality: 0.9,
        patterns_attributed: ["pattern-a"],
      }),
    ];
    const summary: AgentTrustAgentSummary = {
      n_assessments: 2,
      avg_process_quality: 0.5,
      avg_iteration_count: 1.5,
      total_regressions_introduced: 0,
      admin_merge_count: 0,
      bypass_count: 0,
      last_seen_at: "2026-05-27T15:05:11Z",
    };
    const r = buildAgentRollup("agent-x", summary, rows);
    expect(r).not.toBeNull();
    expect(r!.avg_outcome_quality).toBeCloseTo(0.85);
    expect(r!.most_frequent_pattern).toBe("pattern-a");
    expect(r!.n_assessments).toBe(2);
  });

  it("falls back to ledger-only when summary is absent", () => {
    const rows: AgentTrustLedgerRow[] = [
      mkLedgerRow({ process_quality: 0.6, regressions_introduced: 1 }),
      mkLedgerRow({ process_quality: 0.8, regressions_introduced: 0 }),
    ];
    const r = buildAgentRollup("agent-x", null, rows);
    expect(r).not.toBeNull();
    expect(r!.avg_process_quality).toBeCloseTo(0.7);
    expect(r!.total_regressions_introduced).toBe(1);
    expect(r!.n_assessments).toBe(2);
  });

  it("returns most_frequent_pattern=null when no patterns observed", () => {
    const rows: AgentTrustLedgerRow[] = [
      mkLedgerRow({ patterns_attributed: [] }),
    ];
    const r = buildAgentRollup("agent-x", null, rows);
    expect(r!.most_frequent_pattern).toBeNull();
  });
});

describe("cmdAgent", () => {
  it("exits 0 with rollup text for a known agent", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdAgent({
      client: mkClient(),
      args: ["claude-opus-4-7"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(0);
    expect(cap.stdout).toContain("Agent: claude-opus-4-7");
    expect(cap.stdout).toContain("most_freq_pattern:");
    expect(cap.stderr).toBe("");
  });

  it("emits valid JSON with --json", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdAgent({
      client: mkClient(),
      args: ["claude-opus-4-7", "--json"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout) as { agent_id: string };
    expect(parsed.agent_id).toBe("claude-opus-4-7");
  });

  it("exits 2 for an unknown agent", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdAgent({
      client: mkClient(),
      args: ["nobody"],
      stdout: (s) => {
        cap.stdout += s;
      },
      stderr: (s) => {
        cap.stderr += s;
      },
    });
    expect(code).toBe(2);
    expect(cap.stderr).toContain("no data");
  });

  it("exits 1 when agent-id is missing", async () => {
    const cap = { stdout: "", stderr: "" };
    const code = await cmdAgent({
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
    expect(cap.stderr).toContain("required");
  });
});

// ---------------------------------------------------------------------------

function mkLedgerRow(
  overrides: Partial<AgentTrustLedgerRow> = {},
): AgentTrustLedgerRow {
  return {
    schema_version: 1,
    pr_number: 100,
    merged_at: "2026-05-27T00:00:00Z",
    agent_id: "agent-x",
    process_quality: 0.5,
    outcome_quality: 0.5,
    iteration_count: 0,
    regressions_introduced: 0,
    admin_merge_used: false,
    bypass_used: false,
    patterns_attributed: [],
    assessment_run_id: "test-run",
    ...overrides,
  };
}
