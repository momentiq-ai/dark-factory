// Tests for the generatedFilePolicy parser branch added by ADR 0001.
// ADR § 5.2 #9 specifies the matrix.

import { describe, it, expect, test } from "vitest";
import { parseAgentReviewConfig, SchemaError } from "../src/index.js";

function baseConfig(extra: object = {}): object {
  return {
    version: 1,
    critics: [
      {
        id: "c1",
        name: "Critic One",
        adapter: "cursor-sdk",
        required: true,
        runtime: "local",
        model: { id: "gpt-5.5", params: [] },
      },
    ],
    aggregation: {
      policy: "block-if-any",
      blockingSeverities: ["blocker", "high"],
    },
    git: {
      hookPath: ".githooks",
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
      maxChangedFileBytes: 1000,
      includeFullChangedFiles: true,
      ...extra,
    },
    validation: {
      runBeforeReview: false,
      resultFile: "agent-reviews/quality-gates/latest.json",
      requiredQualityGates: [],
      optionalQualityGates: [],
    },
    security: { redactSecretsInDiagnostics: true, treatDiffAsUntrustedInput: true },
  };
}

test("valid generatedFilePolicy parses cleanly (ADR § 5.2 #9)", () => {
  const cfg = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      globs: ["**/package-lock.json", "**/yarn.lock"],
      overrides: [{ glob: "**/services/event-ingest/package-lock.json", mode: "omit" }],
      onParseError: "refuse-and-block",
    },
  });
  const parsed = parseAgentReviewConfig(cfg);
  expect(parsed.context.generatedFilePolicy?.mode).toBe("compact");
  expect(parsed.context.generatedFilePolicy?.globs).toEqual([
    "**/package-lock.json",
    "**/yarn.lock",
  ]);
  expect(parsed.context.generatedFilePolicy?.overrides).toHaveLength(1);
  expect(parsed.context.generatedFilePolicy?.onParseError).toBe("refuse-and-block");
});

test("absent generatedFilePolicy preserved as undefined (back-compat)", () => {
  const cfg = baseConfig();
  const parsed = parseAgentReviewConfig(cfg);
  expect(parsed.context.generatedFilePolicy).toBeUndefined();
});

test("missing `mode` is rejected", () => {
  const cfg = baseConfig({
    generatedFilePolicy: { globs: ["**/package-lock.json"] },
  });
  expect(() => parseAgentReviewConfig(cfg)).toThrow(SchemaError);
});

test("invalid mode value is rejected", () => {
  const cfg = baseConfig({
    generatedFilePolicy: { mode: "bogus" },
  });
  expect(() => parseAgentReviewConfig(cfg)).toThrow(SchemaError);
});

test("explicitly empty globs: [] is rejected", () => {
  const cfg = baseConfig({
    generatedFilePolicy: { mode: "compact", globs: [] },
  });
  expect(() => parseAgentReviewConfig(cfg)).toThrow(/non-empty array/);
});

test("omitted globs parses cleanly; absence preserved as undefined", () => {
  const cfg = baseConfig({
    generatedFilePolicy: { mode: "compact" },
  });
  const parsed = parseAgentReviewConfig(cfg);
  expect(parsed.context.generatedFilePolicy?.globs).toBeUndefined();
  expect(parsed.context.generatedFilePolicy?.mode).toBe("compact");
});

test("duplicate glob in globs[] is rejected", () => {
  const cfg = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      globs: ["**/package-lock.json", "**/package-lock.json"],
    },
  });
  expect(() => parseAgentReviewConfig(cfg)).toThrow(/duplicate/i);
});

test("duplicate override glob is rejected", () => {
  const cfg = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      overrides: [
        { glob: "**/a/package-lock.json", mode: "omit" },
        { glob: "**/a/package-lock.json", mode: "compact" },
      ],
    },
  });
  expect(() => parseAgentReviewConfig(cfg)).toThrow(/duplicate/i);
});

test("invalid override mode is rejected", () => {
  const cfg = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      overrides: [{ glob: "**/a/package-lock.json", mode: "bogus" }],
    },
  });
  expect(() => parseAgentReviewConfig(cfg)).toThrow(SchemaError);
});

test("valid onParseError values both parse", () => {
  const cfgRefuse = baseConfig({
    generatedFilePolicy: { mode: "compact", onParseError: "refuse-and-block" },
  });
  const parsedRefuse = parseAgentReviewConfig(cfgRefuse);
  expect(parsedRefuse.context.generatedFilePolicy?.onParseError).toBe(
    "refuse-and-block",
  );

  const cfgWarn = baseConfig({
    generatedFilePolicy: { mode: "compact", onParseError: "compact-with-warning" },
  });
  const parsedWarn = parseAgentReviewConfig(cfgWarn);
  expect(parsedWarn.context.generatedFilePolicy?.onParseError).toBe(
    "compact-with-warning",
  );
});

test("omitted onParseError preserved as undefined", () => {
  const cfg = baseConfig({
    generatedFilePolicy: { mode: "compact" },
  });
  const parsed = parseAgentReviewConfig(cfg);
  expect(parsed.context.generatedFilePolicy?.onParseError).toBeUndefined();
});

test("invalid onParseError value is rejected", () => {
  const cfg = baseConfig({
    generatedFilePolicy: { mode: "compact", onParseError: "log-and-ignore" },
  });
  expect(() => parseAgentReviewConfig(cfg)).toThrow(SchemaError);
});

test("empty glob string in globs[] is rejected", () => {
  const cfg = baseConfig({
    generatedFilePolicy: { mode: "compact", globs: [""] },
  });
  expect(() => parseAgentReviewConfig(cfg)).toThrow(SchemaError);
});

test("override with empty glob is rejected", () => {
  const cfg = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      overrides: [{ glob: "", mode: "omit" }],
    },
  });
  expect(() => parseAgentReviewConfig(cfg)).toThrow(SchemaError);
});
