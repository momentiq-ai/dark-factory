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
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadAgentReviewConfig, type LoadedConfig } from "../src/policy/config.js";
import { perShaQualityGatePath } from "../src/evidence/index.js";
import { evaluateCommitGate } from "../src/policy/gate.js";
import { commitDiff, commitParent, diffHash, resolveCommit } from "../src/git.js";
import { resolveArtifactRoot } from "../src/paths.js";
import { buildAggregate, writeArtifacts } from "../src/report.js";
import type { CriticResult } from "@momentiq/dark-factory-schemas";
import { fixturePath } from "./_helpers.js";

interface TempRepo {
  dir: string;
  loaded: LoadedConfig;
  sha: string;
  diffHashStr: string;
}

async function setupRepo(): Promise<TempRepo> {
  const dir = mkdtempSync(join(tmpdir(), "agent-review-gate-"));
  spawnSync("git", ["init", "-q", "-b", "main", dir], { cwd: process.cwd() });
  spawnSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# r\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  writeFileSync(join(dir, "x.txt"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "add x"], { cwd: dir });

  const cfg = JSON.parse(readFileSync(fixturePath("config.json"), "utf8"));
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(cfg));

  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const sha = await resolveCommit("HEAD", dir);
  const parent = await commitParent(sha, dir);
  const diff = await commitDiff(parent, sha, dir);
  return { dir, loaded, sha, diffHashStr: diffHash(diff) };
}

function approved(diffHashStr: string, criticOverrides: Partial<CriticResult> = {}): CriticResult {
  return {
    criticId: "cursor-local-chief-engineer",
    status: "complete",
    verdict: "APPROVED",
    requiresHumanJudgment: false,
    reviewer: {
      name: "Cursor Local Critic",
      adapter: "cursor-sdk",
      model: { id: "gpt-5.5", params: [] },
      runtime: "local",
    },
    summary: "ok",
    findings: [],
    // Default to evidence-present, exit-zero so the new deterministic gate
    // enforcement (Cycle 2 #4) doesn't block by default. Tests that want
    // to exercise missing-evidence behavior override this explicitly.
    validation: {
      qualityGateResults: [
        {
          command: "true",
          exitCode: 0,
          durationMs: 1,
          startedAt: "2026-05-04T00:00:00Z",
          finishedAt: "2026-05-04T00:00:00Z",
          logExcerpt: "ok",
        },
      ],
      qualityGatesMissing: [],
    },
    confidence: "high",
    ...criticOverrides,
  };
}

async function writeArtifactWith(repo: TempRepo, results: CriticResult[]): Promise<void> {
  const parent = await commitParent(repo.sha, repo.dir);
  const a = buildAggregate({
    loaded: repo.loaded,
    commit: repo.sha,
    parent,
    range: `${parent}..${repo.sha}`,
    diffHash: repo.diffHashStr,
    criticResults: results,
    status: "complete",
    createdAt: "2026-05-03T00:00:00Z",
  });
  await writeArtifacts(repo.loaded, a);
}

// Writes per-SHA quality-gate evidence to the canonical path
// (`<git-common-dir>/agent-reviews/quality-gates/<sha>.json`). The gate's
// deterministic enforcement reads this file directly — not `criticResults[].validation`
// — so tests exercising the required-gate evidence path must write evidence
// here. Closes #1549 regression coverage.
async function writePerShaEvidence(
  repo: TempRepo,
  results: Array<{ command: string; exitCode: number }>,
): Promise<void> {
  const root = await resolveArtifactRoot(repo.loaded);
  const path = perShaQualityGatePath(root, repo.loaded.config.git.artifactDir, repo.sha);
  mkdirSync(dirname(path), { recursive: true });
  const evidence = {
    version: 2,
    commit: repo.sha,
    generatedAt: "2026-05-16T00:00:00Z",
    results: results.map((r) => ({
      command: r.command,
      exitCode: r.exitCode,
      durationMs: 1,
      logExcerpt: r.exitCode === 0 ? "ok" : "boom",
      startedAt: "2026-05-16T00:00:00Z",
      finishedAt: "2026-05-16T00:00:00Z",
    })),
  };
  writeFileSync(path, JSON.stringify(evidence));
}

test("gate blocks when artifact is missing", async () => {
  const r = await setupRepo();
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_eq(result.blocked, true);
  expect_truthy(result.blocks.some((b) => b.reason === "missing_review"));
});

