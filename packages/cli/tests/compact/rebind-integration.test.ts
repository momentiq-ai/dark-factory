// ADR 0001 integration tests — end-to-end through buildReviewPacket
// against a temp git repo. Covers ADR § 5.2 tests #7 and #12 and #14.

import { describe, it, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentReviewConfig } from "../../src/policy/config.js";
import { buildReviewPacket } from "../../src/trusted-surface/rebind.js";
import { compileCriticPrompt } from "../../src/prompt.js";
import { runReview } from "../../src/runner.js";
import { MemoryTelemetrySink } from "../../src/evidence/audit-trail.js";
import { AdapterRegistry } from "../../src/adapters/critic.js";
import type { CriticAdapter } from "../../src/adapters/critic.js";
import type { AgentReviewConfig } from "@momentiq/dark-factory-schemas";

function baseConfig(extra: object = {}): AgentReviewConfig {
  return {
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
      maxChangedFileBytes: 5_000_000,
      includeFullChangedFiles: true,
      ...extra,
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
}

function runGit(args: string[], cwd: string): void {
  const r = spawnSync("git", args, { cwd, env: process.env });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
}

function setupRepoWithLockfileCommit(config: AgentReviewConfig): {
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "df-compact-int-"));
  runGit(["init", "-q", "-b", "main", dir], process.cwd());
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
  // Initial commit
  writeFileSync(join(dir, "README.md"), "# repo\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "initial"], dir);
  // Second commit: adds a package-lock.json (entirely new).
  const lockfileV1 = JSON.stringify(
    {
      name: "fake",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "fake", version: "1.0.0" },
        "node_modules/foo": {
          version: "1.2.3",
          resolved: "https://r/foo-1.2.3.tgz",
          integrity: "sha512-FOOHASH==",
        },
        "node_modules/bar": {
          version: "2.0.0",
          resolved: "https://r/bar-2.0.0.tgz",
          integrity: "sha512-BARHASH==",
        },
      },
    },
    null,
    2,
  );
  writeFileSync(join(dir, "package-lock.json"), lockfileV1);
  writeFileSync(join(dir, "src.js"), "function hello() { return 1; }\n");
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(config));
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "feat: add lockfile + source"], dir);
  return { dir };
}

// ----------------------------------------------------------------------------
// ADR § 5.2 #7 — packet-builder-splices-stub
// ----------------------------------------------------------------------------

test("buildReviewPacket compacts matched lockfile in BOTH <diff> and <file> sections (ADR § 5.2 #7)", async () => {
  const config = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      globs: ["**/package-lock.json"],
    },
  });
  const { dir } = setupRepoWithLockfileCommit(config);
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const packet = await buildReviewPacket(loaded, { cwd: dir });

  // packet.diff RETAINS the lockfile body (back-compat surface).
  expect(packet.diff).toContain("node_modules/foo");

  // packet.compactedDiff has the stub.
  expect(packet.compactedDiff).toBeDefined();
  expect(packet.compactedDiff).toContain("[DF-COMPACT v1 npm]");

  // Matched ChangedFile has compactedContent populated AND content cleared.
  const lockfileEntry = packet.changedFiles.find((f) => f.path === "package-lock.json");
  expect(lockfileEntry?.compactedContent).toBeDefined();
  expect(lockfileEntry?.compactedContent).toContain("[DF-COMPACT v1 npm full-content");
  expect(lockfileEntry?.content).toBe("");

  // compileCriticPrompt uses the compacted forms.
  const compiled = compileCriticPrompt({
    packet,
    critic: config.critics[0]!,
    blockingSeverities: ["blocker", "high"],
    treatDiffAsUntrusted: true,
  });
  expect(compiled.text).toContain("[DF-COMPACT v1 npm]"); // diff stub
  expect(compiled.text).toContain("[DF-COMPACT v1 npm full-content"); // file stub
  // RAW lockfile body must appear in NEITHER section of the prompt.
  // Integrity hashes ARE preserved by design (security signal — § 2.3); we
  // assert on the JSON-shape leakage: `resolved` URLs and quoted fields.
  expect(compiled.text).not.toContain('"resolved": "https://r/foo-1.2.3.tgz"');
  expect(compiled.text).not.toContain('"integrity": "sha512-FOOHASH=="');
});

