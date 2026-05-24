import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGGREGATION_POLICIES,
  CRITIC_STATUSES,
  REVIEW_SEVERITIES,
  REVIEW_VERDICTS,
  SchemaError,
  parseAgentReviewConfig,
  parseCriticResult,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Smoke tests — exercise the public surface to catch packaging regressions.
// Comprehensive parser tests are in @momentiq/dark-factory-cli's test suite
// (the parsers were tested there before the Phase B extraction). The schemas
// package re-exports them; this smoke layer ensures the exports stay live
// and a known-good config parses cleanly.

describe("@momentiq/dark-factory-schemas package surface", () => {
  it("exports the constant lists", () => {
    expect(AGGREGATION_POLICIES).toContain("block-if-any");
    expect(AGGREGATION_POLICIES).toContain("min-complete-quorum");
    expect(CRITIC_STATUSES).toContain("complete");
    expect(REVIEW_SEVERITIES).toContain("blocker");
    expect(REVIEW_VERDICTS).toContain("APPROVED");
  });

  it("exports SchemaError class that's throwable", () => {
    expect(() => {
      throw new SchemaError("$.foo", "test message");
    }).toThrow("schema($.foo): test message");
  });

  it("parseAgentReviewConfig accepts the canonical fixture from sage3c", () => {
    const raw = JSON.parse(
      readFileSync(resolve(HERE, "fixture-config.json"), "utf8"),
    );
    const parsed = parseAgentReviewConfig(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.critics).toHaveLength(1);
    expect(parsed.critics[0]?.id).toBe("cursor-local-chief-engineer");
    expect(parsed.aggregation.policy).toBe("block-if-any");
  });

  it("parseAgentReviewConfig rejects junk", () => {
    expect(() => parseAgentReviewConfig({ version: "wrong-type" })).toThrow(
      SchemaError,
    );
  });

  it("parseCriticResult is callable from the package surface", () => {
    // Bare existence smoke — parser semantics tested elsewhere.
    expect(typeof parseCriticResult).toBe("function");
  });
});
