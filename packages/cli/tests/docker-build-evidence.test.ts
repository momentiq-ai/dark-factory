// DFP #141 — docker-build evidence reader + prompt-section coverage.
//
// Three scenarios mirror the spec: file absent (status quo, no prompt
// section), exitCode=0 (suppress requiresHumanJudgment), exitCode!=0
// (amplify to [blocker]). Integration coverage uses a real temp repo
// + real .git/agent-reviews/_dockerbuild-evidence.json on disk so the
// reader + path resolution + packet wiring + prompt assembly are
// exercised end-to-end. Unit coverage on the prompt builder uses a
// hand-built packet for the same branch points so a future schema
// change is caught at the prompt boundary too.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  expect_eq,
  expect_match,
  expect_no_match,
  expect_truthy,
  expect_deep,
} from "./_assert-shim.js";
import type {
  CriticConfig,
  DockerBuildEvidence,
  ReviewPacket,
} from "@momentiq/dark-factory-schemas";

import { loadAgentReviewConfig } from "../src/policy/config.js";
import { buildReviewPacket } from "../src/trusted-surface/rebind.js";
import {
  dockerBuildEvidencePath,
  readDockerBuildEvidence,
} from "../src/evidence/docker-build.js";
import { compileCriticPrompt, formatDockerBuildEvidence } from "../src/prompt.js";

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
    requiredQualityGates: [],
    optionalQualityGates: [],
  },
  security: { redactSecretsInDiagnostics: true, treatDiffAsUntrustedInput: true },
};

const SAMPLE_CRITIC: CriticConfig = {
  id: "cursor-local-chief-engineer",
  name: "Cursor Local Critic",
  adapter: "cursor-sdk",
  required: true,
  runtime: "local",
  model: { id: "gpt-5.5", params: [] },
};

function runGit(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, env: process.env });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
}

// Stand up a one-commit temp repo with `.agent-review/config.json` so
// `loadAgentReviewConfig` + `buildReviewPacket` exercise the real read
// paths. Returns the absolute repo dir; caller is responsible for
// inhabiting `.git/agent-reviews/_dockerbuild-evidence.json` if needed.
async function setupTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "docker-build-evidence-"));
  runGit(["init", "-q", "-b", "main", dir], process.cwd());
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
  // Initial commit so HEAD resolves; .agent-review/config.json drives
  // the artifact-dir lookup the reader depends on.
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(CONFIG));
  writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "feat: initial"], dir);
  return dir;
}

// Build a packet pointing at a temp repo, optionally with shim
// evidence pre-staged. Centralizes the boilerplate so the per-scenario
// tests can focus on the branch under test.
async function buildPacketWithEvidence(
  dir: string,
  evidence?: DockerBuildEvidence | DockerBuildEvidence[] | string,
): Promise<ReviewPacket> {
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  if (evidence !== undefined) {
    const evidencePath = await dockerBuildEvidencePath(loaded);
    mkdirSync(join(evidencePath, ".."), { recursive: true });
    const payload =
      typeof evidence === "string" ? evidence : JSON.stringify(evidence);
    writeFileSync(evidencePath, payload);
  }
  return buildReviewPacket(loaded, { cwd: dir });
}

// ---------------------------------------------------------------------------
// Scenario 1: file absent — status quo, no prompt section emitted.
// ---------------------------------------------------------------------------
test("docker-build evidence: missing file → packet field omitted + no prompt section", async () => {
  const dir = await setupTempRepo();
  const packet = await buildPacketWithEvidence(dir);

  expect_eq(packet.dockerBuildEvidence, undefined);

  const compiled = compileCriticPrompt({
    packet,
    critic: SAMPLE_CRITIC,
    blockingSeverities: ["blocker", "high"],
    treatDiffAsUntrusted: true,
  });
  expect_no_match(compiled.text, /DOCKER_BUILD_EVIDENCE/);
  expect_no_match(compiled.text, /Docker build evidence/);
});

