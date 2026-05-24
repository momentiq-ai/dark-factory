import { resolve } from "node:path";

import type { LoadedConfig } from "./policy/config.js";
import { gitCommonDir, gitDir } from "./git.js";

export async function resolveArtifactRoot(loaded: LoadedConfig): Promise<string> {
  if (loaded.config.git.artifactScope === "git-common-dir") {
    return gitCommonDir(loaded.repoRoot);
  }
  return gitDir(loaded.repoRoot);
}

export async function resolveArtifactDir(loaded: LoadedConfig): Promise<string> {
  return resolve(await resolveArtifactRoot(loaded), loaded.config.git.artifactDir);
}

export function artifactJsonPath(artifactDir: string, sha: string): string {
  return resolve(artifactDir, `${sha}.json`);
}

export function artifactMarkdownPath(artifactDir: string, sha: string): string {
  return resolve(artifactDir, `${sha}.md`);
}

export function artifactLockPath(artifactDir: string, sha: string): string {
  return resolve(artifactDir, `${sha}.lock`);
}

export function diagnosticsDir(artifactDir: string): string {
  return resolve(artifactDir, "diagnostics");
}

export function telemetryPath(artifactDir: string): string {
  return resolve(artifactDir, "_runs.ndjson");
}

export async function resolveValidationResultPath(loaded: LoadedConfig): Promise<string> {
  const root = await resolveArtifactRoot(loaded);
  return resolve(root, loaded.config.validation.resultFile);
}

// Cycle 332 — per-PR finding-cache directory. Lives under the
// artifact dir (git-common-dir) so a single worktree can hold caches
// for multiple PRs simultaneously without collision. The CI runner
// is the primary writer; the local critic does not touch this path
// in Phase 2 (Q7 of the cycle doc).
export function findingCacheDir(artifactDir: string, prNumber: number): string {
  return resolve(artifactDir, `_pr-${prNumber}`);
}

export function findingCachePath(artifactDir: string, prNumber: number): string {
  return resolve(findingCacheDir(artifactDir, prNumber), "findings.ndjson");
}
