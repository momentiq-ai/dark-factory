// Cycle 21 — Evidence-Gated Validation Routes.
//
// `parseVerificationRoute` is exercised through `parseAgentReviewConfig`
// (the only public surface that parses a route array). These tests cover
// the additive `evidenceKind` discriminator (`momentiq-ai/dark-factory#183`)
// and the canonical default route table (`momentiq-ai/dark-factory#185`).
import { describe, expect, it } from "vitest";

import {
  DEFAULT_VERIFICATION_ROUTES,
  EVIDENCE_KINDS,
  SchemaError,
  parseAgentReviewConfig,
  type EvidenceKind,
  type VerificationRoute,
} from "../src/index.js";

// A minimal v1 config whose only non-default surface is the route array
// under test. v1 keeps verificationRoutes optional, so this isolates the
// route parser without dragging in the v2 tdd/required-route invariants.
function configWithRoutes(routes: unknown[]): Record<string, unknown> {
  return {
    version: 1,
    critics: [
      {
        id: "cursor-local-chief-engineer",
        name: "Cursor",
        adapter: "cursor-sdk",
        required: true,
        runtime: "local",
        model: { id: "composer-2.5", params: [] },
      },
    ],
    aggregation: { policy: "block-if-any", blockingSeverities: ["blocker", "high"] },
    git: { hookPath: ".husky", artifactDir: "agent-reviews", artifactScope: "git-common-dir" },
    policy: {
      blockOnMissingReview: false,
      blockOnReviewError: false,
      allowEmergencyBypass: true,
      postCommitMode: "async",
    },
    context: {
      guidanceFiles: [],
      promptFragments: [],
      maxChangedFileBytes: 200000,
      includeFullChangedFiles: true,
    },
    validation: {
      runBeforeReview: false,
      resultFile: "agent-reviews/quality-gates/latest.json",
      requiredQualityGates: [],
      optionalQualityGates: [],
      verificationRoutes: routes,
    },
    security: { redactSecretsInDiagnostics: true, treatDiffAsUntrustedInput: true },
  };
}

function firstRoute(routes: unknown[]): VerificationRoute {
  const parsed = parseAgentReviewConfig(configWithRoutes(routes));
  const route = parsed.validation.verificationRoutes[0];
  expect(route).toBeDefined();
  return route!;
}

describe("VerificationRoute.evidenceKind discriminator (#183)", () => {
  it("parses a route WITHOUT evidenceKind identically to before (additive/optional)", () => {
    const route = firstRoute([
      {
        id: "legacy",
        trigger: ["src/**"],
        command: "make test",
        evidencePath: "agent-reviews/quality-gates/${sha}.json",
        category: "test",
      },
    ]);
    expect(route.evidenceKind).toBeUndefined();
    // The omitted-vs-present distinction must be load-bearing: a route
    // that never declared the field does not gain a default.
    expect("evidenceKind" in route).toBe(false);
  });

  it.each(EVIDENCE_KINDS)("accepts the known evidenceKind %s", (kind) => {
    const route = firstRoute([
      {
        id: `r-${kind}`,
        trigger: ["src/**"],
        command: kind === "none" ? null : "make test",
        evidencePath: kind === "none" ? null : "agent-reviews/quality-gates/${sha}.json",
        category: kind,
        evidenceKind: kind,
      },
    ]);
    expect(route.evidenceKind).toBe(kind);
  });

  it("rejects an unknown evidenceKind", () => {
    expect(() =>
      parseAgentReviewConfig(
        configWithRoutes([
          {
            id: "bad",
            trigger: ["src/**"],
            command: "make test",
            evidencePath: "agent-reviews/quality-gates/${sha}.json",
            category: "test",
            evidenceKind: "kubernetes",
          },
        ]),
      ),
    ).toThrow(SchemaError);
  });

  it("rejects a non-string evidenceKind", () => {
    expect(() =>
      parseAgentReviewConfig(
        configWithRoutes([
          {
            id: "bad",
            trigger: ["src/**"],
            command: "make test",
            evidencePath: "agent-reviews/quality-gates/${sha}.json",
            category: "test",
            evidenceKind: 7,
          },
        ]),
      ),
    ).toThrow(SchemaError);
  });

  it("EVIDENCE_KINDS lists exactly the proposed values", () => {
    expect([...EVIDENCE_KINDS].sort()).toEqual(
      ["docker", "migration", "none", "playwright", "terraform", "test"].sort(),
    );
  });
});

describe("DEFAULT_VERIFICATION_ROUTES canonical table (#185)", () => {
  it("is a non-empty array of VerificationRoute", () => {
    expect(Array.isArray(DEFAULT_VERIFICATION_ROUTES)).toBe(true);
    expect(DEFAULT_VERIFICATION_ROUTES.length).toBeGreaterThan(0);
  });

  it("covers the ADR route-table change classes by evidenceKind", () => {
    const kinds = new Set(DEFAULT_VERIFICATION_ROUTES.map((r) => r.evidenceKind));
    for (const kind of [
      "playwright",
      "migration",
      "terraform",
      "docker",
      "test",
      "none",
    ] as EvidenceKind[]) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  it("parses cleanly through parseAgentReviewConfig (the shipped contract)", () => {
    const parsed = parseAgentReviewConfig(
      configWithRoutes(DEFAULT_VERIFICATION_ROUTES as unknown as unknown[]),
    );
    expect(parsed.validation.verificationRoutes).toHaveLength(
      DEFAULT_VERIFICATION_ROUTES.length,
    );
  });

  it("has unique route ids", () => {
    const ids = DEFAULT_VERIFICATION_ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ships the docs-only exclusive suppression route (command:null, evidenceKind:none)", () => {
    const docs = DEFAULT_VERIFICATION_ROUTES.find((r) => r.exclusive === true);
    expect(docs).toBeDefined();
    expect(docs!.command).toBeNull();
    expect(docs!.evidencePath).toBeNull();
    expect(docs!.evidenceKind).toBe("none");
  });

  it("arms the playwright route on web/** and *.tsx surfaces", () => {
    const pw = DEFAULT_VERIFICATION_ROUTES.find((r) => r.evidenceKind === "playwright");
    expect(pw).toBeDefined();
    expect(pw!.trigger).toContain("web/**");
    expect(pw!.trigger.some((t) => t.includes("*.tsx"))).toBe(true);
  });
});
