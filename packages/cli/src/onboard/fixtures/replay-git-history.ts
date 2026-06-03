// Replay a fixture's compact git-history.txt into a real synthetic git
// repo — used by the fixture builder (Task 11) AND the integration test
// (Task 12). Shipped from src/ (not tests/) so the build script and the
// integration test always agree on the replay semantics.
//
// Format (line-oriented, deterministic; ≤ 5 KB per fixture):
//
//   # comment lines start with '#'
//   canonical: <owner>/<name>
//   defaultBranch: <branch>
//   remote: https://github.com/<owner>/<name>.git
//
//   subjects:
//   <subject 1>
//   <subject 2>
//   ...
//
// Authors / dates / SHAs are NOT preserved — only the canonical remote,
// default branch, and subject stream that drives recentCommitConventions
// detection.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const ex = promisify(execFile);

export interface GitHistoryFixture {
  canonical: string;
  defaultBranch: string;
  remote: string;
  subjects: string[];
}

export function parseGitHistory(body: string): GitHistoryFixture {
  const lines = body.split(/\r?\n/);
  let canonical = "";
  let defaultBranch = "main";
  let remote = "";
  const subjects: string[] = [];
  let mode: "meta" | "subjects" = "meta";
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (mode === "meta") {
      if (line.startsWith("#") || line === "") continue;
      if (line.startsWith("canonical:")) {
        canonical = line.slice("canonical:".length).trim();
      } else if (line.startsWith("defaultBranch:")) {
        defaultBranch = line.slice("defaultBranch:".length).trim();
      } else if (line.startsWith("remote:")) {
        remote = line.slice("remote:".length).trim();
      } else if (line === "subjects:") {
        mode = "subjects";
      }
    } else {
      if (line === "" || line.startsWith("#")) continue;
      subjects.push(line);
    }
  }
  return { canonical, defaultBranch, remote, subjects: subjects.slice(0, 200) };
}

/**
 * Initialize `<repoDir>` as a real git repo with the fixture's remote and
 * default-branch metadata, then replay the subjects as empty commits over
 * an initial commit that captures whatever files already exist in repoDir.
 *
 * After this returns the git analyzer will see:
 *   - a real .git dir
 *   - an origin remote (so canonicalName parses)
 *   - the right default branch
 *   - up to 200 subjects via `git log --pretty=%s` (oldest → newest)
 */
export async function replayGitHistory(
  repoDir: string,
  fixture: GitHistoryFixture,
): Promise<void> {
  await ex("git", ["init", "-b", fixture.defaultBranch], { cwd: repoDir });
  await ex("git", ["config", "user.email", "fixture@test"], { cwd: repoDir });
  await ex("git", ["config", "user.name", "Fixture"], { cwd: repoDir });
  await ex("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir });
  if (fixture.remote) {
    await ex("git", ["remote", "add", "origin", fixture.remote], { cwd: repoDir });
    // The git analyzer reads origin/HEAD via symbolic-ref to derive the
    // default branch. Without an actual remote fetch we set it manually
    // so the fixture's defaultBranch survives the round-trip.
    await ex(
      "git",
      [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        `refs/remotes/origin/${fixture.defaultBranch}`,
      ],
      { cwd: repoDir },
    );
  }
  const firstSubject = fixture.subjects[0] ?? "chore: initial fixture commit";
  await ex("git", ["add", "-A"], { cwd: repoDir });
  await ex(
    "git",
    ["commit", "--allow-empty", "-m", firstSubject],
    { cwd: repoDir },
  );
  for (const subject of fixture.subjects.slice(1)) {
    await ex(
      "git",
      ["commit", "--allow-empty", "-m", subject],
      { cwd: repoDir },
    );
  }
}
