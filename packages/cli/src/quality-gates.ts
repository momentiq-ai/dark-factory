import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { LoadedConfig } from "./policy/config.js";
import { perShaQualityGatePath } from "./evidence.js";

// Consumer-supplied env keys that should be scrubbed from gate subprocess
// environments. This is the OSS-minimal allowlist; consumers needing
// repo-specific scrubbing extend it via the future config surface (Phase D).
// Extracted from sage3c's `tools/agent-review/src/doppler-bootstrap.ts` —
// the bootstrap logic itself is sage3c-specific and stays in the consumer
// repo's own bootstrap path until Phase D externalizes the contract.
const DOPPLER_BOOTSTRAP_ALLOWLIST = Object.freeze([
  "DOPPLER_TOKEN",
  "DOPPLER_SERVICE_TOKEN_SAGE",
] as const);
import {
  resolveArtifactRoot,
  resolveValidationResultPath,
} from "./paths.js";
import {
  parseQualityGateEvidence,
  type QualityGateEvidence,
  type QualityGateResult,
} from "@momentiq/dark-factory-schemas";

const DEFAULT_LOG_EXCERPT_LINES = 80;

export interface QualityGateRunOptions {
  loaded: LoadedConfig;
  commit: string;
  cwd?: string;
  commands?: string[];
  signal?: AbortSignal;
  excerptLines?: number;
  // Optional verification-route id (cycle 318.2 Component 2). When set:
  //   - each result has `routeId` attached
  //   - the final result is keyed under `gateResults[routeId]` so gate-push
  //     can answer "did this route as a whole pass?" without re-parsing
  //     command strings
  routeId?: string;
}

export async function runQualityGates(options: QualityGateRunOptions): Promise<QualityGateEvidence> {
  const { loaded, commit, signal, routeId } = options;
  const cwd = options.cwd ?? loaded.repoRoot;
  const commands = options.commands ?? loaded.config.validation.requiredQualityGates;
  const excerptLines = options.excerptLines ?? DEFAULT_LOG_EXCERPT_LINES;

  const newResults: QualityGateResult[] = [];
  for (const command of commands) {
    if (signal?.aborted) break;
    const result = await runOne(command, cwd, signal, excerptLines);
    if (routeId) result.routeId = routeId;
    newResults.push(result);
  }

  // Cycle 318.2 Component 3: per-SHA evidence is the canonical path.
  // Read any existing per-SHA file so subsequent route runs accumulate
  // instead of clobbering. Then write both the per-SHA file (canonical)
  // and the legacy `validation.resultFile` (back-compat for 318.2 → 318.4).
  const artifactRoot = await resolveArtifactRoot(loaded);
  const perShaPath = perShaQualityGatePath(
    artifactRoot,
    loaded.config.git.artifactDir,
    commit,
  );
  const existing = readEvidenceAtPath(perShaPath, commit);
  const mergedResults = mergeResults(existing?.results ?? [], newResults);
  const mergedGateResults: Record<string, QualityGateResult> = {
    ...(existing?.gateResults ?? {}),
  };
  if (routeId && newResults.length > 0) {
    // In practice each route ships a single command. If a route does run
    // multiple commands, the LAST result is what gate-push checks — the
    // semantics is "did the route as a whole pass at the boundary?"
    const last = newResults[newResults.length - 1];
    if (last) mergedGateResults[routeId] = last;
  }
  const evidence: QualityGateEvidence = {
    version: 2,
    commit,
    generatedAt: new Date().toISOString(),
    results: mergedResults,
    ...(Object.keys(mergedGateResults).length > 0
      ? { gateResults: mergedGateResults }
      : {}),
  };

  mkdirSync(dirname(perShaPath), { recursive: true });
  writeFileSync(perShaPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  // Back-compat: also write the legacy `validation.resultFile` (latest.json)
  // as a copy of the same evidence. We use a copy rather than a symlink so
  // concurrent gate runs on different commits do not race on symlink
  // rewrites. This stays in place through the 318.2 → 318.4 migration
  // window; consumers should transition to reading the per-SHA path.
  const legacyPath = await resolveValidationResultPath(loaded);
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  return evidence;
}

function mergeResults(
  prior: QualityGateResult[],
  added: QualityGateResult[],
): QualityGateResult[] {
  // Same (routeId, command) tuple: newest wins. Different tuples: append.
  // Without this merge, a route that re-runs the same command on a retry
  // would accumulate stale entries.
  const keyOf = (r: QualityGateResult): string => `${r.routeId ?? ""}::${r.command}`;
  const out = new Map<string, QualityGateResult>();
  for (const r of prior) out.set(keyOf(r), r);
  for (const r of added) out.set(keyOf(r), r);
  return [...out.values()];
}

export interface ReadEvidenceResult {
  evidence: QualityGateEvidence | null;
  path: string;
  stale: boolean;
}

export async function readQualityGateEvidence(
  loaded: LoadedConfig,
  commit: string,
): Promise<ReadEvidenceResult> {
  // Prefer the per-SHA file (cycle 318.2 canonical layout). Fall back to
  // the legacy resultFile if no per-SHA file exists yet — this keeps the
  // read path tolerant of intermediate states during rollout: evidence
  // produced by an older `runQualityGates()` (v1 single latest.json) is
  // still readable, and the staleness check fires correctly when the
  // legacy file points at a different commit.
  const artifactRoot = await resolveArtifactRoot(loaded);
  const perShaPath = perShaQualityGatePath(
    artifactRoot,
    loaded.config.git.artifactDir,
    commit,
  );
  const perSha = readEvidenceAtPath(perShaPath, commit);
  if (perSha) {
    return { evidence: perSha, path: perShaPath, stale: false };
  }

  const legacyPath = await resolveValidationResultPath(loaded);
  if (!existsSync(legacyPath)) {
    return { evidence: null, path: legacyPath, stale: false };
  }
  const legacy = readEvidenceAtPath(legacyPath);
  if (!legacy) return { evidence: null, path: legacyPath, stale: false };
  if (legacy.commit !== commit) {
    return { evidence: legacy, path: legacyPath, stale: true };
  }
  return { evidence: legacy, path: legacyPath, stale: false };
}

function readEvidenceAtPath(
  path: string,
  expectedCommit?: string,
): QualityGateEvidence | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  let evidence: QualityGateEvidence;
  try {
    evidence = parseQualityGateEvidence(parsed);
  } catch {
    return null;
  }
  if (expectedCommit !== undefined && evidence.commit !== expectedCommit) {
    // A per-SHA file whose `commit` field doesn't match its filename is
    // a corrupted artifact; treat as missing so a fresh run rewrites
    // cleanly rather than merging into garbage.
    return null;
  }
  return evidence;
}