test("gate passes for approved artifact with no findings", async () => {
  const r = await setupRepo();
  await writePerShaEvidence(r, [{ command: "true", exitCode: 0 }]);
  await writeArtifactWith(r, [approved(r.diffHashStr)]);
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_eq(result.blocked, false);
});

test("gate blocks on stale diff hash", async () => {
  const r = await setupRepo();
  const parent = await commitParent(r.sha, r.dir);
  const a = buildAggregate({
    loaded: r.loaded,
    commit: r.sha,
    parent,
    range: `${parent}..${r.sha}`,
    diffHash: "sha256:STALE",
    criticResults: [approved("sha256:STALE")],
    status: "complete",
    createdAt: "2026-05-03T00:00:00Z",
  });
  await writeArtifacts(r.loaded, a);
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_truthy(result.blocks.some((b) => b.reason === "stale_diff_hash"));
});

test("gate blocks on requiresHumanJudgment", async () => {
  const r = await setupRepo();
  await writeArtifactWith(r, [
    approved(r.diffHashStr, {
      requiresHumanJudgment: true,
      verdict: "CHANGES_REQUESTED",
      summary: "context truncated",
      findings: [
        {
          severity: "note",
          category: "other",
          evidence: "diff truncated",
          impact: "cannot verify completeness",
          requiredFix: "rerun review with full diff",
        },
      ],
    }),
  ]);
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_eq(result.blocked, true);
  expect_truthy(result.blocks.some((b) => b.reason === "requires_human_judgment"));
});

test("gate does NOT block on a BARE requiresHumanJudgment — demotes to a warning (#241, block-if-any)", async () => {
  // Issue #241 — under `block-if-any` (the gate.test fixture policy) a
  // BARE result-level rHJ on a REQUIRED critic (APPROVED + 0 blocking
  // findings) must NOT block: it is demoted to a non-blocking
  // requires_human_judgment WARNING. This is the exact deadlock shape
  // from momentiq-ai/cerebe-platform#337 routed through the block-if-any
  // gate evaluator (the quorum path is covered in quorum-policy.test.ts).
  const r = await setupRepo();
  await writePerShaEvidence(r, [{ command: "true", exitCode: 0 }]);
  await writeArtifactWith(r, [
    approved(r.diffHashStr, {
      requiresHumanJudgment: true,
      verdict: "APPROVED",
      summary: "clean pass but self-flagged",
      findings: [],
    }),
  ]);
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_eq(result.blocked, false);
  expect_eq(
    result.blocks.some((b) => b.reason === "requires_human_judgment"),
    false,
  );
  expect_truthy(
    result.warnings.some((w) => w.reason === "requires_human_judgment"),
  );
});

test("gate STILL blocks on a NON-bare requiresHumanJudgment riding a blocking finding (#241 — §11)", async () => {
  // The §11 safety net under block-if-any: an rHJ with a blocking
  // finding to defend it keeps blocking on a required critic.
  const r = await setupRepo();
  await writePerShaEvidence(r, [{ command: "true", exitCode: 0 }]);
  await writeArtifactWith(r, [
    approved(r.diffHashStr, {
      requiresHumanJudgment: true,
      verdict: "APPROVED",
      summary: "needs a human eye",
      findings: [
        {
          severity: "blocker",
          category: "design",
          file: "x.txt",
          line: 1,
          evidence: "ambiguous contract",
          impact: "callers may misuse",
          requiredFix: "clarify the contract",
        },
      ],
    }),
  ]);
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_eq(result.blocked, true);
  expect_truthy(
    result.blocks.some((b) => b.reason === "requires_human_judgment"),
  );
});

test("gate blocks on blocking finding even when verdict is approved (defense in depth)", async () => {
  const r = await setupRepo();
  await writeArtifactWith(r, [
    approved(r.diffHashStr, {
      verdict: "APPROVED",
      findings: [
        {
          severity: "blocker",
          category: "observability",
          file: "x.txt",
          evidence: "no logger",
          impact: "no attribution",
          requiredFix: "add structlog",
        },
      ],
    }),
  ]);
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_eq(result.blocked, true);
  expect_truthy(result.blocks.some((b) => b.reason === "blocker_finding"));
});

