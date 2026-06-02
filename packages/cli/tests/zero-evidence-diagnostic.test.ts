// Issue #51 — loud post-commit diagnostic for zero-evidence reviews.
//
// `buildZeroEvidenceDiagnostic` is the pure helper behind the
// post-completion diagnostic emitted by `cmdReview`. When a review
// completes with 0/N critics producing evidence (every critic in `error`
// state), the helper produces a loud stderr block that:
//
//   1. Classifies each critic's failure mode (no_auth, no_config,
//      transport_error, schema_violation, unknown) by inspecting the
//      `CriticError.code` and `CriticError.message`.
//   2. Maps each classification to a specific remediation hint
//      (e.g., "run `codex login`", "set CURSOR_API_KEY").
//   3. Always cites the artifact JSON path so the operator can dig
//      deeper.
//
// The helper is pure: takes only the artifact + jsonPath + an optional
// "configHasProfiles + profile state" flag and returns a string. No I/O,
// no env reads, no time dependence.
//
// Coverage:
//   - Detection: `isZeroEvidence` true iff completedCount === 0 && totalCount > 0.
//   - Classification: per-critic error → remediation mapping for
//     each known shape (no_auth, no_config, transport, schema).
//   - Generic fallback when no specific shape matches.
//   - Always includes "details: <jsonPath>".
//   - Doesn't fire (returns isZeroEvidence=false) when ≥1 critic completed.
//   - Doesn't fire (returns isZeroEvidence=false) when totalCount === 0.

import { describe, it, test, expect } from "vitest";
import { buildZeroEvidenceDiagnostic } from "../src/report.js";
import type {
  CriticResult,
  ReviewArtifact,
} from "@momentiq/dark-factory-schemas";

const JSON_PATH = "/repo/.git/agent-reviews/abc123.json";

function completed(criticId: string): CriticResult {
  return {
    criticId,
    status: "complete",
    verdict: "APPROVED",
    requiresHumanJudgment: false,
    reviewer: {
      name: criticId,
      adapter: "test-adapter",
      model: { id: "test-model", params: [] },
      runtime: "local",
    },
    summary: "ok",
    findings: [],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
  };
}

function errored(
  criticId: string,
  message: string,
  code?: string,
): CriticResult {
  return {
    criticId,
    status: "error",
    requiresHumanJudgment: false,
    reviewer: {
      name: criticId,
      adapter: "test-adapter",
      model: { id: "test-model", params: [] },
      runtime: "local",
    },
    summary: "errored",
    findings: [],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "unknown",
    error: {
      message,
      retryable: false,
      ...(code !== undefined ? { code } : {}),
    },
  };
}

function artifact(results: CriticResult[]): ReviewArtifact {
  return {
    version: 2,
    status: "complete",
    repo: "test",
    commit: "abc1230000000000000000000000000000000000",
    parent: "y".repeat(40),
    range: "y..x",
    diffHash: "deadbeef",
    artifactScope: "git-common-dir",
    aggregationPolicy: "min-complete-quorum",
    criticResults: results,
    createdAt: "2026-06-01T00:00:00.000Z",
  };
}

describe("buildZeroEvidenceDiagnostic — detection", () => {
  it("isZeroEvidence=true when every critic is in `error` state", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([
        errored("cursor-local", "boom"),
        errored("codex-local", "boom"),
      ]),
      JSON_PATH,
    );
    expect(d.isZeroEvidence).toBe(true);
    expect(d.stderr).toMatch(
      /df: review COMPLETED with 0\/2 critics producing evidence — gate will block at push time/,
    );
  });

  it("isZeroEvidence=false when at least one critic completed", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([
        completed("cursor-local"),
        errored("codex-local", "boom"),
      ]),
      JSON_PATH,
    );
    expect(d.isZeroEvidence).toBe(false);
    expect(d.stderr).toBe("");
  });

  it("isZeroEvidence=false when there are zero critics (no profile or empty profile)", () => {
    const d = buildZeroEvidenceDiagnostic(artifact([]), JSON_PATH);
    // Empty critic set is a different failure (no critics configured);
    // the dedicated branch is the "no_critics_configured" mode handled
    // by the option flag below — not the "0/N producing evidence" mode.
    expect(d.isZeroEvidence).toBe(false);
  });

  it("always cites the artifact JSON path when isZeroEvidence is true", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([errored("c1", "x")]),
      JSON_PATH,
    );
    expect(d.stderr).toMatch(new RegExp(`details: ${JSON_PATH.replace(/[/.]/g, "\\$&")}`));
  });

  it("always emits the leading 'df: fix one of:' framing", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([errored("c1", "x")]),
      JSON_PATH,
    );
    expect(d.stderr).toMatch(/df: fix one of:/);
  });
});

