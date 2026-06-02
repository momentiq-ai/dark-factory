// `df status` — terse verdict + per-critic line for a commit.
//
// Sibling of `df show`. Same shared backend (`loadForCommit`); narrower
// output: one block of verdict + critic statuses, no full artifact.
// `--json` returns the narrowed shape (commit + verdict + critics with
// id/status/verdict/findingCount) — useful for shell pipelines that
// want to gate on the verdict without re-parsing the full ReviewArtifact.

import { loadForCommit, renderStatusText } from "./show-status-core.js";

export interface StatusIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

interface StatusOptions {
  commit: string;
  cwd: string;
  json: boolean;
}

const HELP = [
  "df status — terse verdict + per-critic status for a commit.",
  "",
  "Usage:",
  "  df status [--commit <ref>] [--json]",
  "",
  "Flags:",
  "  --commit <ref>  Commit ref (default HEAD).",
  "  --json          Print narrowed JSON: { commit, status, verdict, critics }.",
  "  --help, -h      Show this message.",
  "",
  "Exit codes:",
  "  0  success",
  "  1  no artifact found / config load failed / git rev-parse failed",
  "  2  usage error",
  "",
].join("\n");

function parseStatusArgs(rest: string[]): StatusOptions | { error: string } {
  let commit = "HEAD";
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--commit") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: "--commit requires a value (e.g. --commit HEAD)." };
      }
      commit = next;
      i++;
      continue;
    }
    if (a.startsWith("--commit=")) {
      commit = a.slice("--commit=".length);
      continue;
    }
    return { error: `unknown flag or positional arg: ${a}` };
  }
  return { commit, json, cwd: process.cwd() };
}

export async function cmdStatus(rest: string[], io: StatusIo): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(HELP);
    return 0;
  }
  const parsed = parseStatusArgs(rest);
  if ("error" in parsed) {
    io.stderr(`df status: ${parsed.error}\nRun \`df status --help\` for usage.\n`);
    return 2;
  }
  const outcome = await loadForCommit(parsed.cwd, parsed.commit);
  if (!outcome.artifact) {
    io.stderr(`df status: ${outcome.error ?? "no artifact"}\n`);
    return 1;
  }
  if (parsed.json) {
    const narrowed = {
      commit: outcome.artifact.commit,
      status: outcome.artifact.status,
      verdict: outcome.artifact.gateVerdict ?? null,
      critics: outcome.artifact.criticResults.map((r) => ({
        id: r.criticId,
        status: r.status,
        verdict: r.verdict ?? null,
        findings: r.findings.length,
      })),
    };
    io.stdout(`${JSON.stringify(narrowed, null, 2)}\n`);
    return 0;
  }
  io.stdout(`${renderStatusText(outcome.artifact)}\n`);
  return 0;
}