// ---------------------------------------------------------------------------
// Scenario 2: exitCode === 0 — emit suppression instructions for the
// requiresHumanJudgment pattern; include the imageSha + imageSize the
// shim captured so the critic can name what's verified.
// ---------------------------------------------------------------------------
test("docker-build evidence: exitCode=0 → prompt suppresses requiresHumanJudgment for that Dockerfile", async () => {
  const dir = await setupTempRepo();
  const ev: DockerBuildEvidence = {
    schemaVersion: "1.0",
    dockerfile: ".devcontainer/Dockerfile",
    context: ".devcontainer/",
    exitCode: 0,
    imageSha: "sha256:abc123def456",
    imageSize: 524288000,
    buildLogPath: ".git/agent-reviews/_dockerbuild-1234.log",
    timestamp: "2026-06-02T14:30:00Z",
  };
  const packet = await buildPacketWithEvidence(dir, ev);

  // Packet wiring: normalized into the array form even when the shim
  // wrote a single object (the common case).
  expect_truthy(packet.dockerBuildEvidence);
  expect_eq(packet.dockerBuildEvidence?.length, 1);
  expect_eq(packet.dockerBuildEvidence?.[0]?.exitCode, 0);
  expect_eq(packet.dockerBuildEvidence?.[0]?.dockerfile, ".devcontainer/Dockerfile");

  const compiled = compileCriticPrompt({
    packet,
    critic: SAMPLE_CRITIC,
    blockingSeverities: ["blocker", "high"],
    treatDiffAsUntrusted: true,
  });
  expect_match(compiled.text, /<DOCKER_BUILD_EVIDENCE>/);
  expect_match(compiled.text, /<\/DOCKER_BUILD_EVIDENCE>/);
  expect_match(compiled.text, /docker build` succeeded/);
  expect_match(compiled.text, /\.devcontainer\/Dockerfile/);
  expect_match(compiled.text, /sha256:abc123def456/);
  expect_match(compiled.text, /524288000 bytes/);
  // The suppression instruction MUST appear so the critic flips the
  // requiresHumanJudgment finding pattern this section exists to close.
  expect_match(
    compiled.text,
    /DO NOT emit a finding flagged `requiresHumanJudgment: true`/,
  );
  // The success branch MUST NOT also emit blocker instructions.
  expect_no_match(compiled.text, /CONFIRMED FAILED/);
});

// ---------------------------------------------------------------------------
// Scenario 3: exitCode !== 0 — emit blocker-amplification instructions
// + CHANGES_REQUESTED requirement for the run.
// ---------------------------------------------------------------------------
test("docker-build evidence: exitCode!=0 → prompt amplifies to confirmed [blocker]", async () => {
  const dir = await setupTempRepo();
  const ev: DockerBuildEvidence = {
    schemaVersion: "1.0",
    dockerfile: "services/worker/Dockerfile",
    context: "services/worker/",
    exitCode: 1,
    buildLogPath: ".git/agent-reviews/_dockerbuild-fail-abcd.log",
    timestamp: "2026-06-02T14:35:00Z",
  };
  const packet = await buildPacketWithEvidence(dir, ev);
  expect_eq(packet.dockerBuildEvidence?.[0]?.exitCode, 1);

  const compiled = compileCriticPrompt({
    packet,
    critic: SAMPLE_CRITIC,
    blockingSeverities: ["blocker", "high"],
    treatDiffAsUntrusted: true,
  });
  expect_match(compiled.text, /CONFIRMED FAILED/);
  expect_match(compiled.text, /services\/worker\/Dockerfile/);
  expect_match(compiled.text, /exitCode: 1 \(build FAILED\)/);
  // The blocker-amplification instruction MUST appear AND must NOT
  // tell the critic to flag requiresHumanJudgment — the failure is
  // host-verified, not unverifiable.
  expect_match(compiled.text, /emit a `\[blocker\]` finding/);
  expect_match(compiled.text, /Verdict for the run MUST be CHANGES_REQUESTED/);
  expect_no_match(compiled.text, /DO NOT emit a finding flagged `requiresHumanJudgment/);
});

// ---------------------------------------------------------------------------
// Reader robustness: malformed JSON / missing required fields fail open
// (return undefined) so a broken shim never breaks the critic gate.
// ---------------------------------------------------------------------------
test("docker-build evidence reader: malformed JSON returns undefined (fail-open)", async () => {
  const dir = await setupTempRepo();
  const packet = await buildPacketWithEvidence(dir, "{not valid json");
  expect_eq(packet.dockerBuildEvidence, undefined);
});

