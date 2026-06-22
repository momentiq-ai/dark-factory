// `df prove` — Cycle 331.1 verifiable-objectives (momentiq-ai/dark-factory#207).
// The closeout proof readout: join the declared objectives
// (`.darkfactory/objectives.yaml`) against local evidence and print, per
// objective, whether it is proven / pending / failed — so the agent's final turn
// is "declare victory with proof", not "done".
//
// Exit codes encode the link-now-ratchet-later contract:
//   0  informational (default): the readout is printed; pending/failed never
//      fail the command while objectives are `enforced: false`.
//   1  an ENFORCED objective (or any objective under --strict) is not proven.
//   2  usage / flag error.
//
// Trust boundary: agent-attested, evidence-backed — stronger than free-text
// "done" (statuses are derived from diffHash-bound artifacts) but NOT independent
// verification (the agent authored both the code and the objectives).
import {
  buildProofRecord,
  collectProofInputs,
  type CollectedProofInputs,
} from "../evidence/prove.js";
import type { BoundProofRecord, ObjectiveProof, ProofStatus } from "@momentiq/dark-factory-schemas";

export interface ProveIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

// Injection seams for tests (real collector + wall clock by default).
export interface ProveDeps {
  collect?: (cwd: string, commit: string) => Promise<CollectedProofInputs | null>;
  now?: () => string;
}

interface ProveOptions {
  commit: string;
  cwd: string;
  json: boolean;
  strict: boolean;
}

const HELP = [
  "df prove — closeout proof readout: which objectives are proven by their evidence.",
  "",
  "Usage:",
  "  df prove [--commit <ref>] [--cwd <path>] [--json] [--strict]",
  "",
  "Reads `.darkfactory/objectives.yaml` and joins each objective's `attestedBy`",
  "bindings against local evidence — route exit codes (`df verify`) and critic",
  "verdicts (`df review`) — resolving every binding to proven / pending / failed.",
  "A `pending` binding is awaiting evidence (e.g. the critic fleet has not run on",
  "HEAD yet), distinct from a `failed` one (evidence is negative).",
  "",
  "This readout is agent-attested, evidence-backed: stronger than free-text",
  '"done" (each status is derived from diffHash-bound artifacts), but not',
  "independent verification.",
  "",
  "Flags:",
  "  --commit <ref>  Commit ref (anything `git rev-parse` accepts; default HEAD).",
  "  --cwd <path>    Repository root to operate in (default: process cwd).",
  "  --json          Emit the BoundProofRecord as JSON (default: human readout).",
  "  --strict        Treat every objective as enforced (exit 1 if any not proven).",
  "  --help, -h      Show this message.",
  "",
  "Exit codes:",
  "  0  readout printed (informational — pending/failed do not fail the command",
  "     while objectives are `enforced: false`), or no objectives declared",
  "  1  an enforced objective (or any objective under --strict) is not proven",
  "  2  usage / flag error",
  "",
].join("\n");

function parseProveArgs(rest: string[]): ProveOptions | { error: string } {
  let commit = "HEAD";
  let cwd = process.cwd();
  let json = false;
  let strict = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--strict") {
      strict = true;
      continue;
    }
    if (a === "--commit" || a === "--cwd") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: `${a} requires a value.` };
      }
      if (a === "--commit") commit = next;
      else cwd = next;
      i++;
      continue;
    }
    if (a.startsWith("--commit=")) {
      commit = a.slice("--commit=".length);
      continue;
    }
    if (a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
      continue;
    }
    return { error: `unknown flag or positional arg: ${a}` };
  }
  return { commit, cwd, json, strict };
}

const GLYPH: Record<ProofStatus, string> = { proven: "✓", pending: "…", failed: "✗" };

function renderObjective(o: ObjectiveProof): string {
  const lines: string[] = [];
  const tag = o.enforced ? " [enforced]" : "";
  // 2c: show source grounding when not the agent-asserted default.
  const src = o.sourceVerification === "agent-asserted" ? "" : ` {${o.sourceVerification}}`;
  lines.push(`  ${GLYPH[o.status]} ${o.status.padEnd(7)} ${o.id}${tag}${src}  ${o.text}`);
  for (const b of o.bindings) {
    const ptr = b.uploadId ? ` (cerebe:${b.uploadId})` : "";
    lines.push(`      ${b.kind}[${b.ref}] ${b.status} — ${b.detail}${ptr}`);
  }
  if (o.bindings.length === 0) {
    lines.push("      (no evidence bindings declared)");
  }
  return lines.join("\n");
}

function renderProofText(record: BoundProofRecord): string {
  const short = record.commit.slice(0, 12);
  const lines: string[] = [];
  lines.push(`df prove — objective proof readout for ${short}`);
  lines.push("");
  for (const o of record.objectives) lines.push(renderObjective(o));
  lines.push("");
  const s = record.summary;
  const bind = record.diffHash ? `  ·  diff ${record.diffHash.slice(0, 16)}…` : "";
  lines.push(
    `Summary: ${s.proven} proven · ${s.pending} pending · ${s.failed} failed (${s.total} total)${bind}`,
  );
  return lines.join("\n");
}

// Objectives that gate the exit code: all of them under --strict, else the ones
// marked `enforced: true`.
function gatingObjectives(record: BoundProofRecord, strict: boolean): ObjectiveProof[] {
  return record.objectives.filter((o) => strict || o.enforced);
}

export async function cmdProve(
  rest: string[],
  io: ProveIo,
  deps: ProveDeps = {},
): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(`${HELP}`);
    return 0;
  }
  const parsed = parseProveArgs(rest);
  if ("error" in parsed) {
    io.stderr(`df prove: ${parsed.error}\nRun \`df prove --help\` for usage.\n`);
    return 2;
  }

  const collect = deps.collect ?? collectProofInputs;
  const now = deps.now ?? (() => new Date().toISOString());

  let collected: CollectedProofInputs | null;
  try {
    collected = await collect(parsed.cwd, parsed.commit);
  } catch (err) {
    io.stderr(`df prove: ${(err as Error).message}\n`);
    return 1;
  }
  if (collected === null) {
    io.stdout("df prove: no objectives declared (.darkfactory/objectives.yaml absent) — nothing to prove.\n");
    return 0;
  }

  const record = buildProofRecord(collected.inputs, now());
  const enforcing = parsed.strict || record.objectives.some((o) => o.enforced);

  if (parsed.json) {
    io.stdout(`${JSON.stringify(record, null, 2)}\n`);
  } else {
    io.stdout(`${renderProofText(record)}\n`);
  }

  // Exit-code gate (the ratchet). Informational by default; enforced/strict bites.
  const gating = gatingObjectives(record, parsed.strict);
  const unproven = gating.filter((o) => o.status !== "proven");
  if (unproven.length > 0) {
    io.stderr(
      `df prove: ${unproven.length} ${parsed.strict ? "" : "enforced "}objective(s) not proven: ${unproven
        .map((o) => `${o.id} (${o.status})`)
        .join(", ")}.\n`,
    );
    return 1;
  }
  if (!parsed.json) {
    const scope = enforcing ? (parsed.strict ? "all objectives" : "enforced objectives") : "informational";
    io.stderr(
      enforcing
        ? `df prove: ${scope} proven.\n`
        : "df prove: informational — the enforced ratchet is off; pending/failed do not block.\n",
    );
  }
  return 0;
}
