// Shared loader + renderers for `df show` / `df status` CLI subcommands
// and the `df_show_run` / `df_findings` MCP tools.
//
// The CLI subcommands and the MCP tools both answer the same operator
// question — "what did the local critic say about this commit?" — so
// they share one config + git + artifact load path. Splitting that
// behind a single module is the no-drift discipline cycle 331.1 sets
// for the consumer-contract surface: any change to "what counts as a
// review artifact" lands in one place, and the CLI's `--json` shape
// stays byte-equivalent with the MCP tool's `structuredContent.artifact`
// shape (cycle 5 spec requirement).
//
// Imports for this module are scoped to pure-data backends — no
// adapter / SDK loads. The MCP tools live in `src/mcp/tools/findings.ts`
// and re-export `loadForCommit` from here so adding a CLI consumer does
// not duplicate the config-loader's error-handling pattern.

import type { ReviewArtifact } from "@momentiq/dark-factory-schemas";

import { resolveCommit } from "../git.js";
import { loadAgentReviewConfig } from "../policy/config.js";
import { readArtifact } from "../report.js";

export interface LoadOutcome {
  readonly artifact: ReviewArtifact | null;
  readonly resolvedSha: string | null;
  readonly error?: string;
}

/**
 * Resolve a commit ref through git rev-parse, load the agent-review
 * config from `<cwd>/.agent-review/config.json`, and read the
 * per-commit ReviewArtifact JSON.
 *
 * Returns `{ artifact: null, error: <message> }` for every failure
 * mode so callers can choose how to surface the message (CLI → stderr
 * + exit 1; MCP → `isError: true` + content block).
 */
export async function loadForCommit(
  cwd: string,
  commit: string,
): Promise<LoadOutcome> {
  let loaded;
  try {
    loaded = await loadAgentReviewConfig({ cwd });
  } catch (err) {
    return {
      artifact: null,
      resolvedSha: null,
      error: `failed to load .agent-review/config.json: ${(err as Error).message}`,
    };
  }

  let sha: string;
  try {
    sha = await resolveCommit(commit, cwd);
  } catch (err) {
    return {
      artifact: null,
      resolvedSha: null,
      error: `failed to resolve commit "${commit}" via git rev-parse: ${
        (err as Error).message
      }`,
    };
  }

  const artifact = await readArtifact(loaded, sha);
  if (!artifact) {
    return {
      artifact: null,
      resolvedSha: sha,
      error: `no review artifact found for ${sha}; run \`df review --commit ${sha.slice(
        0,
        12,
      )}\` first or check that .git/agent-reviews/${sha}.json exists.`,
    };
  }
  return { artifact, resolvedSha: sha };
}

/**
 * Render a one-block human-readable view of a ReviewArtifact's status
 * (commit, verdict, per-critic line). Used by `df status` (no JSON)
 * and by the markdown blob `df_show_run` returns alongside the
 * structured artifact.
 */
export function renderStatusText(artifact: ReviewArtifact): string {
  const lines: string[] = [
    `commit:   ${artifact.commit}`,
    `status:   ${artifact.status}`,
    `verdict:  ${artifact.gateVerdict ?? "(pending)"}`,
    `range:    ${artifact.range}`,
    `aggregation: ${artifact.aggregationPolicy}`,
    `createdAt: ${artifact.createdAt}`,
  ];
  if (artifact.criticResults.length > 0) {
    lines.push("critics:");
    for (const r of artifact.criticResults) {
      const verdict = r.verdict ? `, ${r.verdict}` : "";
      lines.push(
        `  - ${r.criticId} [${r.status}${verdict}] — findings=${r.findings.length}`,
      );
    }
  }
  if (artifact.bypass) {
    lines.push(`bypass: ${artifact.bypass.reason} (at ${artifact.bypass.at})`);
  }
  return lines.join("\n");
}

/**
 * The exact structured shape `df_show_run` returns and `df show --json`
 * prints — the cycle 5 spec requires byte-equivalence between these two
 * surfaces. Wrapping the artifact in `{ artifact: <...> }` mirrors the
 * MCP tool's `structuredContent` envelope.
 */
export function showRunStructured(
  artifact: ReviewArtifact,
): { artifact: ReviewArtifact } {
  return { artifact };
}