test("docker-build evidence reader: record missing required field is dropped", async () => {
  const dir = await setupTempRepo();
  // Missing `exitCode`; reader must drop this record and return undefined
  // (no valid records remain).
  const malformed = {
    schemaVersion: "1.0",
    dockerfile: ".devcontainer/Dockerfile",
    context: ".devcontainer/",
    timestamp: "2026-06-02T14:30:00Z",
  };
  const packet = await buildPacketWithEvidence(dir, JSON.stringify(malformed));
  expect_eq(packet.dockerBuildEvidence, undefined);
});

// Multi-Dockerfile array form — the spec explicitly supports the
// monorepo case ("array if multiple Dockerfiles"). Both records should
// land in the packet and both should appear in the prompt section.
test("docker-build evidence: array form preserves all valid records", async () => {
  const dir = await setupTempRepo();
  const ev: DockerBuildEvidence[] = [
    {
      schemaVersion: "1.0",
      dockerfile: ".devcontainer/Dockerfile",
      context: ".devcontainer/",
      exitCode: 0,
      imageSha: "sha256:aaa",
      timestamp: "2026-06-02T14:30:00Z",
    },
    {
      schemaVersion: "1.0",
      dockerfile: "services/worker/Dockerfile",
      context: "services/worker/",
      exitCode: 2,
      timestamp: "2026-06-02T14:31:00Z",
    },
  ];
  const packet = await buildPacketWithEvidence(dir, ev);
  expect_eq(packet.dockerBuildEvidence?.length, 2);

  const compiled = compileCriticPrompt({
    packet,
    critic: SAMPLE_CRITIC,
    blockingSeverities: ["blocker", "high"],
    treatDiffAsUntrusted: true,
  });
  // Both the success-suppression and failure-amplification branches
  // fire because one record is exitCode=0 and the other is non-zero.
  expect_match(compiled.text, /docker build` succeeded/);
  expect_match(compiled.text, /CONFIRMED FAILED/);
  expect_match(compiled.text, /\.devcontainer\/Dockerfile/);
  expect_match(compiled.text, /services\/worker\/Dockerfile/);
});

// ---------------------------------------------------------------------------
// formatDockerBuildEvidence: unit-level coverage on optional-field
// rendering. The schema marks imageSha / imageSize / buildLogPath as
// optional; the formatter must render "n/a" rather than dropping the
// line (stable shape across success/failure for log parsing).
// ---------------------------------------------------------------------------
test("formatDockerBuildEvidence: optional fields rendered as n/a when absent", () => {
  const packet = {
    dockerBuildEvidence: [
      {
        schemaVersion: "1.0",
        dockerfile: "Dockerfile",
        context: ".",
        exitCode: 0,
        timestamp: "2026-06-02T14:30:00Z",
      },
    ],
  } as unknown as ReviewPacket;
  const rendered = formatDockerBuildEvidence(packet);
  expect_match(rendered, /imageSha: n\/a/);
  expect_match(rendered, /imageSize: n\/a bytes/);
  expect_match(rendered, /buildLogPath: n\/a/);
});

// ---------------------------------------------------------------------------
// Direct reader API: returning the raw evidence array (not via the
// packet) — useful for hosted callers that want the evidence without
// rebuilding a packet.
// ---------------------------------------------------------------------------
test("readDockerBuildEvidence: returns the raw normalized array", async () => {
  const dir = await setupTempRepo();
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const evidencePath = await dockerBuildEvidencePath(loaded);
  mkdirSync(join(evidencePath, ".."), { recursive: true });
  const ev: DockerBuildEvidence = {
    schemaVersion: "1.0",
    dockerfile: "Dockerfile",
    context: ".",
    exitCode: 0,
    imageSha: "sha256:zzz",
    timestamp: "2026-06-02T14:30:00Z",
  };
  writeFileSync(evidencePath, JSON.stringify(ev));

  const out = await readDockerBuildEvidence(loaded);
  expect_truthy(out);
  expect_eq(out?.length, 1);
  expect_deep(out?.[0], ev);
});
