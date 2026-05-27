// Unit tests for the df_findings / df_show_run MCP tools' pure
// mapping logic — cycle5 Phase 1 step 3b.
//
// Integration tests that exercise the full tools/call flow against a
// real artifact-on-disk fixture (with git init) live in
// tests/mcp/server.test.ts so the catalog pin + JSON-RPC contract
// stay together.
//
// These tests pin:
//   - mapFindingForSpec: ReviewFinding → spec shape.
//     * `rule` = `category` (the natural rule-analog field).
//     * `message` = `evidence` (impact + requiredFix NOT included —
//       caller wanting the full context calls df_show_run instead).
//     * `file`, `line` omitted when undefined.
//   - mapCriticForSpec: CriticResult → narrowed critic shape.
//     `verdict` omitted when absent (status='running'/'pending'/'error').
//   - mapArtifactForFindings: full artifact → df_findings result.

import { describe, expect, it } from "vitest";

import type {
  CriticResult,
  ReviewArtifact,
  ReviewFinding,
} from "@momentiq/dark-factory-schemas";

import {
  mapArtifactForFindings,
  mapCriticForSpec,
  mapFindingForSpec,
} from "../../../src/mcp/tools/findings.js";

const FINDING_FULL: ReviewFinding = {
  severity: "blocker",
  category: "untyped-any",
  file: "src/foo.ts",
  line: 42,
  evidence: "function bar(x: any) { ... }",
  impact: "Loses type safety in the bar code path.",
  requiredFix: "Annotate x with the actual parameter type.",
};

const FINDING_NO_LOCATION: ReviewFinding = {
  severity: "medium",
  category: "spec-drift",
  evidence: "config.json claims version 2 but parser only accepts 1.",
  impact: "Future config bumps will silently fall back.",
  requiredFix: "Update parser to accept version 2.",
};

const CRITIC_COMPLETE: CriticResult = {
  criticId: "cursor-local-chief-engineer",
  status: "complete",
  verdict: "CHANGES_REQUESTED",
  requiresHumanJudgment: false,
  reviewer: {
    name: "Cursor Local Critic",
    adapter: "cursor-sdk",
    model: { id: "gpt-5.5", params: [] },
    runtime: "local",
  },
  summary: "1 blocker, 1 medium.",
  findings: [FINDING_FULL, FINDING_NO_LOCATION],
  validation: { qualityGateResults: [], qualityGatesMissing: [] },
  confidence: "high",
  durationMs: 1234,
};

const CRITIC_RUNNING: CriticResult = {
  criticId: "codex-local-chief-engineer",
  status: "running",
  requiresHumanJudgment: false,
  reviewer: {
    name: "Codex Local Critic",
    adapter: "codex-sdk",
    model: { id: "gpt-5.5", params: [] },
    runtime: "local",
  },
  summary: "",
  findings: [],
  validation: { qualityGateResults: [], qualityGatesMissing: [] },
  confidence: "unknown",
};

const ARTIFACT: ReviewArtifact = {
  version: 2,
  status: "complete",
  repo: "momentiq-ai/dark-factory",
  commit: "abcdef1234567890abcdef1234567890abcdef12",
  parent: "0123456789abcdef0123456789abcdef01234567",
  range: "0123456..abcdef1",
  diffHash: "sha256:deadbeef",
  artifactScope: "git-common-dir",
  gateVerdict: "CHANGES_REQUESTED",
  aggregationPolicy: "block-if-any",
  criticResults: [CRITIC_COMPLETE, CRITIC_RUNNING],
  createdAt: "2026-05-27T15:00:00.000Z",
};

describe("mapFindingForSpec (cycle5 Phase 1 step 3b)", () => {
  it("maps the full-field finding: severity, file, line, rule(=category), message(=evidence)", () => {
    expect(mapFindingForSpec(FINDING_FULL)).toEqual({
      severity: "blocker",
      file: "src/foo.ts",
      line: 42,
      rule: "untyped-any",
      message: "function bar(x: any) { ... }",
    });
  });

  it("omits file + line when the source finding has neither", () => {
    const out = mapFindingForSpec(FINDING_NO_LOCATION);
    expect(out).toEqual({
      severity: "medium",
      rule: "spec-drift",
      message: "config.json claims version 2 but parser only accepts 1.",
    });
    // Defensive: the optional fields must NOT be present as undefined
    // either (clients that schema-validate strictly should not see
    // file=undefined keys).
    expect("file" in out).toBe(false);
    expect("line" in out).toBe(false);
  });

  it("does NOT pull impact or requiredFix into message (df_show_run is the rich view)", () => {
    const out = mapFindingForSpec(FINDING_FULL);
    expect(out.message).not.toContain("Loses type safety");
    expect(out.message).not.toContain("Annotate x");
  });
});

describe("mapCriticForSpec (cycle5 Phase 1 step 3b)", () => {
  it("maps the complete critic shape and includes verdict when set", () => {
    const out = mapCriticForSpec(CRITIC_COMPLETE);
    expect(out.id).toBe("cursor-local-chief-engineer");
    expect(out.status).toBe("complete");
    expect(out.verdict).toBe("CHANGES_REQUESTED");
    expect(out.findings).toHaveLength(2);
  });

  it("omits verdict when the critic is mid-run (no terminal verdict yet)", () => {
    const out = mapCriticForSpec(CRITIC_RUNNING);
    expect(out.id).toBe("codex-local-chief-engineer");
    expect(out.status).toBe("running");
    expect("verdict" in out).toBe(false);
    expect(out.findings).toEqual([]);
  });
});

describe("mapArtifactForFindings (cycle5 Phase 1 step 3b)", () => {
  it("returns commit + critics[] in the spec shape", () => {
    const out = mapArtifactForFindings(ARTIFACT);
    expect(out.commit).toBe(ARTIFACT.commit);
    expect(out.critics).toHaveLength(2);
    expect(out.critics[0]?.id).toBe("cursor-local-chief-engineer");
    expect(out.critics[1]?.id).toBe("codex-local-chief-engineer");
    expect(out.critics[0]?.findings).toHaveLength(2);
    expect(out.critics[1]?.findings).toHaveLength(0);
  });
});
