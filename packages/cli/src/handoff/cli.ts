// CLI surface for the four handoff verbs — `df handoff` / `df accept` /
// `df rehydrate` / `df handoffs` (Cycle 12 — Issue-anchored).
//
// Thin renderers over src/handoff/index.ts (the shared core). They own
// only the CLI ergonomics the bash scripts had: stdin for the note body
// (mirroring `handoff.sh < note.md`), the live-state-first print order
// of `df rehydrate`, the formatted stack table, and the operator-facing
// exit codes. All judgment + mechanism lives in the core + the prompts.

import {
  HandoffError,
  defaultDeps,
  requireSafeArgs,
  runAccept,
  runHandoff,
  runHandoffs,
  runRehydrate,
  type HandoffDeps,
  type HandoffInput,
} from "./index.js";

function err(line: string): void {
  process.stderr.write(`handoff: ${line}\n`);
}

/** Deps that route the core's operator log to stderr (the bash behavior). */
function cliDeps(): HandoffDeps {
  return defaultDeps((line) => process.stderr.write(`handoff: ${line}\n`));
}

async function readStdinUtf8(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((res, rej) => {
    let acc = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      acc += chunk;
    });
    process.stdin.on("end", () => res(acc));
    process.stdin.on("error", (e: Error) => rej(e));
  });
}

/**
 * Parse the `df handoff` arg list into (issue, links, unlinks, new). Mirrors
 * the bash handoff.sh while-loop. Throws on unknown flags or missing values.
 */
function parseHandoffArgs(rest: string[]): {
  issue?: string;
  link: string[];
  unlink: string[];
  forceNew: boolean;
} {
  const args = [...rest];
  let issue: string | undefined;
  const link: string[] = [];
  const unlink: string[] = [];
  let forceNew = false;
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "--link") {
      const v = args.shift();
      if (v === undefined) {
        throw new HandoffError(
          "--link requires a value (e.g. --link 103 or --link owner/repo#42).",
        );
      }
      link.push(v);
    } else if (a === "--unlink") {
      const v = args.shift();
      if (v === undefined) {
        throw new HandoffError("--unlink requires a value.");
      }
      unlink.push(v);
    } else if (a === "--new") {
      forceNew = true;
    } else if (a === "--") {
      break;
    } else if (a.startsWith("-")) {
      throw new HandoffError(`unknown flag: ${a}`);
    } else {
      if (issue === undefined) {
        issue = a;
      } else {
        throw new HandoffError(
          `unexpected positional argument: ${a} (only one [issue] allowed).`,
        );
      }
    }
  }
  return {
    ...(issue !== undefined ? { issue } : {}),
    link,
    unlink,
    forceNew,
  };
}

