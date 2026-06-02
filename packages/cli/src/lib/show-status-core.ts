// Shared backend for the `df show` / `df status` CLI subcommands and the
// `df_show_run` / `df_findings` MCP tools.
//
// Layering: this module lives under `src/lib/` — the neutral, dependency-
// free domain layer. Both `src/commands/` (CLI handlers) and `src/mcp/`
// (MCP server + tools) depend INTO this module. Reverse imports
// (commands ← mcp, mcp ← commands) are forbidden — they would invert the
// intended layering and entangle the transport layer with the CLI
// command-handler layer.
//
// The CLI subcommands and the MCP tools answer the same operator
// question — "what did the local critic say about this commit?" — so
// they share one config + git + artifact load path, one structured-
// envelope shape, one renderer family. Splitting that behind a single
// module is the no-drift discipline cycle 331.1 sets for the consumer-
// contract surface: any change to "what counts as a review artifact"
// lands in one place, and the CLI's `--json` shape stays byte-equivalent
// with the MCP tool's `structuredContent` shape (cycle 5 spec
// requirement).
//
// Two envelope shapes live here, intentionally distinct:
//   - showRunStructured(): `{ artifact: ReviewArtifact }` — the full
//     unmodified artifact. Returned by `df show --json` and
//     `df_show_run.structuredContent`.
//   - mapArtifactForFindings(): `{ commit, critics: [{ id, status,
//     verdict?, findings: [{ severity, file?, line?, rule, message }] }] }`
//     — the narrowed per-critic findings view. Returned by `df status
//     --json` and `df_findings.structuredContent`.
//
// Imports for this module are scoped to pure-data backends — no
// adapter / SDK loads — so it can be imported safely from any layer.

import type {
  CriticResult,
  ReviewArtifact,
  ReviewFinding,
} from "@momentiq/dark-factory-schemas";

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
 * Render the rich human-readable view of a ReviewArtifact — commit,
 * status, verdict, range, aggregation policy, createdAt, per-critic
 * lines with finding counts, optional bypass block.
 *
 * Used by `df show` (no JSON). Also embedded in the markdown blob
 * `df_show_run` returns alongside the structured artifact.
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
 * Render the TERSE human-readable view — short commit, verdict, one
 * line per critic. Used by `df status` (no JSON). Distinct from
 * `renderStatusText()` so the help-advertised "terse verdict + per-
 * critic status" promise is honored and `df status` text output does
 * not duplicate `df show`'s rich block.
 */
export function renderTerseStatusText(artifact: ReviewArtifact): string {
  const verdict = artifact.gateVerdict ?? "(pending)";
  const lines: string[] = [
    `${artifact.commit.slice(0, 12)}  ${verdict}`,
  ];
  for (const r of artifact.criticResults) {
    const v = r.verdict ?? r.status;
    lines.push(
      `  ${r.criticId.padEnd(36)} ${v.padEnd(20)} findings=${r.findings.length}`,
    );
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

// ---------------------------------------------------------------------------
// df_findings narrowed-shape mappers — used by `df status --json` AND
// `df_findings.structuredContent`. The cycle 5 spec requires byte-
// equivalence between the two surfaces; both routes call
// `mapArtifactForFindings()` on the SAME `LoadOutcome.artifact`.
//
// Field mapping (from cycle 5 spec):
//   - `rule`    = the underlying `ReviewFinding.category` (free-form
//                 critic-supplied classifier like "tdd-violation" or
//                 "untyped-any" — the natural "rule" analog in the
//                 schemas-side shape).
//   - `message` = the underlying `ReviewFinding.evidence` (concrete
//                 code/text the critic cites). impact and requiredFix
//                 are intentionally NOT included in the narrowed
//                 view: callers wanting the full context use
//                 `df show` / `df_show_run`, which returns the unmodified
//                 artifact.
// ---------------------------------------------------------------------------

export interface DfFinding {
  readonly severity: string;
  readonly file?: string;
  readonly line?: number;
  readonly rule: string;
  readonly message: string;
}

export interface DfFindingsCritic {
  readonly id: string;
  readonly status: string;
  readonly verdict?: string;
  readonly findings: readonly DfFinding[];
}

export interface DfFindingsResult {
  readonly commit: string;
  readonly critics: readonly DfFindingsCritic[];
}

export function mapFindingForSpec(finding: ReviewFinding): DfFinding {
  return {
    severity: finding.severity,
    ...(finding.file !== undefined ? { file: finding.file } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    rule: finding.category,
    message: finding.evidence,
  };
}

export function mapCriticForSpec(result: CriticResult): DfFindingsCritic {
  return {
    id: result.criticId,
    status: result.status,
    ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
    findings: result.findings.map(mapFindingForSpec),
  };
}

export function mapArtifactForFindings(
  artifact: ReviewArtifact,
): DfFindingsResult {
  return {
    commit: artifact.commit,
    critics: artifact.criticResults.map(mapCriticForSpec),
  };
}