test("buildReviewPacket leaves unmatched files unchanged when no path matches (ADR § 5.2 #7 negative)", async () => {
  // policy present but globs don't match anything in the diff
  const config = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      globs: ["**/never-matches.lock"],
    },
  });
  const { dir } = setupRepoWithLockfileCommit(config);
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const packet = await buildReviewPacket(loaded, { cwd: dir });

  // No compaction occurred — compactedDiff is undefined.
  expect(packet.compactedDiff).toBeUndefined();
  // ChangedFile.content for the lockfile is the raw body.
  const lockfileEntry = packet.changedFiles.find((f) => f.path === "package-lock.json");
  expect(lockfileEntry?.compactedContent).toBeUndefined();
  expect(lockfileEntry?.content).toContain("sha512-FOOHASH==");
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #8 — diff-hash-stable-across-policy-toggle
// ----------------------------------------------------------------------------

test("packet.diffHash is byte-identical regardless of policy mode (ADR § 5.2 #8)", async () => {
  const configFull = baseConfig({
    generatedFilePolicy: {
      mode: "full",
      globs: ["**/package-lock.json"],
    },
  });
  const { dir } = setupRepoWithLockfileCommit(configFull);
  const loadedFull = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const packetFull = await buildReviewPacket(loadedFull, { cwd: dir });

  // Swap the policy to compact in-place and rebuild.
  const configCompact = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      globs: ["**/package-lock.json"],
    },
  });
  writeFileSync(
    join(dir, ".agent-review/config.json"),
    JSON.stringify(configCompact),
  );
  const loadedCompact = await loadAgentReviewConfig({
    cwd: dir,
    validateGuidanceFiles: false,
  });
  const packetCompact = await buildReviewPacket(loadedCompact, { cwd: dir });

  expect(packetFull.diffHash).toBe(packetCompact.diffHash);
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #13 — effective-mode-override-fires-under-mode-full
// (integration variant: top-level full, override compact on specific path)
// ----------------------------------------------------------------------------

test("effective-mode override fires under top-level mode: 'full' (integration, ADR § 5.2 #13)", async () => {
  const config = baseConfig({
    generatedFilePolicy: {
      mode: "full",
      globs: ["**/package-lock.json"],
      overrides: [{ glob: "**/package-lock.json", mode: "compact" }],
    },
  });
  const { dir } = setupRepoWithLockfileCommit(config);
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const packet = await buildReviewPacket(loaded, { cwd: dir });

  // Override fires → compactedDiff is set even though top-level mode is "full".
  expect(packet.compactedDiff).toBeDefined();
  expect(packet.compactedDiff).toContain("[DF-COMPACT v1 npm]");
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #14 — telemetry-compacted-files-event
// ----------------------------------------------------------------------------

function stubAdapter(): CriticAdapter {
  return {
    id: "cursor-sdk",
    requiredEnvVars: [],
    review: async () => ({
      criticId: "cursor-local-chief-engineer",
      status: "complete",
      verdict: "APPROVED",
      requiresHumanJudgment: false,
      reviewer: {
        name: "Cursor Local Critic",
        adapter: "cursor-sdk",
        runtime: "local",
        model: { id: "gpt-5.5", params: [] },
      },
      summary: "stub",
      findings: [],
      validation: { qualityGateResults: [], qualityGatesMissing: [] },
      confidence: "high",
    }),
  };
}

function stubRegistry(): AdapterRegistry {
  const r = new AdapterRegistry();
  r.register(stubAdapter());
  return r;
}

test("runReview emits compacted_files telemetry event when strategy fires (ADR § 5.2 #14)", async () => {
  const config = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      globs: ["**/package-lock.json"],
    },
  });
  const { dir } = setupRepoWithLockfileCommit(config);
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });

  const telemetry = new MemoryTelemetrySink();
  await runReview({
    loaded,
    registry: stubRegistry(),
    cwd: dir,
    telemetry,
  });

  const events = telemetry.events.filter((e) => e.event === "compacted_files");
  expect(events.length).toBe(1);
  expect(events[0]?.findingCount).toBe(1);
  const perFile = JSON.parse(events[0]?.perFileCounts ?? "{}");
  expect(perFile["package-lock.json"]).toBe("npm");
});

