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
  VERIFY_CLI_COMMAND,
  defaultRouteVerifyCommand,
  isVerifyRouteCommand,
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

// Cycle 22 (momentiq-ai/dark-factory#192) — the default route table ships
// each command route's `command` as the `df verify --route <id>`
// placeholder, and the route-runner's recursion guard refuses to spawn a
// command that re-invokes the `df verify` orchestrator. Both the table and
// the guard reference the SAME helpers (`defaultRouteVerifyCommand` /
// `isVerifyRouteCommand`); this drift test pins them so a rename of the
// subcommand can't silently desync the shipped placeholders from the guard.
describe("df verify command-string drift (#192)", () => {
  const commandRoutes = DEFAULT_VERIFICATION_ROUTES.filter(
    (r) => r.command !== null,
  );

  it("ships every command route as the canonical `df verify --route <id>` placeholder", () => {
    expect(commandRoutes.length).toBeGreaterThan(0);
    for (const route of commandRoutes) {
      expect(route.command).toBe(defaultRouteVerifyCommand(route.id));
    }
  });

  it("recognizes every shipped command route as a `df verify` invocation (the recursion-guard contract)", () => {
    for (const route of commandRoutes) {
      expect(isVerifyRouteCommand(route.command as string)).toBe(true);
    }
  });

  it("defaultRouteVerifyCommand composes the constant + route id", () => {
    expect(defaultRouteVerifyCommand("terraform")).toBe("df verify --route terraform");
    expect(defaultRouteVerifyCommand("terraform").startsWith(VERIFY_CLI_COMMAND)).toBe(true);
  });

  it("isVerifyRouteCommand does NOT flag a real per-route producer (no false-positive guard trip)", () => {
    // The documented consumer override shape (DFP's df-verify-route.sh) and
    // other real producers must NOT be mistaken for the placeholder.
    expect(isVerifyRouteCommand("bash scripts/df-verify-route.sh terraform")).toBe(false);
    expect(isVerifyRouteCommand("terraform plan -no-color")).toBe(false);
    expect(isVerifyRouteCommand("npm run verify:ui")).toBe(false);
  });

  it("isVerifyRouteCommand tolerates leading whitespace and the bare `df verify` form", () => {
    expect(isVerifyRouteCommand("  df verify --route docker")).toBe(true);
    expect(isVerifyRouteCommand("df verify")).toBe(true);
  });
});
