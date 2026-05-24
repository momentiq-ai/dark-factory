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
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentReviewConfig } from "../src/policy/config.js";
import { buildReviewPacket } from "../src/trusted-surface/rebind.js";
import { perShaQualityGatePath } from "../src/evidence.js";
import { gitCommonDir, repoRoot } from "../src/git.js";
import { resolveArtifactRoot, resolveValidationResultPath } from "../src/paths.js";

const CONFIG = {
  version: 1,
  critics: [
    {
      id: "cursor-local-chief-engineer",
      name: "Cursor Local Critic",
      adapter: "cursor-sdk",
      required: true,
      runtime: "local",
      model: { id: "gpt-5.5", params: [] },
    },
  ],
  aggregation: { policy: "block-if-any", blockingSeverities: ["blocker", "high"] },
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
  },
  validation: {
    runBeforeReview: false,
    resultFile: "agent-reviews/quality-gates/latest.json",
    requiredQualityGates: ["make test"],
    optionalQualityGates: [],
  },
  security: { redactSecretsInDiagnostics: true, treatDiffAsUntrustedInput: true },
};

function runGit(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, env: process.env });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
}

test("buildReviewPacket builds packet for a commit in a temp repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-review-ctx-"));
  runGit(["init", "-q", "-b", "main", dir], process.cwd());
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
  // Initial commit
  writeFileSync(join(dir, "README.md"), "# repo\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "initial"], dir);
  // Second commit (the one we review)
  mkdirSync(join(dir, "backend"), { recursive: true });
  writeFileSync(join(dir, "backend/foo.py"), "def foo():\n    return 1\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "feat: add foo"], dir);
  // .agent-review/config.json
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(CONFIG));

  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const packet = await buildReviewPacket(loaded, { cwd: dir });

  expect_eq(packet.branch, "main");
  expect_eq(packet.commit.subject, "feat: add foo");
  const fooFile = packet.changedFiles.find((f) => f.path === "backend/foo.py");
  expect_truthy(fooFile, "expected backend/foo.py to be in changed files");
  expect_eq(fooFile?.status, "A");
  expect_match(fooFile?.content ?? "", /def foo/);
  expect_match(packet.diffHash, /^sha256:[0-9a-f]{64}$/);
});

test("repoRoot and gitCommonDir resolve in the current repo", async () => {
  const root = await repoRoot();
  const common = await gitCommonDir();
  expect_truthy(root.length > 0);
  expect_truthy(common.length > 0);
});

// Path-traversal guard: config is loaded from HEAD, so a malicious commit
// could set guidanceFiles to absolute paths or `..` traversal and exfiltrate
// workstation files through the critic prompt (which is an external API call).
async function setupPathTraversalRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "agent-review-traversal-"));
  runGit(["init", "-q", "-b", "main", dir], process.cwd());
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# repo\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "initial"], dir);
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  return dir;
}

test("buildReviewPacket rejects guidance file with absolute path (security)", async () => {
  const dir = await setupPathTraversalRepo();
  const malicious = { ...CONFIG, context: { ...CONFIG.context, guidanceFiles: ["/etc/passwd"] } };
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(malicious));
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  await expect_rejects(
    () => buildReviewPacket(loaded, { cwd: dir }),
    /must be repo-relative, got absolute/,
  );
});

test("buildReviewPacket rejects guidance file with `..` traversal (security)", async () => {
  const dir = await setupPathTraversalRepo();
  const malicious = {
    ...CONFIG,
    context: { ...CONFIG.context, guidanceFiles: ["../../../etc/passwd"] },
  };
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(malicious));
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  await expect_rejects(
    () => buildReviewPacket(loaded, { cwd: dir }),
    /escapes repo root/,
  );
});

test("buildReviewPacket rejects prompt fragment with absolute path (security)", async () => {
  const dir = await setupPathTraversalRepo();
  const malicious = {
    ...CONFIG,
    context: { ...CONFIG.context, promptFragments: ["/Users/anyone/.ssh/id_rsa"] },
  };
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(malicious));
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  await expect_rejects(
    () => buildReviewPacket(loaded, { cwd: dir }),
    /must be repo-relative, got absolute/,
  );
});

test("buildReviewPacket rejects symlink that escapes repo root (security)", async () => {
  // The lexical containment check passes for `leak` (no `..`, not absolute),
  // but the symlink target is outside the repo. Without realpath resolution,
  // a malicious commit could ship a tracked symlink and exfiltrate secrets.
  const dir = await setupPathTraversalRepo();
  const outside = mkdtempSync(join(tmpdir(), "agent-review-secret-"));
  writeFileSync(join(outside, "fake-secret.txt"), "PRETEND-API-KEY=xxx\n");
  symlinkSync(join(outside, "fake-secret.txt"), join(dir, "leak"));
  const malicious = { ...CONFIG, context: { ...CONFIG.context, guidanceFiles: ["leak"] } };
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(malicious));
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  await expect_rejects(
    () => buildReviewPacket(loaded, { cwd: dir }),
    /resolves \(via symlink\) outside repo root/,
  );
});

test("buildReviewPacket rejects symlinked prompt fragment that escapes repo root (security)", async () => {
  const dir = await setupPathTraversalRepo();
  const outside = mkdtempSync(join(tmpdir(), "agent-review-secret-"));
  writeFileSync(join(outside, "fake-secret.txt"), "PRETEND-API-KEY=xxx\n");
  symlinkSync(join(outside, "fake-secret.txt"), join(dir, "leak"));
  const malicious = { ...CONFIG, context: { ...CONFIG.context, promptFragments: ["leak"] } };
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(malicious));
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  await expect_rejects(
    () => buildReviewPacket(loaded, { cwd: dir }),
    /resolves \(via symlink\) outside repo root/,
  );
});

