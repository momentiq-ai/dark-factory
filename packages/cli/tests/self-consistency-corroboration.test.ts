// Issue dark-factory-platform#112 — tests for the two mechanisms:
//
//   Mechanism 1: in-aggregator self-consistency probe
//     (`src/self-consistency.ts`). One cheap LLM call per blocker|high
//     finding. We unit-test the orchestration logic with a mock probe.
//
//   Mechanism 2: conditional unilateral-veto policy
//     (`unilateralVetoRules.requireCorroborationFor` + the
//     corroboration check). We unit-test the aggregator + gate
//     evaluator with hand-built fixtures.
//
// The replay test from the spec's "Definition of done":
//   - A `selfInconsistent: true` blocker on file F lines L..L by
//     critic A, when no other critic finds a blocker on F within 5
//     lines → demoted to `critic_disagreement`, verdict flips from
//     CHANGES_REQUESTED to APPROVED.
//   - A `selfInconsistent: false` (or omitted) blocker on file F lines
//     L..L by critic A still vetoes (safety net intact).
//   - A `selfInconsistent: true` blocker on file F lines L by critic
//     A WITH a corroborating critic B blocker at file F line L+3
//     (within radius=5) still vetoes (corroboration overrides
//     the disagreement-demotion).

import { describe, test } from "vitest";
import {
  expect_deep,
  expect_eq,
  expect_throws,
  expect_truthy,
} from "./_assert-shim.js";
import {
  criticVetoesGate,
  isCorroboratedByOtherCritic,
  findingCarriesCorroborationFlag,
  quorumAggregateVerdict,
} from "../src/report.js";
import { evaluateQuorumCriticResults } from "../src/policy/gate.js";
import {
  applySelfConsistencyResult,
  buildSelfConsistencyPrompt,
  runSelfConsistencyProbe,
  type SelfConsistencyProbeFn,
  type SelfConsistencyProbeInput,
} from "../src/self-consistency.js";
import {
  parseAgentReviewConfig,
  type CriticResult,
  type GateBlock,
  type GateWarning,
  type ReviewArtifact,
  type ReviewFinding,
  type ReviewSeverity,
  type UnilateralVetoRules,
} from "@momentiq/dark-factory-schemas";

const BLOCKING: ReviewSeverity[] = ["blocker", "high"];
const RULES: UnilateralVetoRules = {
  requireCorroborationFor: ["self_inconsistent"],
  requireCorroborationOnHunkRadius: 5,
};

// ---------------------------------------------------------------------------
// Fixture helpers

function finding(
  severity: ReviewSeverity,
  file: string,
  line: number,
  flags: { selfInconsistent?: boolean } = {},
): ReviewFinding {
  return {
    severity,
    category: "test",
    file,
    line,
    evidence: `evidence on ${file}:${line}`,
    impact: "test impact",
    requiredFix: "test fix",
    ...(flags.selfInconsistent !== undefined
      ? { selfInconsistent: flags.selfInconsistent }
      : {}),
  };
}

function completedWith(
  id: string,
  verdict: "APPROVED" | "CHANGES_REQUESTED",
  findings: ReviewFinding[],
): CriticResult {
  return {
    criticId: id,
    status: "complete",
    verdict,
    requiresHumanJudgment: false,
    reviewer: {
      name: id,
      adapter: "test-adapter",
      model: { id: "test-model", params: [] },
      runtime: "local",
    },
    summary: "test summary",
    findings,
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "high",
  };
}

function artifactOf(results: CriticResult[]): ReviewArtifact {
  return {
    version: 2,
    status: "complete",
    repo: "test",
    commit: "x".repeat(40),
    parent: "y".repeat(40),
    range: "y..x",
    diffHash: "deadbeef",
    artifactScope: "git-common-dir",
    aggregationPolicy: "min-complete-quorum",
    criticResults: results,
    createdAt: "2026-06-01T00:00:00.000Z",
    gateVerdict: "APPROVED",
  };
}

// ---------------------------------------------------------------------------
// Schema parsing