test("emergency bypass passes the gate when reason provided", async () => {
  const r = await setupRepo();
  // No artifact written — would normally block.
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    allowBypass: true,
    bypassReason: "urgent prod fix",
  });
  expect_eq(result.blocked, false);
  expect_truthy(result.bypass);
  expect_eq(result.bypass?.reason, "urgent prod fix");
});

// Deterministic required-gate enforcement (Cycle 2 #4): the gate must block
// when required-gate evidence is missing or has non-zero exit, REGARDLESS
// of critic verdict. Without this, an APPROVED critic verdict short-circuits
// the safety net even when no gate evidence was attached.

test("gate blocks when required gate evidence is missing (even with APPROVED verdict)", async () => {
  const r = await setupRepo();
  const a = approved(r.diffHashStr);
  // Per #1549, the gate now reads evidence from the per-SHA file on disk
  // rather than `criticResults[0].validation`. Don't write the per-SHA file
  // — that's the "no gates run for required 'true'" scenario.
  a.validation = { qualityGateResults: [], qualityGatesMissing: ["true"] };
  await writeArtifactWith(r, [a]);
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_eq(result.blocked, true);
  expect_truthy(result.blocks.some((b) => b.reason === "required_gate_missing"));
});

// Per-critic `blockOnReviewError` scope (Cycle 3 #13): an adapter failure
// (startup/JSON/schema) is persisted INSIDE a `status: "complete"` artifact
// as a per-critic `status: "error"`. The artifact-level `blockOnReviewError`
// check above wouldn't fire for that path, so previously the flag had no
// effect for the most common failure mode. The per-critic loop must honor
// it directly: when false, downgrade to a warning instead of a block.

test("gate downgrades per-critic error to warning when blockOnReviewError=false (Cycle 3 #13)", async () => {
  const r = await setupRepo();
  // Mutate the loaded policy in place — narrower than re-loading from disk.
  r.loaded.config.policy.blockOnReviewError = false;
  // Per #1549, the gate's deterministic evidence check now reads from disk,
  // not the critic's in-memory `validation` block. Write per-SHA evidence
  // explicitly so the test isolates the per-critic-error path under test.
  await writePerShaEvidence(r, [{ command: "true", exitCode: 0 }]);
  // Critic stays REQUIRED (default from fixture). This is the realistic
  // production path: `aggregateVerdict()` flips to CHANGES_REQUESTED for
  // any required errored critic in `report.ts`, and the gate's aggregate
  // cross-check used to re-block via `aggregate_changes_requested` even
  // when we'd just downgraded the per-critic error to a warning. The
  // Cycle 3 #13 follow-up tracks `errorsDowngraded` so the cross-check
  // skips when downgrades were the only source of CHANGES_REQUESTED.
  const errored: CriticResult = {
    criticId: "cursor-local-chief-engineer",
    status: "error",
    requiresHumanJudgment: false,
    reviewer: {
      name: "Cursor Local Critic",
      adapter: "cursor-sdk",
      model: { id: "gpt-5.5", params: [] },
      runtime: "local",
    },
    summary: "adapter failed",
    findings: [],
    // Carry valid quality-gate evidence so the deterministic gate-evidence
    // check (Cycle 2 #4) doesn't introduce a different blocker that hides
    // the behavior under test.
    validation: {
      qualityGateResults: [
        {
          command: "true",
          exitCode: 0,
          durationMs: 1,
          startedAt: "2026-05-04T00:00:00Z",
          finishedAt: "2026-05-04T00:00:00Z",
          logExcerpt: "ok",
        },
      ],
      qualityGatesMissing: [],
    },
    confidence: "unknown",
    error: { message: "schema validation failed", retryable: false },
  };
  await writeArtifactWith(r, [errored]);
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_eq(result.blocked, false, "per-critic error must NOT block when blockOnReviewError=false");
  expect_truthy(
    result.warnings.some((w) => w.reason === "critic_error"),
    "per-critic error must surface as a warning",
  );
});