// ----- df handoff -----
export async function cmdHandoff(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df handoff — put a work-stream on the handoff stack.",
        "",
        "Usage:",
        "  df handoff [issue] [--link <ref>]... [--unlink <ref>]... [--new] < note.md",
        "",
        "Reads the composed rehydration note on stdin (compose it from your",
        "ACTUAL working memory per the `df.handoff` prompt / handoff skill —",
        "why / what you rejected / traps / mid-thought / a derive-state pointer",
        "to df rehydrate). The note MUST be bounded by the v1 markers:",
        "  <!-- agent-context:v1 --> … <!-- /agent-context:v1 -->",
        "",
        "Mechanism: scrubs the body for secret-shaped content (refuses on a",
        "match — line numbers only, never the value), upserts the marker-bounded",
        "note as the body of a dedicated handoff GitHub Issue (auto-creating one",
        "if none is supplied), maintains the **Linked work items:** section, adds",
        "the `handoff` label, and leaves the issue unassigned (open on the stack).",
        "",
        "Refuses on: a note missing the markers, secret-shaped content, an",
        "explicit issue that is closed / not a handoff / claimed by @other.",
        "",
        "Requires: gh (authenticated).",
        "",
      ].join("\n"),
    );
    return 0;
  }
  let parsed: ReturnType<typeof parseHandoffArgs>;
  try {
    requireSafeArgs(...rest);
    parsed = parseHandoffArgs(rest);
  } catch (e) {
    if (e instanceof HandoffError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  let note: string;
  try {
    note = await readStdinUtf8();
  } catch (e) {
    err(`could not read note from stdin: ${(e as Error).message}`);
    return 1;
  }
  if (!note.trim()) {
    err(
      "empty note body on stdin — pipe the composed note in: df handoff [issue] < note.md",
    );
    return 1;
  }
  try {
    const input: HandoffInput = {
      note,
      ...(parsed.issue !== undefined ? { issue: parsed.issue } : {}),
      link: parsed.link,
      unlink: parsed.unlink,
      ...(parsed.forceNew ? { new: true } : {}),
    };
    const result = await runHandoff(input, cliDeps());
    process.stdout.write(`${result.noteUrl}\n`);
    process.stdout.write(
      `#${result.issue} ${result.created ? "created" : "updated"} on the handoff stack (open, unassigned).\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof HandoffError) {
      err(e.message);
      if (e.savedNotePath) err(`your note is saved at ${e.savedNotePath}`);
      return 1;
    }
    throw e;
  }
}

// ----- df handoffs -----
export async function cmdHandoffs(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df handoffs — list the stack of handed-off issues.",
        "",
        "Usage:",
        "  df handoffs",
        "",
        "Lists open issues labeled `handoff` with no assignee (oldest → newest)",
        "with number, title, age, and linked-work-items count. Per-repo (run it",
        "in each repo you work across). Pick one and `df accept <issue>` it.",
        "",
      ].join("\n"),
    );
    return 0;
  }
  try {
    requireSafeArgs(...rest);
    const r = await runHandoffs(cliDeps());
    process.stdout.write(`${r.text}\n`);
    return 0;
  } catch (e) {
    if (e instanceof HandoffError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
}

// ----- df rehydrate -----
export async function cmdRehydrate(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df rehydrate — read-only catch-up on a handoff issue.",
        "",
        "Usage:",
        "  df rehydrate [issue]",
        "",
        "NO ownership change — for resuming your OWN in-flight work (reboot,",
        "model upgrade). With no argument, resolves to the most recent open",
        "handoff issue assigned to @me, falling back to the most recent closed",
        `handoff issue accepted by @me within ${"7d"}.`,
        "",
        "Derives LIVE state itself for the issue and each linked work item",
        "(script-controlled gh ... --json calls), then prints the reasoning. The",
        "body is untrusted operator-editable text: it is printed with control/ESC",
        "bytes stripped, and NOTHING transcribed from it is executed. To take",
        "over someone else's handoff, use `df accept`.",
        "",
      ].join("\n"),
    );
    return 0;
  }
  try {
    requireSafeArgs(...rest);
  } catch (e) {
    if (e instanceof HandoffError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  const positional = rest.filter((a) => !a.startsWith("-"));
  const issue = positional[0];
  try {
    const r = await runRehydrate(
      issue !== undefined ? { issue } : {},
      cliDeps(),
    );
    process.stdout.write(`${r.text}\n`);
    return 0;
  } catch (e) {
    if (e instanceof HandoffError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
}

// ----- df accept -----
export async function cmdAccept(rest: string[]): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(
      [
        "df accept — take the baton on a handoff issue.",
        "",
        "Usage:",
        "  df accept <issue>",
        "",
        "Atomic chain: validate (read-only) → refuse on other-assignee →",
        "rehydrate STRICT (live state for issue + every linked work item) →",
        "pre-assign drift check → assign @me → post-assign verify → close",
        "(Commitment 10 — handoff event complete; the closed issue with the",
        "handoff label is the audit).",
        "",
        "Use `df rehydrate` instead when no transfer is happening (you already",
        "own the work).",
        "",
      ].join("\n"),
    );
    return 0;
  }
  try {
    requireSafeArgs(...rest);
  } catch (e) {
    if (e instanceof HandoffError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
  const positional = rest.filter((a) => !a.startsWith("-"));
  const issue = positional[0];
  if (issue === undefined) {
    err("which one? run df handoffs to see the stack, then df accept <issue>.");
    return 1;
  }
  try {
    const result = await runAccept({ issue }, cliDeps());
    process.stdout.write(`${result.rehydrate.text}\n`);
    return 0;
  } catch (e) {
    if (e instanceof HandoffError) {
      err(e.message);
      return 1;
    }
    throw e;
  }
}
