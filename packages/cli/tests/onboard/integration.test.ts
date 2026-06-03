// Integration test — analyze() over each fixture's replayed-git state
// deep-equals its golden.json. The replayed state is what the build
// script (packages/cli/scripts/build-fixture.ts) produced the golden
// against, so any deviation in analyze() against the same input is a
// real analyzer regression.
//
// Per-fixture flow:
//   1. mkdtemp → extract <fixture>/tree.tar.gz into the tmp.
//   2. parseGitHistory(<fixture>/git-history.txt) → fixture record.
//   3. replayGitHistory(tmp, fixture) → real synthetic git repo.
//   4. analyze(tmp) → schema-validated RepoAnalysis.
//   5. Normalize repoRoot on actual to "<NORM>" (matches the golden;
//      goldens store repoRoot as "<NORM>" because the tmp path varies
//      across runs).
//   6. expect(normalized actual).toEqual(JSON.parse(golden)).
//   7. Spot-checks: canonicalName + defaultBranch match the
//      git-history record; serialized length ≤ 16 KB.

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { analyze } from "../../src/onboard/analyze.js";
import {
  parseGitHistory,
  replayGitHistory,
} from "../../src/onboard/fixtures/replay-git-history.js";

const ex = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(HERE, "fixtures");
const REPO_ANALYSIS_BYTE_BUDGET = 16_384;

const FIXTURES = [
  "dark-factory-platform",
  "sage3c",
  "dark-factory-dashboard",
  "cognaa-protoapp",
] as const;

describe.each(FIXTURES)("integration: %s fixture", (name) => {
  it("analyze() output deep-equals the golden JSON (real git history replayed)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), `onboard-int-${name}-`));
    try {
      const fixtureDir = join(FIXTURES_ROOT, name);
      await ex("tar", ["-xzf", join(fixtureDir, "tree.tar.gz"), "-C", tmp]);
      const history = parseGitHistory(
        await readFile(join(fixtureDir, "git-history.txt"), "utf8"),
      );
      await replayGitHistory(tmp, history);

      const golden = JSON.parse(
        await readFile(join(fixtureDir, "golden.json"), "utf8"),
      );
      const actual = await analyze(tmp);
      const normalize = (a: Record<string, unknown>) => ({
        ...a,
        repoRoot: "<NORM>",
      });
      expect(normalize(actual)).toEqual(normalize(golden));

      // The cycle 15 exit criterion: real fixtures (not just the synthetic
      // minimal from schema.test.ts) MUST hold the 16 KB budget; otherwise
      // Phase B's LLM context overflows.
      expect(JSON.stringify(actual).length).toBeLessThan(REPO_ANALYSIS_BYTE_BUDGET);

      // The git-domain fields require the .git replay to populate. If
      // these match the history record we know gitAnalyzer ran and the
      // integration isn't degenerate.
      expect(actual.canonicalName).toBe(history.canonical);
      expect(actual.git.defaultBranch).toBe(history.defaultBranch);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
