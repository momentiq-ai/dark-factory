// `df objectives` — Objectives authoring commands for verifiable-objectives
// (momentiq-ai/dark-factory#207, objectives Phase 1).
//
// Subcommands:
//   hash    — print the canonical sha256 of a criterion text (for manifest authoring)
//   derive  — generate a .darkfactory/objectives.yaml from cycle-doc exit criteria (Task 5)
//   check   — verify text-hash bindings in an existing manifest (Task 6)
//
// Exit codes: 0 success / 1 semantic failure / 2 usage error.
import { createHash } from "node:crypto";
import { canonicalizeCriterion } from "@momentiq/dark-factory-schemas";

export interface ObjectivesIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

type Subcommand = "hash" | "derive" | "check";

interface HashOptions {
  subcommand: "hash";
  text: string;
}

interface UnknownSubcmd {
  subcommand: undefined;
}

type ParsedOptions = HashOptions | UnknownSubcmd;

export function parseObjectivesArgs(rest: string[]): ParsedOptions | { error: string } {
  const sub = rest[0];
  const subRest = rest.slice(1);

  if (sub === undefined || sub === "") {
    return { subcommand: undefined };
  }

  if (sub === "hash") {
    return parseHashArgs(subRest);
  }

  // derive and check are not yet implemented (Task 5/6)
  if (sub === "derive" || sub === "check") {
    return { error: `${sub} subcommand is not yet implemented in this release.` };
  }

  return { error: `unknown subcommand: ${sub}` };
}

function parseHashArgs(rest: string[]): HashOptions | { error: string } {
  let text: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";

    if (a === "--text") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: "--text requires a value." };
      }
      text = next;
      i++;
      continue;
    }

    if (a.startsWith("--text=")) {
      text = a.slice("--text=".length);
      continue;
    }

    // Flags that are not yet implemented
    if (a === "--locator" || a === "--cycle") {
      return {
        error:
          `${a} is not yet implemented — use --text "<criterion>" to hash a criterion directly.`,
      };
    }

    if (a.startsWith("--locator=") || a.startsWith("--cycle=")) {
      const flag = a.startsWith("--locator=") ? "--locator" : "--cycle";
      return {
        error:
          `${flag} is not yet implemented — use --text "<criterion>" to hash a criterion directly.`,
      };
    }

    return { error: `unknown flag or positional arg: ${a}` };
  }

  if (text === undefined) {
    return { error: "--text is required (e.g. --text \"- **EC1**: Criterion text\")." };
  }

  return { subcommand: "hash", text };
}

const HELP = [
  "df objectives — objectives authoring commands for verifiable-objectives.",
  "",
  "Usage:",
  "  df objectives <subcommand> [flags]",
  "",
  "Subcommands:",
  "  hash     Print the canonical sha256 of a criterion text.",
  "  derive   Generate .darkfactory/objectives.yaml from cycle-doc exit criteria. (coming soon)",
  "  check    Verify text-hash bindings in an existing manifest. (coming soon)",
  "",
  "Flags (hash):",
  "  --text <criterion>  Criterion text to hash (required).",
  "  --help, -h          Show this message.",
  "",
  "Exit codes:",
  "  0  success",
  "  1  semantic failure",
  "  2  usage / flag error",
  "",
].join("\n");

export async function cmdObjectives(
  rest: string[],
  io: ObjectivesIo,
  _deps?: Record<string, unknown>,
): Promise<number> {
  if (rest.includes("--help") || rest.includes("-h")) {
    io.stdout(`${HELP}`);
    return 0;
  }

  const parsed = parseObjectivesArgs(rest);

  if ("error" in parsed) {
    io.stderr(`df objectives: ${parsed.error}\nRun \`df objectives --help\` for usage.\n`);
    return 2;
  }

  if (parsed.subcommand === undefined) {
    io.stdout(`${HELP}`);
    return 2;
  }

  if (parsed.subcommand === "hash") {
    const digest = createHash("sha256").update(canonicalizeCriterion(parsed.text), "utf8").digest("hex");
    io.stdout(digest + "\n");
    return 0;
  }

  // Should not reach here since parseObjectivesArgs handles unknown subcommands
  io.stdout(`${HELP}`);
  return 2;
}
