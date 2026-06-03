// `df findings` — audit-inspect per-commit critic findings without re-gating.
//
// Companion to `df show` / `df status`: those subcommands answer the
// operator question "what did the local critic say about THIS commit?"
// (single commit), while `df findings --range BASE..HEAD` answers "what
// did the local critic say about EACH commit in this range?" — surfacing
// the iteration-receipt artifacts that the new (Cycle 13) final-commit-
// only `df gate-push` semantic intentionally does NOT gate.
//
// Why this exists:
//
//   The Cycle 13 find-fix-new-commit pattern produces a final commit
//   whose diff represents the cumulative resolved state of an iteration
//   trail. `df gate-push` (default mode) gates ONLY that final commit's
//   verdict — the intermediate commits' artifacts (still on disk under
//   `.git/agent-reviews/<sha>.json`) are *iteration receipts*, not gate
//   states. Operators / auditors who want to inspect those receipts
//   without re-gating use `df findings --range <base>..<head>`.
//
// Output:
//
//   - Default text: one line per commit in the range — short SHA, the
//     critic verdict (or "(no artifact)" if review never ran), per-
//     critic finding counts.
//   - `--json`: an array of `{ commit, critics }` records matching the
//     `df_findings` narrowed shape, so the output composes cleanly with
//     `jq`. Commits with no artifact appear as `{ commit, error }`
//     entries so downstream tooling can see the gap explicitly.
//
// This is OPT-IN audit tooling, NOT a gate. Exit codes:
//   - 0 on success (even if some intermediate artifacts are missing).
//   - 1 on git/range parse failure or config load failure.
//   - 2 on usage error.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  loadForCommit,
  mapArtifactForFindings,
  type DfFindingsResult,
} from "../lib/show-status-core.js";
import { loadAgentReviewConfig } from "../policy/config.js";

const runFile = promisify(execFile);

export interface FindingsIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

interface FindingsOptions {
  range: string;
  cwd: string;
  json: boolean;
}

const HELP = [
  "df findings — audit-inspect per-commit critic findings without re-gating.",
  "",
  "Usage:",
  "  df findings --range <base>..<head> [--json]",
  "",
  "Reads the per-commit `.git/agent-reviews/<sha>.json` artifacts written",
  "by `df review` for every commit in the range. Does NOT re-run critics.",
  "Does NOT influence the gate. Pure audit-mode inspection of the iteration-",
  "receipt artifacts that the default (Cycle 13) final-commit-only `df gate-",
  "push` semantic intentionally leaves un-gated.",
  "",
  "Flags:",
  "  --range <rev-range>  Git revision range (e.g. origin/main..HEAD,",
  "                       <sha>..<sha>). Anything `git rev-list` accepts.",
  "                       Required.",
  "  --json               Print a JSON array of df_findings-shaped records",
  "                       (one per commit in the range). Commits without",
  "                       an artifact appear as { commit, error } entries.",
  "  --help, -h           Show this message.",
  "",
  "Exit codes:",
  "  0  success (even if some intermediate commits have no artifact)",
  "  1  git/range parse failure or config load failure",
  "  2  usage error",
  "",
].join("\n");

function parseArgs(rest: string[]): FindingsOptions | { error: string } {
  let range: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--range") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: "--range requires a value (e.g. --range origin/main..HEAD)." };
      }
      range = next;
      i++;
      continue;
    }
    if (a.startsWith("--range=")) {
      range = a.slice("--range=".length);
      continue;
    }
    return { error: `unknown flag or positional arg: ${a}` };
  }
  if (range === undefined || range === "") {
    return { error: "--range <rev-range> is required (e.g. --range origin/main..HEAD)." };
  }
  return { range, json, cwd: process.cwd() };
}

async function commitsInRange(range: string, cwd: string): Promise<string[]> {
  try {
    const { stdout } = await runFile(
      "git",
      ["rev-list", "--reverse", range],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const detail = e.stderr ? `: ${e.stderr.trim()}` : "";
    throw new Error(`git rev-list ${range} failed${detail}`);
  }
}

interface FindingsRecord {
  readonly commit: string;
  readonly result?: DfFindingsResult;
  readonly error?: string;
}

function renderRecordText(record: FindingsRecord): string {
  const shortSha = record.commit.slice(0, 12);
  if (record.error) {
    return `${shortSha}  (no artifact) — ${record.error}`;
  }
  const result = record.result;
  if (!result) {
    return `${shortSha}  (no artifact)`;
  }
  const totalFindings = result.critics.reduce(
    (n, c) => n + c.findings.length,
    0,
  );
  const verdictParts = result.critics.map((c) => c.verdict ?? c.status);
  const verdictSummary = verdictParts.length > 0 ? verdictParts.join(",") : "(no critics)";
  return `${shortSha}  ${verdictSummary} — findings=${totalFindings}`;
}

interface JsonRecord {
  readonly commit: string;
  readonly critics?: DfFindingsResult["critics"];
  readonly error?: string;
}

function recordToJson(record: FindingsRecord): JsonRecord {
  if (record.result) {
    return { commit: record.result.commit, critics: record.result.critics };
  }
  return {
    commit: record.commit,
    error: record.error ?? "no review artifact",
  };
}

export async function cmdFindings(rest: string[], io: FindingsIo): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(HELP);
    return 0;
  }
  const parsed = parseArgs(rest);
  if ("error" in parsed) {
    io.stderr(`df findings: ${parsed.error}\nRun \`df findings --help\` for usage.\n`);
    return 2;
  }
  // Preload the agent-review config once before the per-commit walk. A
  // missing/invalid `.agent-review/config.json` is a config-level failure
  // that the help text promises (exit 1 / stderr), not a per-commit
  // artifact gap. Loading inside `loadForCommit` for each iteration would
  // re-surface the same error N times as "(no artifact)" lines, masking
  // the real cause and returning exit 0. Fail fast here so automation
  // can distinguish "broken config" from "missing intermediate receipt".
  try {
    await loadAgentReviewConfig({ cwd: parsed.cwd });
  } catch (err) {
    io.stderr(`df findings: failed to load .agent-review/config.json: ${(err as Error).message}\n`);
    return 1;
  }
  let commits: string[];
  try {
    commits = await commitsInRange(parsed.range, parsed.cwd);
  } catch (err) {
    io.stderr(`df findings: ${(err as Error).message}\n`);
    return 1;
  }
  if (commits.length === 0) {
    if (parsed.json) {
      io.stdout("[]\n");
    } else {
      io.stdout(`df findings: range ${parsed.range} has 0 commit(s).\n`);
    }
    return 0;
  }

  const records: FindingsRecord[] = [];
  for (const sha of commits) {
    const outcome = await loadForCommit(parsed.cwd, sha);
    if (outcome.artifact) {
      records.push({ commit: sha, result: mapArtifactForFindings(outcome.artifact) });
    } else {
      records.push({
        commit: sha,
        error: outcome.error ?? "no review artifact",
      });
    }
  }

  if (parsed.json) {
    io.stdout(`${JSON.stringify(records.map(recordToJson), null, 2)}\n`);
    return 0;
  }
  io.stdout(`df findings: ${commits.length} commit(s) in ${parsed.range}\n`);
  for (const r of records) {
    io.stdout(`${renderRecordText(r)}\n`);
  }
  return 0;
}
