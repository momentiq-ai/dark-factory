
import { describe, it, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  expect_eq,
  expect_ne,
  expect_deep,
  expect_match,
  expect_no_match,
  expect_truthy,
  expect_throws,
  expect_rejects,
} from "./_assert-shim.js";
import { parseCommitTrailers } from "../src/evidence.js";
import { classifyTdd, type TddClassifierConfig } from "../src/policy/tdd-classifier.js";

const SAGE_CONFIG: TddClassifierConfig = {
  productionGlobs: [
    "backend/app/**/*.py",
    "backend/prompts/**/*.yaml",
    "backend/prompt_store/**/*.yaml",
    "web/app/**/*.tsx",
    "web/components/**/*.tsx",
  ],
  testGlobs: [
    "backend/tests/**/*.py",
    "web/**/*.test.tsx",
    "web/tests/**/*.spec.ts",
  ],
  exclusionGlobs: [
    "**/*.md",
    "docs/**",
    "web/generated/**",
    "web/types/api.ts",
  ],
  justificationTrailer: "Tdd-Justification",
};

const NO_TRAILERS = parseCommitTrailers("");

function trailersWith(value: string): ReturnType<typeof parseCommitTrailers> {
  return parseCommitTrailers(`feat: x\n\nTdd-Justification: ${value}`);
}

test("classifyTdd: production change with test change → ok", () => {
  const result = classifyTdd(
    ["backend/app/api/foo.py", "backend/tests/test_foo.py"],
    NO_TRAILERS,
    SAGE_CONFIG,
  );
  expect_eq(result.verdict, "ok");
  expect_eq(result.productionPaths.length, 1);
  expect_eq(result.testPaths.length, 1);
});

test("classifyTdd: production change WITHOUT test change → block", () => {
  const result = classifyTdd(["backend/app/api/foo.py"], NO_TRAILERS, SAGE_CONFIG);
  expect_eq(result.verdict, "block");
  expect_match(result.reason, /no Tdd-Justification trailer/);
});

test("classifyTdd: production-only with Tdd-Justification trailer → justified", () => {
  const trailers = trailersWith("config-only constant, no test surface");
  const result = classifyTdd(["backend/app/api/foo.py"], trailers, SAGE_CONFIG);
  expect_eq(result.verdict, "justified");
  expect_eq(result.justification, "config-only constant, no test surface");
});

test("classifyTdd: no production paths changed → ok", () => {
  const result = classifyTdd(
    ["backend/tests/test_alone.py"],
    NO_TRAILERS,
    SAGE_CONFIG,
  );
  expect_eq(result.verdict, "ok");
  expect_eq(result.productionPaths.length, 0);
});

test("classifyTdd: docs-only PR routes to ok via exclusion", () => {
  const result = classifyTdd(
    ["README.md", "docs/roadmap/cycle318.2.md"],
    NO_TRAILERS,
    SAGE_CONFIG,
  );
  expect_eq(result.verdict, "ok");
  expect_eq(result.excludedPaths.length, 2);
  expect_eq(result.productionPaths.length, 0);
});

test("classifyTdd: prompt YAML triggers production routing", () => {
  const result = classifyTdd(
    ["backend/prompts/agentic-system.yaml"],
    NO_TRAILERS,
    SAGE_CONFIG,
  );
  expect_eq(result.verdict, "block");
});

test("classifyTdd: regenerated types in exclusion list do not trigger production", () => {
  const result = classifyTdd(["web/generated/api.ts"], NO_TRAILERS, SAGE_CONFIG);
  // web/generated/** is excluded, so even though it would match a TS file,
  // it never enters the production set.
  expect_eq(result.verdict, "ok");
  expect_eq(result.excludedPaths.length, 1);
});

test("classifyTdd: mixed docs + production routes to production (production wins)", () => {
  const result = classifyTdd(
    ["docs/foo.md", "backend/app/api.py"],
    NO_TRAILERS,
    SAGE_CONFIG,
  );
  expect_eq(result.verdict, "block");
  expect_eq(result.productionPaths.length, 1);
  expect_eq(result.excludedPaths.length, 1);
});

test("classifyTdd: justification with whitespace-only value does NOT justify", () => {
  const trailers = parseCommitTrailers(`feat: x\n\nTdd-Justification:   `);
  // Whitespace-only trailers are dropped during parsing (treated as empty);
  // confirm that classifyTdd then blocks rather than silently justifying.
  const result = classifyTdd(["backend/app/api.py"], trailers, SAGE_CONFIG);
  expect_eq(result.verdict, "block");
});

test("classifyTdd: empty changed-paths list → ok", () => {
  const result = classifyTdd([], NO_TRAILERS, SAGE_CONFIG);
  expect_eq(result.verdict, "ok");
});

test("classifyTdd: exclusion glob outranks production glob when both would match", () => {
  // web/types/api.ts matches `web/**/*.ts` (a hypothetical production glob)
  // but is in the exclusion list. Confirm exclusion always wins.
  const customConfig: TddClassifierConfig = {
    ...SAGE_CONFIG,
    productionGlobs: ["web/**/*.ts"],
  };
  const result = classifyTdd(["web/types/api.ts"], NO_TRAILERS, customConfig);
  expect_eq(result.verdict, "ok");
  expect_eq(result.excludedPaths.length, 1);
});

test("classifyTdd: test path that also matches production glob still counts as test", () => {
  // A path matching BOTH production and test sets contributes to both
  // collections; the verdict still passes because tests are present.
  const customConfig: TddClassifierConfig = {
    productionGlobs: ["backend/**/*.py"],
    testGlobs: ["backend/tests/**/*.py"],
    exclusionGlobs: [],
    justificationTrailer: "Tdd-Justification",
  };
  const result = classifyTdd(
    ["backend/tests/test_x.py"],
    NO_TRAILERS,
    customConfig,
  );
  expect_eq(result.verdict, "ok");
  // The test path also matched the broader production glob, but the presence
  // of a test path is what we care about.
  expect_eq(result.testPaths.length, 1);
});

test("classifyTdd: justification trailer name is configurable", () => {
  const customConfig: TddClassifierConfig = {
    ...SAGE_CONFIG,
    justificationTrailer: "Skip-Tests",
  };
  const trailers = parseCommitTrailers(
    `feat: x\n\nSkip-Tests: emergency hotfix per oncall`,
  );
  const result = classifyTdd(["backend/app/api.py"], trailers, customConfig);
  expect_eq(result.verdict, "justified");
});
