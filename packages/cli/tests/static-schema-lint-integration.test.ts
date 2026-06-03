// Integration test for the static-schema-lint adapter against the real
// buildReviewPacket path. The unit tests in
// static-schema-lint-adapter.test.ts inject `content` directly via
// `makePacket()`; this file proves the production packet pipeline
// (rebind.ts → git.ts → adapter.review) surfaces the DFP #107
// regression even when the consumer config sets
// `context.includeFullChangedFiles: false` (i.e. file bodies are NOT
// loaded into `changedFiles[].content`).
//
// Without this test, the unit-suite would pass while a default consumer
// wiring silently drops every markdown body and the deterministic
// backstop becomes a no-op.

import { test } from "vitest";
import { expect_eq, expect_truthy, expect_match } from "./_assert-shim.js";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentReviewConfig } from "../src/policy/config.js";
import { buildReviewPacket } from "../src/trusted-surface/rebind.js";
import { StaticSchemaLintAdapter } from "../src/adapters/static-schema-lint.js";
import type {
  AgentReviewConfig,
  CriticConfig,
} from "@momentiq/dark-factory-schemas";

function baseConfig(includeFullChangedFiles: boolean): AgentReviewConfig {
  return {
    version: 1,
    critics: [
      {
        id: "schema-lint-chief-engineer",
        name: "Schema-Lint Critic",
        adapter: "static-schema-lint",
        required: false,
        runtime: "local",
        model: { id: "deterministic-1.0", params: [] },
      },
      {
        // Second critic only here to satisfy min-complete-quorum >= 2; the
        // adapter under test (static-schema-lint) is constructed and
        // invoked directly, so the SDK critic is never actually called.
        id: "cursor-local-chief-engineer",
        name: "Cursor Local Critic",
        adapter: "cursor-sdk",
        required: false,
        runtime: "local",
        model: { id: "gpt-5.5", params: [] },
      },
    ],
    aggregation: {
      policy: "min-complete-quorum",
      blockingSeverities: ["blocker", "high"],
      quorum: 2,
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
      maxChangedFileBytes: 5_000_000,
      includeFullChangedFiles,
    },
    validation: {
      runBeforeReview: false,
      resultFile: "agent-reviews/quality-gates/latest.json",
      requiredQualityGates: [],
      optionalQualityGates: [],
      verificationRoutes: [],
    },
    security: {
      redactSecretsInDiagnostics: true,
      treatDiffAsUntrustedInput: true,
    },
  };
}

function runGit(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, env: process.env });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
}

const DFP_107_FIXTURE = [
  "# CLAUDE.md",
  "",
  "Recommended default:",
  "",
  "```jsonc",
  "// schema: claude-code-settings",
  '{ "model": "opus", "effortLevel": "max" }',
  "```",
  "",
].join("\n");

function setupRepoWithDfp107Fixture(config: AgentReviewConfig): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "df-schema-lint-int-"));
  runGit(["init", "-q", "-b", "main", dir], process.cwd());
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# repo\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "initial"], dir);
  writeFileSync(join(dir, "CLAUDE.md"), DFP_107_FIXTURE);
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "feat: add CLAUDE.md with effortLevel example"], dir);
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(config));
  return { dir };
}

const CRITIC: CriticConfig = {
  id: "schema-lint-chief-engineer",
  name: "Schema-Lint Critic",
  adapter: "static-schema-lint",
  required: false,
  runtime: "local",
  model: { id: "deterministic-1.0", params: [] },
};

const REVIEW_OPTIONS = {
  blockingSeverities: ["blocker", "high"] as const,
};

test("end-to-end: DFP #107 fixture is blocked when includeFullChangedFiles: true", async () => {
  const config = baseConfig(true);
  const { dir } = setupRepoWithDfp107Fixture(config);
  const loaded = await loadAgentReviewConfig({
    cwd: dir,
    validateGuidanceFiles: false,
  });
  const packet = await buildReviewPacket(loaded, { cwd: dir });
  // Sanity: in the includeFullChangedFiles: true path, the markdown body
  // is loaded into changedFiles[].content.
  const claudeFile = packet.changedFiles.find((f) => f.path === "CLAUDE.md");
  expect_truthy(claudeFile, "CLAUDE.md should be in changedFiles");
  expect_match(claudeFile?.content ?? "", /effortLevel/);

  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  expect_truthy(result.findings.length >= 1);
  expect_eq(result.findings[0]?.severity, "high");
  expect_match(result.findings[0]?.evidence ?? "", /effortLevel/);
});

test("end-to-end: DFP #107 fixture is blocked when includeFullChangedFiles: false", async () => {
  // This is the load-bearing case: the production packet path with
  // includeFullChangedFiles: false omits file bodies (git.ts:227-242
  // skips the content read). The adapter MUST fall back to scanning
  // packet.diff for the annotated block, or the deterministic backstop
  // silently no-ops under the default consumer wiring.
  const config = baseConfig(false);
  const { dir } = setupRepoWithDfp107Fixture(config);
  const loaded = await loadAgentReviewConfig({
    cwd: dir,
    validateGuidanceFiles: false,
  });
  const packet = await buildReviewPacket(loaded, { cwd: dir });
  // Sanity: changedFiles[].content is absent — the precondition for the
  // fallback path is met.
  const claudeFile = packet.changedFiles.find((f) => f.path === "CLAUDE.md");
  expect_truthy(claudeFile, "CLAUDE.md should be in changedFiles");
  expect_eq(claudeFile?.content, undefined);
  // The unified diff still carries the added markdown lines.
  expect_match(packet.diff, /effortLevel/);

  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  expect_truthy(result.findings.length >= 1);
  expect_eq(result.findings[0]?.severity, "high");
  expect_eq(result.findings[0]?.file, "CLAUDE.md");
  expect_match(result.findings[0]?.evidence ?? "", /effortLevel/);
});
