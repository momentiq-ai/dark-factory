// Issue #106 — round-trip + wire-format tests for the new optional
// `requiresHumanJudgment?: boolean` field on `ReviewFinding`. The field
// is the LLM's self-assessment that the finding cannot be objectively
// verified; consumers MAY render flagged findings differently. Aggregation
// math is unchanged — the field is presentation-only at the CLI layer.
//
// Two invariants tested here:
//   1. Optional + omitted == absent (NOT `false`). Consumers must be
//      able to distinguish "the critic didn't report" from "the critic
//      reported false". Tested via the strict equality of the parsed
//      object to a fixture that omits the key entirely.
//   2. Lossless JSON round-trip — `JSON.parse(JSON.stringify(parsed))`
//      preserves both omitted-and-false-and-true wire shapes.

import { describe, expect, it } from "vitest";
import { parseCriticResult, parseReviewArtifact } from "../src/index.js";

const baseResult = {
  criticId: "codex",
  status: "complete" as const,
  verdict: "CHANGES_REQUESTED" as const,
  requiresHumanJudgment: false,
  summary: "found two findings",
  validation: { qualityGateResults: [], qualityGatesMissing: [] },
  reviewer: {
    name: "codex",
    adapter: "codex-sdk",
    model: { id: "gpt-5.5", params: [] },
    runtime: "node",
  },
  confidence: "high" as const,
};

const baseFinding = {
  severity: "high" as const,
  category: "design",
  file: "src/api.ts",
  line: 42,
  evidence: "method signature ambiguous",
  impact: "consumers may pass wrong arg",
  requiredFix: "rename parameter to clarify intent",
};

const blockingSeverities = ["blocker", "high"] as const;

describe("ReviewFinding.requiresHumanJudgment — issue #106", () => {
  it("round-trips requiresHumanJudgment: true into the parsed finding", () => {
    const parsed = parseCriticResult(
      {
        ...baseResult,
        findings: [{ ...baseFinding, requiresHumanJudgment: true }],
      },
      [...blockingSeverities],
    );
    expect(parsed.findings[0]?.requiresHumanJudgment).toBe(true);
  });

  it("round-trips requiresHumanJudgment: false (explicit) into the parsed finding", () => {
    const parsed = parseCriticResult(
      {
        ...baseResult,
        findings: [{ ...baseFinding, requiresHumanJudgment: false }],
      },
      [...blockingSeverities],
    );
    expect(parsed.findings[0]?.requiresHumanJudgment).toBe(false);
    // Explicit false must round-trip as `false`, NOT be elided.
    expect("requiresHumanJudgment" in parsed.findings[0]!).toBe(true);
  });

  it("preserves omitted-vs-false: absent key parses as undefined (NOT false)", () => {
    const parsed = parseCriticResult(
      { ...baseResult, findings: [baseFinding] },
      [...blockingSeverities],
    );
    // The whole point of the wire-level distinction: consumers must be
    // able to tell "critic didn't report" (undefined) from "critic
    // reported false" (false).
    expect(parsed.findings[0]?.requiresHumanJudgment).toBeUndefined();
    expect("requiresHumanJudgment" in parsed.findings[0]!).toBe(false);
  });

  it("rejects non-boolean requiresHumanJudgment values", () => {
    expect(() =>
      parseCriticResult(
        {
          ...baseResult,
          findings: [{ ...baseFinding, requiresHumanJudgment: "yes" }],
        },
        [...blockingSeverities],
      ),
    ).toThrow(/requiresHumanJudgment/);
  });

  it("artifact JSON round-trip preserves the omitted-vs-false distinction", () => {
    // Build a fresh artifact (the easiest path: serialize + reparse).
    const artifactRaw = {
      version: 2 as const,
      status: "complete" as const,
      repo: "test-repo",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      parent: "0000000000000000000000000000000000000000",
      range: "0000..abcd",
      diffHash: "deadbeef",
      artifactScope: "git-common-dir" as const,
      gateVerdict: "CHANGES_REQUESTED" as const,
      aggregationPolicy: "block-if-any" as const,
      criticResults: [
        {
          ...baseResult,
          findings: [
            { ...baseFinding, file: "src/a.ts", requiresHumanJudgment: true },
            { ...baseFinding, file: "src/b.ts", requiresHumanJudgment: false },
            { ...baseFinding, file: "src/c.ts" }, // omitted
          ],
        },
      ],
      createdAt: "2026-06-01T00:00:00Z",
    };
    const parsed = parseReviewArtifact(artifactRaw, [...blockingSeverities]);
    const findings = parsed.criticResults[0]!.findings;

    // Parsed in-memory shape
    expect(findings[0]?.requiresHumanJudgment).toBe(true);
    expect(findings[1]?.requiresHumanJudgment).toBe(false);
    expect(findings[2]?.requiresHumanJudgment).toBeUndefined();
    expect("requiresHumanJudgment" in findings[2]!).toBe(false);

    // Lossless JSON round-trip — the three wire shapes survive
    // serialize → reparse → re-serialize.
    const roundTripped = parseReviewArtifact(
      JSON.parse(JSON.stringify(parsed)),
      [...blockingSeverities],
    );
    const rt = roundTripped.criticResults[0]!.findings;
    expect(rt[0]?.requiresHumanJudgment).toBe(true);
    expect(rt[1]?.requiresHumanJudgment).toBe(false);
    expect(rt[2]?.requiresHumanJudgment).toBeUndefined();
    expect("requiresHumanJudgment" in rt[2]!).toBe(false);
  });

  it("preserves other finding fields when requiresHumanJudgment is set", () => {
    const parsed = parseCriticResult(
      {
        ...baseResult,
        findings: [
          {
            ...baseFinding,
            symbol: "doThing",
            manifestoSection: "§3",
            requiresHumanJudgment: true,
          },
        ],
      },
      [...blockingSeverities],
    );
    const f = parsed.findings[0]!;
    expect(f.severity).toBe("high");
    expect(f.symbol).toBe("doThing");
    expect(f.manifestoSection).toBe("§3");
    expect(f.requiresHumanJudgment).toBe(true);
  });
});
