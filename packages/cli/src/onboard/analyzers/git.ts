// packages/cli/src/onboard/analyzers/git.ts
//
// Cycle 15 Phase A — Task 7. Populates:
//   - canonicalName       (owner/repo from origin remote, HTTPS or SSH)
//   - git.defaultBranch   (origin/HEAD symref, falling back to local HEAD)
//   - git.recentCommitConventions.{conventional,cycleReferenced}
//     (derived from up to the last 200 commit subjects)
//
// Returns null when the directory isn't a git repo, when git commands fail,
// or when the repo has no commits yet (zero-subject sample = no signal).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Analyzer } from "../analyzer.js";

const ex = promisify(execFile);

async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await ex("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

// HTTPS form: https://host/owner/repo[.git]
// SSH form:   user@host:owner/repo[.git]
// Host-agnostic by design (works for github.com, gitlab.com, self-hosted, …).
function parseCanonicalName(remoteUrl: string): string {
  const https = remoteUrl.match(
    /^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = remoteUrl.match(/^[^@]+@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return "";
}

const CONVENTIONAL_RE =
  /^(feat|fix|docs|chore|refactor|test|perf|build|ci)(\([^)]+\))?(!)?:\s/;
const CYCLE_RE = /[Cc]ycle \d+|closes #\d+/;

export const gitAnalyzer: Analyzer = {
  name: "git",
  async detect(rootDir) {
    // Cheapest probe: `git rev-parse --git-dir` confirms it's a git repo.
    const gitDir = await gitOut(rootDir, ["rev-parse", "--git-dir"]);
    if (gitDir === null) return null;

    // Origin remote → canonicalName. Missing remote is fine (empty string).
    const remote =
      (await gitOut(rootDir, ["remote", "get-url", "origin"]))?.trim() ?? "";
    const canonicalName = remote ? parseCanonicalName(remote) : "";

    // Default branch: prefer origin/HEAD symref, fall back to local HEAD,
    // final fallback "main" so the schema always has a non-empty string.
    let defaultBranch = "main";
    const symRef = (
      await gitOut(rootDir, [
        "symbolic-ref",
        "--quiet",
        "refs/remotes/origin/HEAD",
      ])
    )?.trim();
    if (symRef && symRef.startsWith("refs/remotes/origin/")) {
      defaultBranch = symRef.slice("refs/remotes/origin/".length);
    } else {
      const head = (
        await gitOut(rootDir, ["rev-parse", "--abbrev-ref", "HEAD"])
      )?.trim();
      if (head && head !== "HEAD") defaultBranch = head;
    }

    // Sample the last 200 subjects. A fresh repo with zero commits returns
    // null — we cannot make a conventional/cycle call without any signal.
    const subjectsBlob =
      (await gitOut(rootDir, ["log", "--pretty=%s", "-200"])) ?? "";
    const subjects = subjectsBlob
      .split(/\r?\n/)
      .filter((s) => s.length > 0);
    if (subjects.length === 0) return null;

    const convCount = subjects.filter((s) => CONVENTIONAL_RE.test(s)).length;
    const cycleCount = subjects.filter((s) => CYCLE_RE.test(s)).length;
    const conventional = convCount / subjects.length >= 0.3;
    const cycleReferenced = cycleCount / subjects.length >= 0.2;

    return {
      canonicalName,
      git: {
        recentCommitConventions: { conventional, cycleReferenced },
        defaultBranch,
      },
    };
  },
};