// ----------------------------------------------------------------------------
// Issue #1370 — readValidationEvidence per-SHA fallback regression coverage.
//
// Cycle 318.2 introduced the per-SHA evidence layout
// (`<git-common-dir>/agent-reviews/quality-gates/<sha>.json`) but left the
// runtime reader on the legacy `latest.json` path. Any time `latest.json`'s
// `commit` field didn't match the commit being reviewed (multi-commit gate
// runs, polluting test fixtures, etc.) the critic prompt would receive
// `qualityGateResults: []` and `qualityGatesMissing: [<all required gates>]`
// even though valid per-SHA evidence existed on disk.
//
// The three tests below exercise `readValidationEvidence` indirectly through
// `buildReviewPacket` — which is its only call site — and cover:
//
//   1. Per-SHA file is preferred when both per-SHA and latest.json exist and
//      latest.json points at a different SHA (the symptom of the bug).
//   2. Per-SHA file is read when latest.json is missing entirely.
//   3. Legacy happy path — latest.json with a matching SHA still works,
//      preserving back-compat for evidence written by old runners.
// ----------------------------------------------------------------------------

interface PerShaRepoSetup {
  dir: string;
  sha: string;
}

async function setupRepoForPerShaTest(): Promise<PerShaRepoSetup> {
  const dir = mkdtempSync(join(tmpdir(), "agent-review-per-sha-ctx-"));
  runGit(["init", "-q", "-b", "main", dir], process.cwd());
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# repo\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "initial"], dir);
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(CONFIG));
  const sha = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).stdout.trim();
  return { dir, sha };
}

function makeEvidenceJson(commit: string, command: string): string {
  return JSON.stringify({
    version: 2,
    commit,
    generatedAt: "2026-05-16T00:00:00Z",
    results: [
      {
        command,
        exitCode: 0,
        durationMs: 1,
        logExcerpt: "ok",
        startedAt: "2026-05-16T00:00:00Z",
        finishedAt: "2026-05-16T00:00:00Z",
      },
    ],
  });
}

test("buildReviewPacket prefers per-SHA evidence when latest.json points at a different SHA (#1370)", async () => {
  // Symptom of #1370: the reviewer/runtime was reading latest.json only, so
  // a stale latest.json (pointing at a different commit, e.g., from the
  // sister `agent-review-test` test-pollution issue) would cause the packet
  // to report `qualityGateResults: []` and `stale: true` — even when valid
  // per-SHA evidence existed on disk.
  const { dir, sha } = await setupRepoForPerShaTest();
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const artifactRoot = await resolveArtifactRoot(loaded);
  const perShaPath = perShaQualityGatePath(artifactRoot, loaded.config.git.artifactDir, sha);
  mkdirSync(perShaPath.substring(0, perShaPath.lastIndexOf("/")), { recursive: true });
  writeFileSync(perShaPath, makeEvidenceJson(sha, "make test"));
  // Write a polluted latest.json pointing at a different SHA — this is the
  // exact pattern produced by `agent-review-test` fixture runs.
  const latestPath = await resolveValidationResultPath(loaded);
  mkdirSync(latestPath.substring(0, latestPath.lastIndexOf("/")), { recursive: true });
  writeFileSync(latestPath, makeEvidenceJson("3e75f111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "make test"));

  const packet = await buildReviewPacket(loaded, { cwd: dir });
  expect_eq(packet.validation.evidence.length, 1, "expected per-SHA evidence to be surfaced");
  expect_eq(packet.validation.evidence[0]?.command, "make test");
  expect_deep(packet.validation.missing, [], "no required gates should be reported missing");
  expect_eq(packet.validation.stale, false, "stale should be false when per-SHA matches HEAD");
});

test("buildReviewPacket reads per-SHA evidence even when latest.json is absent (#1370)", async () => {
  // Per-SHA-only (no legacy file) is the canonical post-318.2 state; the
  // legacy resultFile copy is back-compat sugar. The reader must work
  // without the legacy file at all.
  const { dir, sha } = await setupRepoForPerShaTest();
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const artifactRoot = await resolveArtifactRoot(loaded);
  const perShaPath = perShaQualityGatePath(artifactRoot, loaded.config.git.artifactDir, sha);
  mkdirSync(perShaPath.substring(0, perShaPath.lastIndexOf("/")), { recursive: true });
  writeFileSync(perShaPath, makeEvidenceJson(sha, "make test"));

  const packet = await buildReviewPacket(loaded, { cwd: dir });
  expect_eq(packet.validation.evidence.length, 1);
  expect_eq(packet.validation.evidence[0]?.command, "make test");
  expect_deep(packet.validation.missing, []);
  expect_eq(packet.validation.stale, false);
});

test("buildReviewPacket falls back to latest.json when per-SHA is absent and SHA matches (legacy happy path)", async () => {
  // Back-compat regression guard: evidence produced by a pre-318.2 runner
  // (legacy `latest.json` only, no per-SHA file) must still resolve when
  // its `commit` field matches HEAD.
  const { dir, sha } = await setupRepoForPerShaTest();
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const latestPath = await resolveValidationResultPath(loaded);
  mkdirSync(latestPath.substring(0, latestPath.lastIndexOf("/")), { recursive: true });
  writeFileSync(latestPath, makeEvidenceJson(sha, "make test"));

  const packet = await buildReviewPacket(loaded, { cwd: dir });
  expect_eq(packet.validation.evidence.length, 1);
  expect_eq(packet.validation.evidence[0]?.command, "make test");
  expect_deep(packet.validation.missing, []);
  expect_eq(packet.validation.stale, false);
});
