// Deterministic TDD classifier. Given the changed paths in a commit and
// the parsed commit-message trailers, returns one of three verdicts:
//
//   ok        — production change accompanied by a test change, OR no
//               production paths changed at all
//   justified — production-only change waived by `Tdd-Justification:` trailer
//   block     — production change with no test change and no waiver
//
// "Production" and "test" are defined by glob sets in
// `.agent-review/config.json:tdd.classifier`. Exclusion globs suppress
// BOTH production and test routing for matched paths (e.g., docs,
// regenerated artifacts) so a docs-only PR exits via the "no production
// paths changed" branch even when the docs live under `web/components/`.
//
// Mixed PRs (some production + some docs) route to production: any
// production glob match is a production change. Exclusion only fully
// suppresses when EVERY path is an exclusion, which is the docs-only case.

import { matchAnyGlob } from "../glob.js";
import type { CommitTrailers } from "../evidence.js";

export interface TddClassifierConfig {
  productionGlobs: readonly string[];
  testGlobs: readonly string[];
  exclusionGlobs: readonly string[];
  // Canonical trailer key (case-insensitive) that waives the block.
  // Defaults to "Tdd-Justification" but operators can rename for repo
  // conventions (e.g., "Test-Justification").
  justificationTrailer: string;
}

export type TddVerdict = "ok" | "justified" | "block";

export interface TddClassifierResult {
  verdict: TddVerdict;
  productionPaths: string[];
  testPaths: string[];
  excludedPaths: string[];
  justification?: string;
  // Human-readable explanation used in gate output and telemetry.
  reason: string;
}

export function classifyTdd(
  changedPaths: readonly string[],
  trailers: CommitTrailers,
  config: TddClassifierConfig,
): TddClassifierResult {
  const excludedPaths: string[] = [];
  const productionPaths: string[] = [];
  const testPaths: string[] = [];

  for (const path of changedPaths) {
    if (matchAnyGlob(path, config.exclusionGlobs)) {
      excludedPaths.push(path);
      continue;
    }
    // A path can match both production and test globs (e.g., a hand-rolled
    // glob set where they overlap). When in doubt prefer test routing,
    // since the goal is to ensure a test change exists — counting an
    // ambiguous path as "test only" weakens the gate; counting it as
    // "production AND test" still passes when a real test exists.
    const isProduction = matchAnyGlob(path, config.productionGlobs);
    const isTest = matchAnyGlob(path, config.testGlobs);
    if (isProduction) productionPaths.push(path);
    if (isTest) testPaths.push(path);
  }

  if (productionPaths.length === 0) {
    return {
      verdict: "ok",
      productionPaths,
      testPaths,
      excludedPaths,
      reason:
        excludedPaths.length > 0
          ? `no production paths changed (${excludedPaths.length} excluded path(s))`
          : "no production paths changed",
    };
  }

  if (testPaths.length > 0) {
    return {
      verdict: "ok",
      productionPaths,
      testPaths,
      excludedPaths,
      reason: `production change accompanied by ${testPaths.length} test path(s)`,
    };
  }

  const justification = trailers.trailers[config.justificationTrailer.toLowerCase()];
  if (justification && justification.trim().length > 0) {
    return {
      verdict: "justified",
      productionPaths,
      testPaths,
      excludedPaths,
      justification,
      reason: `production-only change with ${config.justificationTrailer} trailer`,
    };
  }

  return {
    verdict: "block",
    productionPaths,
    testPaths,
    excludedPaths,
    reason: `production change without test change and no ${config.justificationTrailer} trailer`,
  };
}
