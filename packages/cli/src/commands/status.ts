// `df status` — terse verdict + per-critic line for a commit.
//
// Sibling of `df show`. Same shared backend (`loadForCommit`); narrower
// output:
//   - `--json` returns the `df_findings` narrowed shape — `{ commit,
//     critics: [{ id, status, verdict?, findings: [{ severity, file?,
//     line?, rule, message }] }] }`. Byte-equivalent with the
//     `df_findings.structuredContent` envelope the MCP tool returns
//     (cycle 5 spec requirement; both routes call
//     `mapArtifactForFindings()` on the SAME `LoadOutcome.artifact`).
//   - non-JSON renders a terse text block (short commit + verdict + one
//     line per critic) — distinct from `df show`'s rich block so the
//     operator UX split between the two subcommands is real.

import {
  loadForCommit,
  mapArtifactForFindings,
  renderTerseStatusText,
} from "../lib/show-status-core.js";

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
  "  --json          Print the df_findings narrowed JSON shape:",
  "                  { commit, critics: [{ id, status, verdict?,",
  "                  findings: [{ severity, file?, line?, rule,",
  "                  message }] }] }. Byte-equivalent with the",
  "                  df_findings MCP tool's structuredContent.",
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
    const findings = mapArtifactForFindings(outcome.artifact);
    io.stdout(`${JSON.stringify(findings, null, 2)}\n`);
    return 0;
  }
  io.stdout(`${renderTerseStatusText(outcome.artifact)}\n`);
  return 0;
}
