// Cycle 21 — Evidence-Gated Validation Routes.
//
// `QualityGateEvidence.diffHash?` content-binding down-payment
// (`momentiq-ai/dark-factory#186`). Additive optional field: existing
// v1/v2 evidence WITHOUT a diffHash must keep parsing identically.
import { describe, expect, it } from "vitest";

import { parseQualityGateEvidence, SchemaError } from "../src/index.js";

function baseEvidence(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    commit: "a".repeat(40),
    generatedAt: "2026-06-08T00:00:00Z",
    results: [],
    ...extra,
  };
}

describe("QualityGateEvidence.diffHash (#186)", () => {
  it("parses evidence WITHOUT diffHash identically (back-compat)", () => {
    const parsed = parseQualityGateEvidence(baseEvidence());
    expect(parsed.diffHash).toBeUndefined();
    expect("diffHash" in parsed).toBe(false);
  });

  it("accepts and preserves a string diffHash", () => {
    const parsed = parseQualityGateEvidence(
      baseEvidence({ diffHash: "sha256:deadbeef" }),
    );
    expect(parsed.diffHash).toBe("sha256:deadbeef");
  });

  it("rejects a non-string diffHash", () => {
    expect(() =>
      parseQualityGateEvidence(baseEvidence({ diffHash: 123 })),
    ).toThrow(SchemaError);
  });
});