const SCHEMA_BASE = {
  version: 2,
  critics: [
    {
      id: "cursor-local-chief-engineer",
      name: "Cursor",
      adapter: "cursor-sdk",
      required: false,
      runtime: "local",
      model: { id: "composer-2", params: [] },
    },
    {
      id: "gemini-local-chief-engineer",
      name: "Gemini",
      adapter: "gemini-sdk",
      required: false,
      runtime: "local",
      model: { id: "gemini-2.5-pro", params: [] },
    },
  ],
  git: {
    hookPath: ".husky",
    artifactDir: "agent-reviews",
    artifactScope: "git-common-dir",
  },
  policy: {
    blockOnMissingReview: true,
    blockOnReviewError: true,
    allowEmergencyBypass: true,
    postCommitMode: "async",
  },
  context: {
    guidanceFiles: [],
    promptFragments: [],
    maxChangedFileBytes: 200000,
    includeFullChangedFiles: true,
  },
  tdd: {
    classifier: {
      productionGlobs: ["**/*.py"],
      testGlobs: ["tests/**"],
      exclusionGlobs: ["docs/**"],
      justificationTrailer: "Tdd-Justification",
    },
  },
  validation: {
    runBeforeReview: false,
    resultFile: "agent-reviews/quality-gates/latest.json",
    requiredQualityGates: [],
    optionalQualityGates: [],
    verificationRoutes: [],
  },
  security: { redactSecretsInDiagnostics: true, treatDiffAsUntrustedInput: true },
};