describe("buildZeroEvidenceDiagnostic — classification + remediation", () => {
  test("no_auth (codex 'no auth source pinned') → 'pin profiles.<name>.auth' hint", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([
        errored(
          "codex-local",
          `codex critic "codex-local" has no auth source pinned. Set profiles.<name>.auth["codex-local"] to "chatgpt" or "api".`,
        ),
      ]),
      JSON_PATH,
    );
    expect(d.isZeroEvidence).toBe(true);
    expect(d.stderr).toMatch(/codex-local/);
    // Specific hint mentions profile auth pinning AND `codex login`
    // — both are the documented remediations from the codex adapter.
    expect(d.stderr).toMatch(/codex login|profiles\.[a-z<>]+\.auth/);
  });

  test("no_auth (CURSOR_API_KEY not set) → 'export CURSOR_API_KEY' hint", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([
        errored("cursor-local", "CURSOR_API_KEY is not set; cannot run Cursor critic"),
      ]),
      JSON_PATH,
    );
    expect(d.isZeroEvidence).toBe(true);
    expect(d.stderr).toMatch(/CURSOR_API_KEY/);
  });

  test("no_auth (GEMINI_API_KEY not set) → 'export GEMINI_API_KEY' hint", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([
        errored(
          "gemini-local",
          "GEMINI_API_KEY is not set; cannot run Gemini critic",
        ),
      ]),
      JSON_PATH,
    );
    expect(d.isZeroEvidence).toBe(true);
    expect(d.stderr).toMatch(/GEMINI_API_KEY/);
  });

  test("transport error (capacity_exceeded / rate_limited) → 'retry' hint", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([
        errored(
          "codex-local",
          "Upstream model gpt-5.5 returned capacity_exceeded after retry policy exhausted",
          "rate_limited",
        ),
      ]),
      JSON_PATH,
    );
    expect(d.isZeroEvidence).toBe(true);
    expect(d.stderr).toMatch(/transport|retry|rate.?limit|capacity/i);
  });

  test("schema violation (invalid response shape) → 'check adapter version' hint", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([
        errored(
          "cursor-local",
          "schema_violation: critic returned malformed verdict",
          "schema_violation",
        ),
      ]),
      JSON_PATH,
    );
    expect(d.isZeroEvidence).toBe(true);
    expect(d.stderr).toMatch(/schema|adapter version|upgrade/i);
  });

  test("unknown / unclassifiable error → generic fallback remediation", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([errored("mystery-local", "something weird happened")]),
      JSON_PATH,
    );
    expect(d.isZeroEvidence).toBe(true);
    // Generic hints point at `df doctor` so the operator can triage
    // when the message didn't classify.
    expect(d.stderr).toMatch(/df doctor/);
  });

  test("explicit `configHasProfiles: false` adds 'add profiles block' hint", () => {
    // When the post-commit caller detected the profiles block is
    // missing entirely (the sage-blueprint seed bug), the helper
    // surfaces a top-line remediation pointing at the config.
    const d = buildZeroEvidenceDiagnostic(
      artifact([errored("c1", "anything")]),
      JSON_PATH,
      { configHasProfiles: false },
    );
    expect(d.isZeroEvidence).toBe(true);
    expect(d.stderr).toMatch(/profiles.*\.agent-review\/config\.json|add.*profiles/i);
  });

  test("multi-critic mix lists per-critic remediations", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([
        errored("cursor-local", "CURSOR_API_KEY is not set; cannot run Cursor critic"),
        errored(
          "codex-local",
          `codex critic "codex-local" has no auth source pinned`,
        ),
      ]),
      JSON_PATH,
    );
    expect(d.isZeroEvidence).toBe(true);
    expect(d.stderr).toMatch(/cursor-local/);
    expect(d.stderr).toMatch(/codex-local/);
    expect(d.stderr).toMatch(/CURSOR_API_KEY/);
    expect(d.stderr).toMatch(/codex login|profiles\.[a-z<>]+\.auth/);
  });
});

describe("buildZeroEvidenceDiagnostic — format invariants", () => {
  it("every emitted line starts with 'df:'", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([errored("c1", "boom")]),
      JSON_PATH,
    );
    expect(d.isZeroEvidence).toBe(true);
    const lines = d.stderr.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      expect(line.startsWith("df:")).toBe(true);
    }
  });

  it("ends with a trailing newline so callers can append safely", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([errored("c1", "boom")]),
      JSON_PATH,
    );
    expect(d.stderr.endsWith("\n")).toBe(true);
  });

  it("returns empty stderr when isZeroEvidence is false", () => {
    const d = buildZeroEvidenceDiagnostic(
      artifact([completed("c1")]),
      JSON_PATH,
    );
    expect(d.stderr).toBe("");
  });
});