test("gate blocks per-critic error when blockOnReviewError=true (Cycle 3 #13)", async () => {
  const r = await setupRepo();
  // Default fixture config has blockOnReviewError=true; verify the symmetric path.
  // Per #1549, the gate reads evidence from disk; write per-SHA so the test
  // isolates critic_error rather than colliding with required_gate_missing.
  await writePerShaEvidence(r, [{ command: "true", exitCode: 0 }]);
  const errored: CriticResult = {
    criticId: "cursor-local-chief-engineer",
    status: "error",
    requiresHumanJudgment: false,
    reviewer: {
      name: "Cursor Local Critic",
      adapter: "cursor-sdk",
      model: { id: "gpt-5.5", params: [] },
      runtime: "local",
    },
    summary: "adapter failed",
    findings: [],
    validation: {
      qualityGateResults: [
        {
          command: "true",
          exitCode: 0,
          durationMs: 1,
          startedAt: "2026-05-04T00:00:00Z",
          finishedAt: "2026-05-04T00:00:00Z",
          logExcerpt: "ok",
        },
      ],
      qualityGatesMissing: [],
    },
    confidence: "unknown",
    error: { message: "schema validation failed", retryable: false },
  };
  await writeArtifactWith(r, [errored]);
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_eq(result.blocked, true);
  expect_truthy(result.blocks.some((b) => b.reason === "critic_error"));
});

test("gate blocks when required gate evidence has non-zero exit (even with APPROVED verdict)", async () => {
  const r = await setupRepo();
  // Per #1549, evidence comes from the per-SHA file on disk. Write evidence
  // with exitCode=1 for the required "true" gate so the gate fires the
  // required_gate_failed block (distinct from required_gate_missing).
  await writePerShaEvidence(r, [{ command: "true", exitCode: 1 }]);
  await writeArtifactWith(r, [approved(r.diffHashStr)]);
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_eq(result.blocked, true);
  expect_truthy(result.blocks.some((b) => b.reason === "required_gate_failed"));
});

// Regression coverage for #1549.
//
// Before #1549, `enforceRequiredQualityGates` read evidence from
// `artifact.criticResults[0]?.validation` — the FIRST critic result. When
// that critic errored (e.g., cursor SDK sandbox failure in CI runs since
// the post-#1546/1547 cleanup), its `status: "error"` result carries an
// empty `validation: { qualityGateResults: [], qualityGatesMissing: [] }`.
// The gate then fired `required_gate_missing` for every required gate even
// though gate-prepare had written real evidence to disk and a SECOND critic
// in the same run completed successfully. The trusted-surface rebind
// flow (#1434, PR #1450) made this surface visible because the mirror step
// only copied per-SHA evidence — but the bug also fires on non-trusted PRs
// when the lead critic errors out, so the fix is independent of the rebind.
//
// After #1549, the gate reads the per-SHA evidence file directly via
// `readPerShaEvidence`, decoupling the evidence verification from the
// critic adapter state entirely.

test("gate reads evidence from per-SHA file even when first critic errored (closes #1549)", async () => {
  const r = await setupRepo();
  // Simulate the production scenario: cursor (criticResults[0]) errored
  // with the sandbox failure, carrying empty validation. The on-disk
  // per-SHA evidence file written by gate-prepare has all required
  // gates passing.
  await writePerShaEvidence(r, [{ command: "true", exitCode: 0 }]);
  const erroredFirstCritic: CriticResult = {
    criticId: "cursor-local-chief-engineer",
    status: "error",
    requiresHumanJudgment: false,
    reviewer: {
      name: "Cursor Local Critic",
      adapter: "cursor-sdk",
      model: { id: "gpt-5.5", params: [] },
      runtime: "local",
    },
    summary: "cursor SDK run failed (permanent): sandbox not supported",
    findings: [],
    validation: { qualityGateResults: [], qualityGatesMissing: [] },
    confidence: "unknown",
    error: { message: "Local SDK sandboxing was requested", retryable: false },
  };
  // Mutate fixture so the errored critic doesn't trip blockOnReviewError
  // — we want to isolate the evidence-read path under test.
  r.loaded.config.policy.blockOnReviewError = false;
  await writeArtifactWith(r, [erroredFirstCritic]);
  const result = await evaluateCommitGate({
    loaded: r.loaded,
    commit: r.sha,
    cwd: r.dir,
    bypassReason: "",
  });
  expect_truthy(
    !result.blocks.some((b) => b.reason === "required_gate_missing"),
    `required_gate_missing must NOT fire when per-SHA evidence on disk satisfies all required gates, even if criticResults[0].validation is empty. Got blocks: ${JSON.stringify(result.blocks)}`,
  );
  // Sanity check: the test setup actually exercised the regression scenario.
  expect_eq(erroredFirstCritic.status, "error");
  expect_eq(erroredFirstCritic.validation.qualityGateResults.length, 0);
});
