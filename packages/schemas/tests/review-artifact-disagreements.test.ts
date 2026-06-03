// Issue #118 (cursor finding) — round-trip + wire-format tests for the
// new optional `ReviewArtifact.disagreements` field added by the
// self-consistency probe + `requireCorroborationFor` policy work in
// issue dark-factory-platform#112. The CLI carries the in-memory math
// for this field (covered by the CLI test fleet), but the schemas
// package owns the **wire contract** — downstream consumers (the hosted
// runtime, the dashboard, third-party tooling) parse on-disk JSON via
// `parseReviewArtifact` and MUST see field-shape + round-trip guarantees
// enforced in the package that ships the parser.
//
// Three invariants tested here:
//   1. Optional + omitted vs. emitted-as-empty-array round-trip
//      distinguishably (pre-#112 artifacts omit; new artifacts emit
//      `[]` even with zero demotions so callers can `.length` without
//      undefined check).
//   2. Lossless JSON round-trip — `JSON.parse(JSON.stringify(parsed))`
//      preserves every documented field on each disagreement entry
//      (criticId, file, line?, severity, flag, evidence).
//   3. Field-validation rejects ill-shaped entries (non-string criticId,
//      missing file, invalid severity, missing flag, etc.) so a
//      malformed artifact fails fast at parse time rather than crashing
//      a downstream consumer that assumed the shape.

import { describe, expect, it } from "vitest";
import { parseReviewArtifact } from "../src/index.js";

const baseResult = {
  criticId: "gemini",
  status: "complete" as const,
  verdict: "CHANGES_REQUESTED" as const,
  requiresHumanJudgment: false,
  summary: "found one finding",
  validation: { qualityGateResults: [], qualityGatesMissing: [] },
  reviewer: {
    name: "gemini",
    adapter: "gemini-sdk",
    model: { id: "gemini-2.5-pro", params: [] },
    runtime: "node",
  },
  confidence: "high" as const,
  findings: [
    {
      severity: "blocker" as const,
      category: "domain",
      file: "src/api.ts",
      line: 42,
      evidence: "argv handling assumes 1-based index",
      impact: "first arg is dropped on Node 24",
      requiredFix: "use process.argv.slice(2)",
      selfInconsistent: true,
    },
  ],
};

const baseArtifact = {
  version: 2 as const,
  status: "complete" as const,
  repo: "test-repo",
  commit: "abcdef0123456789abcdef0123456789abcdef01",
  parent: "0000000000000000000000000000000000000000",
  range: "0000..abcd",
  diffHash: "deadbeef",
  artifactScope: "git-common-dir" as const,
  gateVerdict: "APPROVED" as const,
  aggregationPolicy: "min-complete-quorum" as const,
  criticResults: [baseResult],
  createdAt: "2026-06-01T00:00:00Z",
};

const blockingSeverities = ["blocker", "high"] as const;

const baseDisagreement = {
  criticId: "gemini",
  file: "src/api.ts",
  line: 42,
  severity: "blocker" as const,
  flag: "self_inconsistent",
  evidence: "probe judged the finding inconsistent with the cited file",
};

