// Cycle 6.3 Stage 1 — round-trip tests for new optional telemetry
// fields on CriticResult: tokensInput, tokensOutput, tokensCached,
// retries. (durationMs already exists.)

import { describe, expect, it } from "vitest";
import { parseCriticResult } from "../src/index.js";

const baseResult = {
  criticId: "codex",
  status: "complete" as const,
  verdict: "APPROVED" as const,
  requiresHumanJudgment: false,
  summary: "looks fine",
  findings: [],
  validation: { qualityGateResults: [], qualityGatesMissing: [] },
  reviewer: {
    name: "codex",
    adapter: "codex-sdk",
    model: { id: "gpt-5.5", params: [] },
    runtime: "node",
  },
  confidence: "high" as const,
};

const blockingSeverities = ["blocker", "high"] as const;

describe("CriticResult — Cycle 6.3 optional telemetry fields", () => {
  it("round-trips tokensInput / tokensOutput / tokensCached / retries when present", () => {
    const parsed = parseCriticResult(
      {
        ...baseResult,
        tokensInput: 18400,
        tokensOutput: 2100,
        tokensCached: 43000,
        retries: 1,
      },
      [...blockingSeverities],
    );
    expect(parsed.tokensInput).toBe(18400);
    expect(parsed.tokensOutput).toBe(2100);
    expect(parsed.tokensCached).toBe(43000);
    expect(parsed.retries).toBe(1);
  });

  it("omits all four fields when absent (back-compat with pre-6.3 artifacts)", () => {
    const parsed = parseCriticResult(baseResult, [...blockingSeverities]);
    expect(parsed.tokensInput).toBeUndefined();
    expect(parsed.tokensOutput).toBeUndefined();
    expect(parsed.tokensCached).toBeUndefined();
    expect(parsed.retries).toBeUndefined();
  });

  it("accepts retries: 0 distinctly from absent", () => {
    const parsed = parseCriticResult(
      { ...baseResult, retries: 0 },
      [...blockingSeverities],
    );
    expect(parsed.retries).toBe(0);
  });

  it("accepts tokensCached without tokensInput (vendor reports cached separately)", () => {
    const parsed = parseCriticResult(
      { ...baseResult, tokensCached: 200 },
      [...blockingSeverities],
    );
    expect(parsed.tokensCached).toBe(200);
    expect(parsed.tokensInput).toBeUndefined();
  });

  it("rejects non-integer tokensInput", () => {
    expect(() =>
      parseCriticResult(
        { ...baseResult, tokensInput: 18.4 },
        [...blockingSeverities],
      ),
    ).toThrow(/tokensInput/);
  });

  it("rejects negative tokensOutput", () => {
    expect(() =>
      parseCriticResult(
        { ...baseResult, tokensOutput: -1 },
        [...blockingSeverities],
      ),
    ).toThrow(/tokensOutput/);
  });

  it("rejects negative retries", () => {
    expect(() =>
      parseCriticResult(
        { ...baseResult, retries: -1 },
        [...blockingSeverities],
      ),
    ).toThrow(/retries/);
  });

  it("rejects non-integer retries", () => {
    expect(() =>
      parseCriticResult(
        { ...baseResult, retries: 1.5 },
        [...blockingSeverities],
      ),
    ).toThrow(/retries/);
  });

  it("preserves existing durationMs round-trip alongside the new fields", () => {
    const parsed = parseCriticResult(
      {
        ...baseResult,
        durationMs: 42300,
        tokensInput: 18400,
        tokensOutput: 2100,
      },
      [...blockingSeverities],
    );
    expect(parsed.durationMs).toBe(42300);
    expect(parsed.tokensInput).toBe(18400);
    expect(parsed.tokensOutput).toBe(2100);
  });
});