interface SplitCommand {
  argv: string[];
}

function splitCommand(command: string): SplitCommand {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("empty command");
  const argv = trimmed.split(/\s+/);
  return { argv };
}

function lastNonEmptyLines(text: string, count: number): string {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= count) return lines.join("\n");
  return lines.slice(lines.length - count).join("\n");
}

function runOne(
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  excerptLines: number,
): Promise<QualityGateResult> {
  const { argv } = splitCommand(command);
  return new Promise<QualityGateResult>((resolvePromise) => {
    const startedAt = new Date();
    const startMs = Date.now();
    const head = argv[0] ?? "";
    const tail = argv.slice(1);
    // Scrub the bootstrap-loaded Doppler vars from the gate subprocess env.
    // `agent-review gates` itself does NOT invoke the Doppler bootstrap —
    // main() scopes the bootstrap to the critic-running commands
    // (`doctor`/`review`/`eval`) so quality-gate subprocesses don't inherit
    // the main-checkout service token. But the tokens can still reach this
    // code path indirectly (e.g., a parent shell that ran one of the
    // critic-running commands earlier, or the `.husky/post-commit` hook's
    // inline parser exporting them before invoking the CLI). Scrub them
    // defensively here so gate subprocesses and their grandchildren never
    // see them regardless of the call path. Gates that genuinely need
    // Doppler should call `doppler -p sage -c dev run -- <cmd>` themselves.
    // (issue #1312)
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of DOPPLER_BOOTSTRAP_ALLOWLIST) {
      delete childEnv[k];
    }
    const child = spawn(head, tail, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal !== undefined ? { signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      const finishedAt = new Date();
      resolvePromise({
        command,
        exitCode: -1,
        durationMs: Date.now() - startMs,
        logExcerpt: `spawn error: ${(err as Error).message}`,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      });
    });
    child.on("close", (code, sig) => {
      const finishedAt = new Date();
      const combined = `${stdout}${stderr}`;
      const excerpt = lastNonEmptyLines(combined, excerptLines);
      resolvePromise({
        command,
        exitCode: code === null ? -1 : code,
        durationMs: Date.now() - startMs,
        logExcerpt: sig ? `${excerpt}\n[killed by signal ${sig}]` : excerpt,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      });
    });
  });
}