describe("ReviewArtifact.disagreements — issue #118 (PR-118 cursor finding)", () => {
  it("round-trips an empty disagreements array (artifact emitted by post-#112 CLI with no demotions)", () => {
    const parsed = parseReviewArtifact(
      { ...baseArtifact, disagreements: [] },
      [...blockingSeverities],
    );
    expect(parsed.disagreements).toEqual([]);
    expect("disagreements" in parsed).toBe(true);
  });

  it("preserves omitted-vs-empty-array: legacy pre-#112 artifact parses as undisturbed", () => {
    const parsed = parseReviewArtifact(baseArtifact, [...blockingSeverities]);
    // The whole point of the wire-level distinction: consumers must be
    // able to tell "this artifact was emitted by a pre-#112 CLI"
    // (undefined) from "this CLI ran with the policy and recorded zero
    // demotions" ([]).
    expect(parsed.disagreements).toBeUndefined();
    expect("disagreements" in parsed).toBe(false);
  });

  it("round-trips a populated disagreements entry with all documented fields", () => {
    const parsed = parseReviewArtifact(
      { ...baseArtifact, disagreements: [baseDisagreement] },
      [...blockingSeverities],
    );
    const d = parsed.disagreements?.[0];
    expect(d?.criticId).toBe("gemini");
    expect(d?.file).toBe("src/api.ts");
    expect(d?.line).toBe(42);
    expect(d?.severity).toBe("blocker");
    expect(d?.flag).toBe("self_inconsistent");
    expect(d?.evidence).toBe(baseDisagreement.evidence);
  });

  it("round-trips a disagreement entry WITHOUT line (line is optional per schema)", () => {
    const { line: _drop, ...noLine } = baseDisagreement;
    void _drop;
    const parsed = parseReviewArtifact(
      { ...baseArtifact, disagreements: [noLine] },
      [...blockingSeverities],
    );
    const d = parsed.disagreements?.[0];
    expect(d?.line).toBeUndefined();
    expect("line" in (d ?? {})).toBe(false);
    expect(d?.criticId).toBe("gemini");
    expect(d?.file).toBe("src/api.ts");
  });

  it("lossless JSON round-trip preserves every disagreement field shape", () => {
    const artifactRaw = {
      ...baseArtifact,
      disagreements: [
        baseDisagreement,
        { ...baseDisagreement, criticId: "cursor", file: "src/b.ts" },
        // Line omitted on one entry to exercise the optional path.
        {
          criticId: "codex",
          file: "src/c.ts",
          severity: "high" as const,
          flag: "self_inconsistent",
          evidence: "",
        },
      ],
    };
    const parsed = parseReviewArtifact(artifactRaw, [...blockingSeverities]);
    const roundTripped = parseReviewArtifact(
      JSON.parse(JSON.stringify(parsed)),
      [...blockingSeverities],
    );
    expect(roundTripped.disagreements?.length).toBe(3);
    expect(roundTripped.disagreements?.[0]?.criticId).toBe("gemini");
    expect(roundTripped.disagreements?.[0]?.line).toBe(42);
    expect(roundTripped.disagreements?.[1]?.criticId).toBe("cursor");
    expect(roundTripped.disagreements?.[1]?.file).toBe("src/b.ts");
    expect(roundTripped.disagreements?.[2]?.criticId).toBe("codex");
    expect(roundTripped.disagreements?.[2]?.severity).toBe("high");
    expect(roundTripped.disagreements?.[2]?.line).toBeUndefined();
    expect(roundTripped.disagreements?.[2]?.evidence).toBe("");
  });

  it("rejects a disagreement entry missing criticId", () => {
    const { criticId: _drop, ...broken } = baseDisagreement;
    void _drop;
    expect(() =>
      parseReviewArtifact(
        { ...baseArtifact, disagreements: [broken] },
        [...blockingSeverities],
      ),
    ).toThrow(/criticId/);
  });

  it("rejects a disagreement entry missing file", () => {
    const { file: _drop, ...broken } = baseDisagreement;
    void _drop;
    expect(() =>
      parseReviewArtifact(
        { ...baseArtifact, disagreements: [broken] },
        [...blockingSeverities],
      ),
    ).toThrow(/\.file/);
  });

  it("rejects a disagreement entry with an invalid severity enum value", () => {
    expect(() =>
      parseReviewArtifact(
        {
          ...baseArtifact,
          disagreements: [{ ...baseDisagreement, severity: "catastrophic" }],
        },
        [...blockingSeverities],
      ),
    ).toThrow(/severity/);
  });

  it("rejects a disagreement entry missing flag", () => {
    const { flag: _drop, ...broken } = baseDisagreement;
    void _drop;
    expect(() =>
      parseReviewArtifact(
        { ...baseArtifact, disagreements: [broken] },
        [...blockingSeverities],
      ),
    ).toThrow(/flag/);
  });

  it("rejects a non-array disagreements value", () => {
    expect(() =>
      parseReviewArtifact(
        { ...baseArtifact, disagreements: "not an array" },
        [...blockingSeverities],
      ),
    ).toThrow(/disagreements/);
  });

  it("accepts disagreements: null as legacy-equivalent (parses as undefined)", () => {
    // The parser tolerates both `undefined` (key absent) and `null`
    // because some legacy serializers emit `null` for omitted optional
    // fields. Round-trip parity is preserved: the parsed value is
    // `undefined`, NOT an empty array (that distinction is what
    // separates "pre-#112 artifact" from "post-#112 with zero
    // demotions").
    const parsed = parseReviewArtifact(
      { ...baseArtifact, disagreements: null },
      [...blockingSeverities],
    );
    expect(parsed.disagreements).toBeUndefined();
    expect("disagreements" in parsed).toBe(false);
  });
});