test("runReview does NOT emit compacted_files when no path matches (ADR § 5.2 #14 negative)", async () => {
  const config = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      globs: ["**/never-matches.lock"],
    },
  });
  const { dir } = setupRepoWithLockfileCommit(config);
  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });

  const telemetry = new MemoryTelemetrySink();
  await runReview({
    loaded,
    registry: stubRegistry(),
    cwd: dir,
    telemetry,
  });

  const events = telemetry.events.filter((e) => e.event === "compacted_files");
  expect(events.length).toBe(0);
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #5 — parse-error-refuse-and-block (integration end-to-end)
// ----------------------------------------------------------------------------

test("parse-error refuse-and-block populates parseErrorPaths and emits prompt marker (ADR § 5.2 #5)", async () => {
  // Build a repo whose lockfile is structurally valid JSON but isn't
  // shaped like npm/pnpm/yarn (so extractor parse-error path fires).
  const dir = mkdtempSync(join(tmpdir(), "df-parse-err-"));
  runGit(["init", "-q", "-b", "main", dir], process.cwd());
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# repo\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "initial"], dir);
  // Add a `package-lock.json` whose body has NO node_modules entries
  // → npm extractor throws "no node_modules entries found in diff".
  const malformed = JSON.stringify({ name: "weird", lockfileVersion: 3 }, null, 2);
  writeFileSync(join(dir, "package-lock.json"), malformed);
  const config = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      globs: ["**/package-lock.json"],
      onParseError: "refuse-and-block",
    },
  });
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(config));
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "feat: add weird lockfile"], dir);

  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const packet = await buildReviewPacket(loaded, { cwd: dir });
  expect(packet.parseErrorPaths).toBeDefined();
  expect(packet.parseErrorPaths).toContain("package-lock.json");

  const compiled = compileCriticPrompt({
    packet,
    critic: config.critics[0]!,
    blockingSeverities: ["blocker", "high"],
    treatDiffAsUntrustedInput: true,
  } as any);
  expect(compiled.text).toContain("[DF-COMPACT PARSE-ERROR — treat as missing evidence]");
  expect(compiled.text).toContain("package-lock.json");
});

// ----------------------------------------------------------------------------
// ADR § 5.2 #6 — parse-error-compact-with-warning-opt-out
// ----------------------------------------------------------------------------

test("parse-error compact-with-warning suppresses parseErrorPaths injection (ADR § 5.2 #6)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "df-parse-warn-"));
  runGit(["init", "-q", "-b", "main", dir], process.cwd());
  runGit(["config", "user.email", "test@example.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
  runGit(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# repo\n");
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "initial"], dir);
  const malformed = JSON.stringify({ name: "weird", lockfileVersion: 3 }, null, 2);
  writeFileSync(join(dir, "package-lock.json"), malformed);
  const config = baseConfig({
    generatedFilePolicy: {
      mode: "compact",
      globs: ["**/package-lock.json"],
      onParseError: "compact-with-warning",
    },
  });
  mkdirSync(join(dir, ".agent-review"), { recursive: true });
  writeFileSync(join(dir, ".agent-review/config.json"), JSON.stringify(config));
  runGit(["add", "."], dir);
  runGit(["commit", "-q", "-m", "feat: add weird lockfile"], dir);

  const loaded = await loadAgentReviewConfig({ cwd: dir, validateGuidanceFiles: false });
  const packet = await buildReviewPacket(loaded, { cwd: dir });
  // Opt-out → parseErrorPaths NOT set.
  expect(packet.parseErrorPaths).toBeUndefined();
  // But the parse-error stub IS in compactedDiff.
  expect(packet.compactedDiff).toContain("[DF-COMPACT v1 PARSE-ERROR]");

  const compiled = compileCriticPrompt({
    packet,
    critic: config.critics[0]!,
    blockingSeverities: ["blocker", "high"],
    treatDiffAsUntrustedInput: true,
  } as any);
  // Prompt marker absent under opt-out.
  expect(compiled.text).not.toContain("[DF-COMPACT PARSE-ERROR — treat as missing evidence]");
});
