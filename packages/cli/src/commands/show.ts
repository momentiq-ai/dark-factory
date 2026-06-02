// `df show` — render the per-commit review artifact.
//
// CLI mirror of the `df_show_run` MCP tool. Both surfaces read the
// same `.git/agent-reviews/<sha>.json` artifact via the shared
// `loadForCommit` loader; with `--json`, this prints the exact same
// `{ artifact: <ReviewArtifact> }` envelope the MCP tool returns as
// `structuredContent` (cycle 5 spec byte-equivalence requirement).
//
// Default output is human-readable; `--json` is the structured form.

import {
  loadForCommit,
  renderStatusText,
  showRunStructured,
} from "../lib/show-status-core.js";

export interface ShowIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface ShowOptions {
  commit: string;
  cwd: string;
  json: boolean;
}

const HELP = [
  "df show — render the per-commit review artifact (CLI mirror of df_show_run).",
  "",
  "Usage:",
  "  df show [--commit <ref>] [--json]",
  "",
  "Flags:",
  "  --commit <ref>  Commit ref (anything `git rev-parse` accepts; default HEAD)",
  "  --json          Print the structured artifact JSON instead of the text view.",
  "                  Output shape is { artifact: <ReviewArtifact> } — byte-",
  "                  equivalent with the df_show_run MCP tool's structuredContent.",
  "  --help, -h      Show this message.",
  "",
  "Exit codes:",
  "  0  success",
  "  1  no artifact found / config load failed / git rev-parse failed",
  "  2  usage error",
  "",
].join("\n");

function parseShowArgs(rest: string[]): ShowOptions | { error: string } {
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

export async function cmdShow(rest: string[], io: ShowIo): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(HELP);
    return 0;
  }
  const parsed = parseShowArgs(rest);
  if ("error" in parsed) {
    io.stderr(`df show: ${parsed.error}\nRun \`df show --help\` for usage.\n`);
    return 2;
  }
  const outcome = await loadForCommit(parsed.cwd, parsed.commit);
  if (!outcome.artifact) {
    io.stderr(`df show: ${outcome.error ?? "no artifact"}\n`);
    return 1;
  }
  if (parsed.json) {
    io.stdout(`${JSON.stringify(showRunStructured(outcome.artifact), null, 2)}\n`);
    return 0;
  }
  io.stdout(`${renderStatusText(outcome.artifact)}\n`);
  return 0;
}