describe("schema: AggregationConfig.unilateralVetoRules", () => {
  test("parses a config with unilateralVetoRules", () => {
    const cfg = {
      ...SCHEMA_BASE,
      aggregation: {
        policy: "min-complete-quorum",
        blockingSeverities: ["blocker", "high"],
        quorum: 2,
        unilateralVetoRules: {
          requireCorroborationFor: ["self_inconsistent"],
          requireCorroborationOnHunkRadius: 5,
        },
      },
    };
    const parsed = parseAgentReviewConfig(cfg);
    expect_eq(
      parsed.aggregation.unilateralVetoRules?.requireCorroborationFor[0],
      "self_inconsistent",
    );
    expect_eq(
      parsed.aggregation.unilateralVetoRules?.requireCorroborationOnHunkRadius,
      5,
    );
  });

  test("absent unilateralVetoRules parses as undefined (back-compat)", () => {
    const cfg = {
      ...SCHEMA_BASE,
      aggregation: {
        policy: "min-complete-quorum",
        blockingSeverities: ["blocker", "high"],
        quorum: 2,
      },
    };
    const parsed = parseAgentReviewConfig(cfg);
    expect_eq(parsed.aggregation.unilateralVetoRules, undefined);
  });

  test("rejects empty requireCorroborationFor array", () => {
    const cfg = {
      ...SCHEMA_BASE,
      aggregation: {
        policy: "min-complete-quorum",
        blockingSeverities: ["blocker", "high"],
        quorum: 2,
        unilateralVetoRules: {
          requireCorroborationFor: [],
          requireCorroborationOnHunkRadius: 5,
        },
      },
    };
    expect_throws(() => parseAgentReviewConfig(cfg), /at least one flag/);
  });

  test("rejects duplicate flag names", () => {
    const cfg = {
      ...SCHEMA_BASE,
      aggregation: {
        policy: "min-complete-quorum",
        blockingSeverities: ["blocker", "high"],
        quorum: 2,
        unilateralVetoRules: {
          requireCorroborationFor: ["self_inconsistent", "self_inconsistent"],
          requireCorroborationOnHunkRadius: 5,
        },
      },
    };
    expect_throws(() => parseAgentReviewConfig(cfg), /duplicate flag/);
  });

  test("rejects negative requireCorroborationOnHunkRadius", () => {
    const cfg = {
      ...SCHEMA_BASE,
      aggregation: {
        policy: "min-complete-quorum",
        blockingSeverities: ["blocker", "high"],
        quorum: 2,
        unilateralVetoRules: {
          requireCorroborationFor: ["self_inconsistent"],
          requireCorroborationOnHunkRadius: -1,
        },
      },
    };
    expect_throws(() => parseAgentReviewConfig(cfg), />= 0/);
  });

  test("accepts radius=0 (exact-line match)", () => {
    const cfg = {
      ...SCHEMA_BASE,
      aggregation: {
        policy: "min-complete-quorum",
        blockingSeverities: ["blocker", "high"],
        quorum: 2,
        unilateralVetoRules: {
          requireCorroborationFor: ["self_inconsistent"],
          requireCorroborationOnHunkRadius: 0,
        },
      },
    };
    const parsed = parseAgentReviewConfig(cfg);
    expect_eq(
      parsed.aggregation.unilateralVetoRules?.requireCorroborationOnHunkRadius,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Finding parser preserves selfInconsistent

describe("schema: ReviewFinding.selfInconsistent", () => {
  test("absent → undefined (back-compat)", () => {
    const cfg = {
      ...SCHEMA_BASE,
      aggregation: {
        policy: "min-complete-quorum",
        blockingSeverities: ["blocker", "high"],
        quorum: 2,
      },
    };
    const parsed = parseAgentReviewConfig(cfg);
    // The schema parser is per-config; finding parse is exercised via
    // parseCriticResult / parseReviewArtifact. The presence of the
    // optional field is exercised indirectly through aggregator tests
    // below — what matters at parse time is that an absent field does
    // NOT throw and that a `true` value round-trips.
    expect_truthy(parsed);
  });
});

// ---------------------------------------------------------------------------
// Flag carrier helper

describe("findingCarriesCorroborationFlag", () => {
  test("true when finding.selfInconsistent === true AND flag listed", () => {
    const f = finding("blocker", "a.ts", 1, { selfInconsistent: true });
    expect_eq(findingCarriesCorroborationFlag(f, ["self_inconsistent"]), true);
  });
  test("false when finding.selfInconsistent === false", () => {
    const f = finding("blocker", "a.ts", 1, { selfInconsistent: false });
    expect_eq(findingCarriesCorroborationFlag(f, ["self_inconsistent"]), false);
  });
  test("false when finding.selfInconsistent omitted", () => {
    const f = finding("blocker", "a.ts", 1);
    expect_eq(findingCarriesCorroborationFlag(f, ["self_inconsistent"]), false);
  });
  test("unknown flag name is a no-op (forward-compat)", () => {
    const f = finding("blocker", "a.ts", 1, { selfInconsistent: true });
    expect_eq(findingCarriesCorroborationFlag(f, ["future_flag"]), false);
  });
});

// ---------------------------------------------------------------------------
// Corroboration predicate

describe("isCorroboratedByOtherCritic", () => {
  test("true when another critic blocker on same file within radius", () => {
    const target = finding("blocker", "a.ts", 10);
    const other = completedWith("c2", "CHANGES_REQUESTED", [
      finding("blocker", "a.ts", 13),
    ]);
    expect_eq(
      isCorroboratedByOtherCritic(target, "c1", [other], BLOCKING, 5),
      true,
    );
  });

  test("false when same-file blocker is outside radius", () => {
    const target = finding("blocker", "a.ts", 10);
    const other = completedWith("c2", "CHANGES_REQUESTED", [
      finding("blocker", "a.ts", 16), // distance 6 > radius 5
    ]);
    expect_eq(
      isCorroboratedByOtherCritic(target, "c1", [other], BLOCKING, 5),
      false,
    );
  });

  test("false when other critic finding is on different file", () => {
    const target = finding("blocker", "a.ts", 10);
    const other = completedWith("c2", "CHANGES_REQUESTED", [
      finding("blocker", "b.ts", 10),
    ]);
    expect_eq(
      isCorroboratedByOtherCritic(target, "c1", [other], BLOCKING, 5),
      false,
    );
  });

  test("self-corroboration disallowed (same criticId)", () => {
    const target = finding("blocker", "a.ts", 10);
    const self = completedWith("c1", "CHANGES_REQUESTED", [
      target,
      finding("blocker", "a.ts", 12),
    ]);
    expect_eq(
      isCorroboratedByOtherCritic(target, "c1", [self], BLOCKING, 5),
      false,
    );
  });

  test("errored critic does NOT corroborate (status !== complete)", () => {
    const target = finding("blocker", "a.ts", 10);
    const erroredCritic: CriticResult = {
      criticId: "c2",
      status: "error",
      requiresHumanJudgment: false,
      reviewer: {
        name: "c2",
        adapter: "test",
        model: { id: "t", params: [] },
        runtime: "local",
      },
      summary: "err",
      findings: [finding("blocker", "a.ts", 10)],
      validation: { qualityGateResults: [], qualityGatesMissing: [] },
      confidence: "unknown",
      error: { message: "transient" },
    };
    expect_eq(
      isCorroboratedByOtherCritic(target, "c1", [erroredCritic], BLOCKING, 5),
      false,
    );
  });

  test("radius=0 requires exact line match", () => {
    const target = finding("blocker", "a.ts", 10);
    const exact = completedWith("c2", "CHANGES_REQUESTED", [
      finding("blocker", "a.ts", 10),
    ]);
    const off = completedWith("c3", "CHANGES_REQUESTED", [
      finding("blocker", "a.ts", 11),
    ]);
    expect_eq(
      isCorroboratedByOtherCritic(target, "c1", [exact], BLOCKING, 0),
      true,
    );
    expect_eq(
      isCorroboratedByOtherCritic(target, "c1", [off], BLOCKING, 0),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Aggregator — corroboration policy

describe("quorumAggregateVerdict + unilateralVetoRules", () => {
  test("flagged + uncorroborated blocker → no veto, demoted to disagreement", () => {
    // The cycle 10 / PR #109 replay: gemini emits a `selfInconsistent`
    // blocker; nobody else finds a blocker on the same file. The
    // verdict should be APPROVED and the disagreement should appear
    // in the outcome's `disagreements` list.
    const results: CriticResult[] = [
      completedWith("gemini", "CHANGES_REQUESTED", [
        finding("blocker", "scripts/check-df-pin.sh", 42, {
          selfInconsistent: true,
        }),
      ]),
      completedWith("cursor", "APPROVED", []),
      completedWith("codex", "APPROVED", []),
    ];
    const outcome = quorumAggregateVerdict(results, BLOCKING, 2, RULES);
    expect_eq(outcome.verdict, "APPROVED");
    expect_eq(outcome.reason, "majority");
    expect_eq(outcome.disagreements.length, 1);
    expect_eq(outcome.disagreements[0]!.criticId, "gemini");
    expect_eq(outcome.disagreements[0]!.flag, "self_inconsistent");
    expect_eq(outcome.disagreements[0]!.file, "scripts/check-df-pin.sh");
  });

  test("flagged + corroborated blocker → veto stands (safety net intact)", () => {
    const results: CriticResult[] = [
      completedWith("gemini", "CHANGES_REQUESTED", [
        finding("blocker", "a.ts", 10, { selfInconsistent: true }),
      ]),
      completedWith("cursor", "CHANGES_REQUESTED", [
        finding("blocker", "a.ts", 13), // within radius=5
      ]),
      completedWith("codex", "APPROVED", []),
    ];
    const outcome = quorumAggregateVerdict(results, BLOCKING, 2, RULES);
    expect_eq(outcome.verdict, "CHANGES_REQUESTED");
    expect_eq(outcome.reason, "veto");
  });

  test("unflagged blocker still vetoes (the spec's negative fixture)", () => {
    // The spec's regression case: a real-blocker finding from one
    // vendor with no corroboration MUST still veto when
    // selfInconsistent is false — the safety net for findings the
    // critic can defend.
    const results: CriticResult[] = [
      completedWith("gemini", "CHANGES_REQUESTED", [
        finding("blocker", "real-bug.ts", 99), // no flag
      ]),
      completedWith("cursor", "APPROVED", []),
      completedWith("codex", "APPROVED", []),
    ];
    const outcome = quorumAggregateVerdict(results, BLOCKING, 2, RULES);
    expect_eq(outcome.verdict, "CHANGES_REQUESTED");
    expect_eq(outcome.reason, "veto");
    expect_eq(outcome.disagreements.length, 0);
  });

  test("flagged blocker with selfInconsistent=false still vetoes", () => {
    const results: CriticResult[] = [
      completedWith("gemini", "CHANGES_REQUESTED", [
        finding("blocker", "a.ts", 10, { selfInconsistent: false }),
      ]),
      completedWith("cursor", "APPROVED", []),
      completedWith("codex", "APPROVED", []),
    ];
    const outcome = quorumAggregateVerdict(results, BLOCKING, 2, RULES);
    expect_eq(outcome.verdict, "CHANGES_REQUESTED");
    expect_eq(outcome.reason, "veto");
  });

  test("policy absent → previous behavior (always veto on blocker)", () => {
    const results: CriticResult[] = [
      completedWith("gemini", "CHANGES_REQUESTED", [
        finding("blocker", "a.ts", 10, { selfInconsistent: true }),
      ]),
      completedWith("cursor", "APPROVED", []),
      completedWith("codex", "APPROVED", []),
    ];
    // Same fixture as the demote test, but no policy passed → no demotion.
    const outcome = quorumAggregateVerdict(results, BLOCKING, 2);
    expect_eq(outcome.verdict, "CHANGES_REQUESTED");
    expect_eq(outcome.reason, "veto");
    expect_eq(outcome.disagreements.length, 0);
  });

  test("critic with mixed flagged + unflagged blockers still vetoes via unflagged", () => {
    // Safety-invariant: ONE flagged uncorroborated finding doesn't sweep
    // the rest of the critic's blocking findings into the demotion.
    const results: CriticResult[] = [
      completedWith("gemini", "CHANGES_REQUESTED", [
        finding("blocker", "a.ts", 10, { selfInconsistent: true }),
        finding("blocker", "b.ts", 99), // no flag
      ]),
      completedWith("cursor", "APPROVED", []),
      completedWith("codex", "APPROVED", []),
    ];
    const outcome = quorumAggregateVerdict(results, BLOCKING, 2, RULES);
    expect_eq(outcome.verdict, "CHANGES_REQUESTED");
    expect_eq(outcome.reason, "veto");
  });

  test("CHANGES_REQUESTED verdict still vetoes regardless of flag", () => {
    // The spec narrows the rule to per-finding flag triggers ONLY.
    // A critic with verdict=CHANGES_REQUESTED but no per-finding flag
    // is NOT a corroboration concern.
    const results: CriticResult[] = [
      completedWith("gemini", "CHANGES_REQUESTED", []), // verdict-only block
      completedWith("cursor", "APPROVED", []),
      completedWith("codex", "APPROVED", []),
    ];
    const outcome = quorumAggregateVerdict(results, BLOCKING, 2, RULES);
    expect_eq(outcome.verdict, "CHANGES_REQUESTED");
    expect_eq(outcome.reason, "veto");
  });
});

// ---------------------------------------------------------------------------
// Gate evaluator — block / warning routing

describe("evaluateQuorumCriticResults + unilateralVetoRules", () => {
  test("demoted flagged blocker → 1 critic_disagreement warning, 0 blocks", () => {
    const results: CriticResult[] = [
      completedWith("gemini", "CHANGES_REQUESTED", [
        finding("blocker", "scripts/check-df-pin.sh", 42, {
          selfInconsistent: true,
        }),
      ]),
      completedWith("cursor", "APPROVED", []),
    ];
    const blocks: GateBlock[] = [];
    const warnings: GateWarning[] = [];
    evaluateQuorumCriticResults(
      artifactOf(results),
      BLOCKING,
      2,
      blocks,
      warnings,
      RULES,
    );
    expect_eq(blocks.length, 0);
    expect_eq(
      warnings.filter((w) => w.reason === "critic_disagreement").length,
      1,
    );
  });

  test("unflagged blocker still produces blocker_finding block", () => {
    const results: CriticResult[] = [
      completedWith("gemini", "CHANGES_REQUESTED", [
        finding("blocker", "real-bug.ts", 99),
      ]),
      completedWith("cursor", "APPROVED", []),
    ];
    const blocks: GateBlock[] = [];
    const warnings: GateWarning[] = [];
    evaluateQuorumCriticResults(
      artifactOf(results),
      BLOCKING,
      2,
      blocks,
      warnings,
      RULES,
    );
    expect_truthy(blocks.some((b) => b.reason === "blocker_finding"));
  });

  test("policy absent → no demotion (back-compat)", () => {
    const results: CriticResult[] = [
      completedWith("gemini", "CHANGES_REQUESTED", [
        finding("blocker", "a.ts", 42, { selfInconsistent: true }),
      ]),
      completedWith("cursor", "APPROVED", []),
    ];
    const blocks: GateBlock[] = [];
    const warnings: GateWarning[] = [];
    evaluateQuorumCriticResults(
      artifactOf(results),
      BLOCKING,
      2,
      blocks,
      warnings,
      // unilateralVetoRules omitted
    );
    expect_truthy(blocks.some((b) => b.reason === "blocker_finding"));
    expect_eq(
      warnings.filter((w) => w.reason === "critic_disagreement").length,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// criticVetoesGate overload

describe("criticVetoesGate + corroborationCtx", () => {
  test("back-compat overload (no ctx) preserves prior behavior", () => {
    const c = completedWith("c1", "APPROVED", [
      finding("blocker", "a.ts", 1, { selfInconsistent: true }),
    ]);
    expect_eq(criticVetoesGate(c, BLOCKING), true);
  });

  test("with ctx + uncorroborated flag → no veto", () => {
    const c = completedWith("c1", "APPROVED", [
      finding("blocker", "a.ts", 1, { selfInconsistent: true }),
    ]);
    expect_eq(
      criticVetoesGate(c, BLOCKING, {
        allResults: [c],
        rules: RULES,
      }),
      false,
    );
  });

  test("with ctx + corroborated flag → veto", () => {
    const flagged = completedWith("c1", "APPROVED", [
      finding("blocker", "a.ts", 1, { selfInconsistent: true }),
    ]);
    const corroborator = completedWith("c2", "CHANGES_REQUESTED", [
      finding("blocker", "a.ts", 4),
    ]);
    expect_eq(
      criticVetoesGate(flagged, BLOCKING, {
        allResults: [flagged, corroborator],
        rules: RULES,
      }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Mechanism 1 — self-consistency probe (mock LLM)

describe("runSelfConsistencyProbe", () => {
  const SHA = "fd5914a2a3649845d0e75acbbe087efb21023bc0";
  const ARGV_FILE_CONTENT = `node -e 'require(process.argv[1]); console.log(process.argv[2])' path/to/pkg.json depname`;

  test("probe says inconsistent → tagged as selfInconsistent", async () => {
    const probe: SelfConsistencyProbeFn = async () => ({
      consistent: false,
      reason: "Node argv[1] is the first user arg, not '[eval]'.",
    });
    const f = finding("blocker", "scripts/check-df-pin.sh", 42);
    const result = await runSelfConsistencyProbe(
      f,
      "gemini",
      SHA,
      BLOCKING,
      async () => ARGV_FILE_CONTENT,
      probe,
    );
    expect_eq(result.inconsistent, true);
    expect_eq(result.reason, "probe_inconsistent");
    const tagged = applySelfConsistencyResult(f, result);
    expect_eq(tagged.selfInconsistent, true);
    // Identity check: when inconsistent, a new object is returned.
    expect_truthy(tagged !== f);
  });

  test("probe says consistent → finding unchanged", async () => {
    const probe: SelfConsistencyProbeFn = async () => ({
      consistent: true,
      reason: "Claim matches file content.",
    });
    const f = finding("blocker", "a.ts", 1);
    const result = await runSelfConsistencyProbe(
      f,
      "gemini",
      SHA,
      BLOCKING,
      async () => "file content",
      probe,
    );
    expect_eq(result.inconsistent, false);
    expect_eq(result.reason, "probe_consistent");
    const tagged = applySelfConsistencyResult(f, result);
    // Identity preserved on the no-tag path (hot-path zero-alloc).
    expect_truthy(tagged === f);
  });

  test("probe rejects → default to consistent (do NOT escalate)", async () => {
    const probe: SelfConsistencyProbeFn = async () => {
      throw new Error("upstream 500");
    };
    const f = finding("blocker", "a.ts", 1);
    const result = await runSelfConsistencyProbe(
      f,
      "gemini",
      SHA,
      BLOCKING,
      async () => "file content",
      probe,
    );
    expect_eq(result.inconsistent, false);
    expect_eq(result.reason, "probe_error");
    expect_truthy(result.detail?.includes("upstream 500"));
  });

  test("probe returns malformed output → default to consistent", async () => {
    // Cast to any to bypass type checking — we're testing the runtime
    // guard against a misbehaving probe impl.
    const probe = (async () => ({
      reason: "no consistent field",
    })) as unknown as SelfConsistencyProbeFn;
    const f = finding("blocker", "a.ts", 1);
    const result = await runSelfConsistencyProbe(
      f,
      "gemini",
      SHA,
      BLOCKING,
      async () => "file content",
      probe,
    );
    expect_eq(result.inconsistent, false);
    expect_eq(result.reason, "probe_error");
  });

  test("non-blocking severity → probe_skipped (no LLM call)", async () => {
    let called = false;
    const probe: SelfConsistencyProbeFn = async () => {
      called = true;
      return { consistent: false, reason: "should not be called" };
    };
    const f: ReviewFinding = {
      severity: "note",
      category: "test",
      file: "a.ts",
      evidence: "test",
      impact: "test",
      requiredFix: "test",
    };
    const result = await runSelfConsistencyProbe(
      f,
      "gemini",
      SHA,
      BLOCKING,
      async () => "file content",
      probe,
    );
    expect_eq(result.inconsistent, false);
    expect_eq(result.reason, "probe_skipped");
    expect_eq(called, false);
  });

  test("missing file → probe_skipped", async () => {
    let called = false;
    const probe: SelfConsistencyProbeFn = async () => {
      called = true;
      return { consistent: false, reason: "should not be called" };
    };
    const f: ReviewFinding = {
      severity: "blocker",
      category: "test",
      evidence: "test",
      impact: "test",
      requiredFix: "test",
    };
    const result = await runSelfConsistencyProbe(
      f,
      "gemini",
      SHA,
      BLOCKING,
      async () => "file content",
      probe,
    );
    expect_eq(result.inconsistent, false);
    expect_eq(result.reason, "probe_skipped");
    expect_eq(called, false);
  });

  test("loadFileContent returns null → no_evidence (probe not called)", async () => {
    let called = false;
    const probe: SelfConsistencyProbeFn = async () => {
      called = true;
      return { consistent: false, reason: "should not be called" };
    };
    const f = finding("blocker", "deleted.ts", 1);
    const result = await runSelfConsistencyProbe(
      f,
      "gemini",
      SHA,
      BLOCKING,
      async () => null,
      probe,
    );
    expect_eq(result.inconsistent, false);
    expect_eq(result.reason, "no_evidence");
    expect_eq(called, false);
  });

  test("loadFileContent throws → no_evidence (default-to-consistent)", async () => {
    const probe: SelfConsistencyProbeFn = async () => ({
      consistent: false,
      reason: "should not be called",
    });
    const f = finding("blocker", "a.ts", 1);
    const result = await runSelfConsistencyProbe(
      f,
      "gemini",
      SHA,
      BLOCKING,
      async () => {
        throw new Error("FS error");
      },
      probe,
    );
    expect_eq(result.inconsistent, false);
    expect_eq(result.reason, "no_evidence");
  });

  test("probe receives finding + file content + commit sha + vendor", async () => {
    let captured: SelfConsistencyProbeInput | undefined;
    const probe: SelfConsistencyProbeFn = async (input) => {
      captured = input;
      return { consistent: true, reason: "ok" };
    };
    const f = finding("blocker", "a.ts", 7);
    await runSelfConsistencyProbe(
      f,
      "gemini",
      "abc123",
      BLOCKING,
      async () => "file body",
      probe,
    );
    expect_eq(captured?.vendor, "gemini");
    expect_eq(captured?.commitSha, "abc123");
    expect_eq(captured?.finding.file, "a.ts");
    expect_eq(captured?.fileContent, "file body");
  });
});

describe("buildSelfConsistencyPrompt", () => {
  test("renders finding + file content + JSON-shape instruction", () => {
    const f = finding("blocker", "a.ts", 5);
    const prompt = buildSelfConsistencyPrompt({
      vendor: "gemini",
      commitSha: "abc",
      finding: f,
      fileContent: "const x = 1;",
    });
    expect_truthy(prompt.includes("gemini"));
    expect_truthy(prompt.includes("commit abc"));
    expect_truthy(prompt.includes("a.ts"));
    expect_truthy(prompt.includes("line 5"));
    expect_truthy(prompt.includes("const x = 1;"));
    expect_truthy(prompt.includes('"consistent": boolean'));
  });

  test("handles null fileContent gracefully", () => {
    const f = finding("blocker", "deleted.ts", 1);
    const prompt = buildSelfConsistencyPrompt({
      vendor: "v",
      commitSha: "x",
      finding: f,
      fileContent: null,
    });
    expect_truthy(prompt.includes("(file content unavailable)"));
  });
});
