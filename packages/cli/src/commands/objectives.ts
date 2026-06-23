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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  canonicalizeCriterion,
  parseObjectivesManifest,
  SOURCE_LOCATOR_RE,
  type Objective,
  type ObjectivesManifest,
} from "@momentiq/dark-factory-schemas";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import { readCycleDoc } from "../mcp/cycle-doc/parser.js";

export interface ObjectivesIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

// Injectable dependencies (test seam — mirrors prove.ts's ProveDeps). The
// derive handler resolves the cycle doc via `readCycleDoc` against `cwd`; tests
// drive it through a real fixture repo so the parser + filesystem path stay
// exercised end-to-end, but an override keeps unit isolation cheap when needed.
export interface ObjectivesDeps {
  readCycleDoc?: typeof readCycleDoc;
}

interface HashOptions {
  subcommand: "hash";
  text: string;
}

interface DeriveOptions {
  subcommand: "derive";
  cycle: string;
  apply: boolean;
  json: boolean;
  cwd: string;
}

interface CheckOptions {
  subcommand: "check";
  json: boolean;
  cwd: string;
}

interface UnknownSubcmd {
  subcommand: undefined;
}

type ParsedOptions = HashOptions | DeriveOptions | CheckOptions | UnknownSubcmd;

export function parseObjectivesArgs(rest: string[]): ParsedOptions | { error: string } {
  const sub = rest[0];
  const subRest = rest.slice(1);

  if (sub === undefined || sub === "") {
    return { subcommand: undefined };
  }

  if (sub === "hash") {
    return parseHashArgs(subRest);
  }

  if (sub === "derive") {
    return parseDeriveArgs(subRest);
  }

  if (sub === "check") {
    return parseCheckArgs(subRest);
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

function parseDeriveArgs(rest: string[]): DeriveOptions | { error: string } {
  let cycle: string | undefined;
  let apply = false;
  let json = false;
  let cwd = process.cwd();

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";

    if (a === "--cycle") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: "--cycle requires a value (e.g. --cycle 23)." };
      }
      cycle = next;
      i++;
      continue;
    }
    if (a.startsWith("--cycle=")) {
      cycle = a.slice("--cycle=".length);
      continue;
    }

    if (a === "--cwd") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: "--cwd requires a value." };
      }
      cwd = next;
      i++;
      continue;
    }
    if (a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
      continue;
    }

    if (a === "--apply") {
      apply = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }

    return { error: `unknown flag or positional arg: ${a}` };
  }

  if (cycle === undefined || cycle === "") {
    return { error: "--cycle is required (e.g. --cycle 23)." };
  }

  // Normalize a `cycle23` / `cycle 23` style value down to the bare number the
  // id + source.ref use (`cycle<N>#ec<k>`, `{kind:"cycle", ref:"<N>"}`). The
  // cycle-doc parser keys on the `cycle<N>` id form, so we rebuild that below.
  const ref = cycle.replace(/^cycle/i, "").trim();
  if (ref === "" || !/^\d+(?:\.\d+)*$/.test(ref)) {
    return { error: `--cycle must be a cycle number (e.g. 23 or cycle23), got ${JSON.stringify(cycle)}.` };
  }

  return { subcommand: "derive", cycle: ref, apply, json, cwd };
}

function parseCheckArgs(rest: string[]): CheckOptions | { error: string } {
  let json = false;
  let cwd = process.cwd();

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";

    if (a === "--cwd") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: "--cwd requires a value." };
      }
      cwd = next;
      i++;
      continue;
    }
    if (a.startsWith("--cwd=")) {
      cwd = a.slice("--cwd=".length);
      continue;
    }

    if (a === "--json") {
      json = true;
      continue;
    }

    return { error: `unknown flag or positional arg: ${a}` };
  }

  return { subcommand: "check", json, cwd };
}

// ---------------------------------------------------------------------------
// Exit-criteria extraction — the hash-consistency core.
//
// This MUST enumerate list items and assign criterion ids IDENTICALLY to the
// Python gate validator's resolver (`validate_cycle_doc.py` `_list_items` +
// `_find_criterion`), or a derived manifest's text-hash sha256 will not match
// what the validator recomputes and every objective fails the gate.
//
//   - Item enumeration mirrors `_list_items`: a line is an item iff it matches
//     `^\s*(?:[-*+]|\d+[.)])\s+` (dash/star/plus or `N.`/`N)` markers).
//   - Id assignment mirrors `_find_criterion`'s resolution, inverted: the
//     validator resolves `ec<k>` by (1) an explicit `EC<k>` label match, else
//     (2) positional (`ec<N>` → Nth item). So we read each item's OWN `EC<k>`
//     label (the validator's label regex, constrained to the `EC<digits>`
//     exit-criterion convention so every id stays valid per OBJECTIVE_ID_RE);
//     when no `EC<k>` label is present we fall back to positional `ec<index>`.
//     Round-tripping is verified: `_find_criterion(section, <our id>)` returns
//     the exact line we hashed, across in-order / out-of-order / mixed / plain
//     / numbered docs (see the unit tests).
//
// The sha256 we emit is `sha256(canonicalizeCriterion(<raw item line>))` — the
// FULL raw line, exactly the `ctext` the validator feeds to
// `canonicalize_criterion`. `canonicalizeCriterion` (the shared schema mirror)
// strips the marker + label + emphasis itself, so feeding the raw line is what
// keeps the two sides byte-identical.
// ---------------------------------------------------------------------------

// Mirror of the validator's `_list_items` item-detection regex.
const ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

// Mirror of the validator's `_find_criterion` label regex, constrained to the
// `EC<digits>` exit-criterion convention and capturing the number. Requires a
// trailing separator `[:.)–—-]` exactly like the validator (so a bare
// "`EC1` foo" with no separator correctly falls through to positional, matching
// the validator's resolution).
const EC_LABEL_RE = /^\s*(?:[-*+]|\d+[.)])\s*\*{0,2}EC(\d+)\*{0,2}\s*[:.)–—-]/i;

// Display-text derivation: strip the list marker, then a leading `EC<k>` token
// (bold/backtick-wrapped, with or without a separator), then residual emphasis,
// and fold whitespace. This is the human-facing `text` field only — it is NOT
// the hash input (the hash uses `canonicalizeCriterion(<raw line>)`), so its
// exact shape carries no cross-impl contract; it just reads cleanly.
function criterionDisplayText(rawLine: string): string {
  let s = rawLine.normalize("NFC");
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""); // list marker
  s = s.replace(/^\s*[`*]{0,2}EC\d+[`*]{0,2}\s*(?:[:.)–—-]\s+)?/i, ""); // EC<k> label token
  s = s.replace(/[*`]/g, ""); // residual emphasis / code ticks
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export interface ExtractedCriterion {
  /** Criterion id (`ec<k>`) — the validator-compatible locator suffix. */
  id: string;
  /** Human-facing display text (label + emphasis stripped). */
  text: string;
  /** The verbatim source line — the canonical hash input. */
  raw: string;
}

/**
 * Enumerate a `## Exit criteria` section body's items and assign each a
 * validator-compatible criterion id. See the block comment above for the
 * cross-impl-consistency contract this upholds.
 */
export function extractExitCriteria(sectionBody: string): ExtractedCriterion[] {
  const out: ExtractedCriterion[] = [];
  const lines = sectionBody.split(/\r?\n/);
  const items = lines.filter((ln) => ITEM_RE.test(ln));
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] ?? "";
    const labelMatch = EC_LABEL_RE.exec(raw);
    const id = labelMatch ? `ec${parseInt(labelMatch[1] ?? "", 10)}` : `ec${i + 1}`;
    out.push({ id, text: criterionDisplayText(raw), raw });
  }
  return out;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const MANIFEST_RELATIVE_PATH = join(".darkfactory", "objectives.yaml");

const HELP = [
  "df objectives — objectives authoring commands for verifiable-objectives.",
  "",
  "Usage:",
  "  df objectives <subcommand> [flags]",
  "",
  "Subcommands:",
  "  hash     Print the canonical sha256 of a criterion text.",
  "  derive   Generate .darkfactory/objectives.yaml from cycle-doc exit criteria.",
  "  check    Verify text-hash bindings in an existing manifest.",
  "",
  "Flags (hash):",
  "  --text <criterion>  Criterion text to hash (required).",
  "",
  "Flags (derive):",
  "  --cycle <N>         Cycle number whose Exit criteria to derive from (required).",
  "  --apply             Write .darkfactory/objectives.yaml (default: print to stdout).",
  "  --cwd <path>        Repository root to operate in (default: process cwd).",
  "  --json              Emit the manifest object as JSON instead of YAML.",
  "",
  "Flags (check):",
  "  --cwd <path>        Repository root containing .darkfactory/objectives.yaml (default: process cwd).",
  "  --json              Emit a structured JSON result.",
  "",
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
  deps: ObjectivesDeps = {},
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

  if (parsed.subcommand === "derive") {
    return cmdDerive(parsed, io, deps);
  }

  if (parsed.subcommand === "check") {
    return cmdCheck(parsed, io, deps);
  }

  // Should not reach here since parseObjectivesArgs handles unknown subcommands
  io.stdout(`${HELP}`);
  return 2;
}

async function cmdDerive(
  opts: DeriveOptions,
  io: ObjectivesIo,
  deps: ObjectivesDeps,
): Promise<number> {
  const read = deps.readCycleDoc ?? readCycleDoc;
  const cycleDocId = `cycle${opts.cycle}`;

  const doc = await read(opts.cwd, cycleDocId);
  if (doc === null) {
    io.stderr(
      `df objectives derive: cycle doc ${cycleDocId} not found under ` +
        `${join(opts.cwd, "docs/roadmap/cycles")} — nothing to derive.\n`,
    );
    return 1;
  }

  const section = doc.sections["exit_criteria"];
  if (section === undefined || section.trim() === "") {
    io.stderr(
      `df objectives derive: cycle doc ${cycleDocId} has no '## Exit criteria' section ` +
        "(or it is empty) — nothing to derive.\n",
    );
    return 1;
  }

  const criteria = extractExitCriteria(section);
  if (criteria.length === 0) {
    io.stderr(
      `df objectives derive: cycle doc ${cycleDocId} '## Exit criteria' section has no ` +
        "list items — nothing to derive.\n",
    );
    return 1;
  }

  // Duplicate-id guard: a cycle doc with two identically-labeled EC items
  // (e.g. two `**EC1**` entries) produces criteria with the same id, which
  // causes cmdCheck to silently verify the duplicate against the first entry.
  // Emit a clear warning — still produce output (the authoring error is in the
  // cycle doc, not here), but make it visible.
  const seenIds = new Set<string>();
  for (const c of criteria) {
    const fullId = `${cycleDocId}#${c.id}`;
    if (seenIds.has(fullId)) {
      io.stderr(
        `df objectives derive: warning — duplicate criterion id ${fullId} detected in ` +
          `${cycleDocId} exit criteria; the second item will be inaccessible via check/gate. ` +
          `Fix the cycle doc to use unique EC labels.\n`,
      );
    }
    seenIds.add(fullId);
  }

  // Idempotence: preserve hand-edited `attestedBy` bindings from an existing
  // manifest by objective id. Re-running refreshes text/hash + reconciles
  // added/removed criteria, but never clobbers bindings the agent authored.
  const manifestPath = resolve(opts.cwd, MANIFEST_RELATIVE_PATH);
  const preservedBindings = loadPreservedBindings(manifestPath, io);

  const objectives: Objective[] = criteria.map((c) => {
    const id = `${cycleDocId}#${c.id}`;
    const locator = `exit_criteria#${c.id}`;
    // Defensive: the locator is built from `exit_criteria` + an `ec<k>` id, both
    // of which satisfy SOURCE_LOCATOR_RE by construction — assert it so a future
    // id-scheme change can't silently emit an unparseable locator.
    if (!SOURCE_LOCATOR_RE.test(locator)) {
      throw new Error(`internal: derived locator ${JSON.stringify(locator)} is malformed`);
    }
    const sha256 = sha256Hex(canonicalizeCriterion(c.raw));
    return {
      id,
      source: { kind: "cycle", ref: opts.cycle },
      text: c.text,
      attestedBy: preservedBindings.get(id) ?? [],
      enforced: false,
      sourceCriterion: { kind: "text-hash", locator, sha256 },
    };
  });

  const manifest: ObjectivesManifest = { schemaVersion: 1, objectives };

  // Validate our own output against the schema parser — a derived manifest that
  // can't round-trip is a bug, surfaced loudly here rather than at gate time.
  try {
    parseObjectivesManifest(manifest);
  } catch (err) {
    io.stderr(
      `df objectives derive: internal error — derived manifest failed schema validation: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  if (opts.json) {
    io.stdout(`${JSON.stringify(manifest, null, 2)}\n`);
  }

  const yaml = yamlStringify(manifest);

  if (opts.apply) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, yaml, "utf8");
    if (!opts.json) {
      io.stdout(
        `Wrote ${objectives.length} objective${objectives.length === 1 ? "" : "s"} to ` +
          `${MANIFEST_RELATIVE_PATH}\n`,
      );
    }
    return 0;
  }

  if (!opts.json) {
    io.stdout(yaml);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// check — local pre-commit mirror of the Python gate validator's text-hash
// verification semantics (`validate_cycle_doc.py` `_resolve_criterion` /
// `_find_criterion` + `canonicalize_criterion`).
//
// For each objective with `sourceCriterion.kind === "text-hash"`:
//   - Parse the locator (`<section>#<criterion-id>`) — section MUST be
//     `exit_criteria` (only section exposed by `readCycleDoc`).
//   - Resolve the cycle doc via `readCycleDoc(cwd, "cycle<N>")`.
//   - Extract items via `extractExitCriteria` and find the one whose id
//     matches the criterion-id from the locator.
//   - Recompute `sha256(canonicalizeCriterion(<raw line>))` and compare to
//     the declared sha256.  Mismatch / missing criterion / missing doc → FAIL.
//
// `inferred` → non-blocking informational note (mirrors the Python validator's
// non-blocking path at validate_cycle_doc.py:1306).
// ---------------------------------------------------------------------------

interface CheckResult {
  id: string;
  status: "ok" | "fail" | "note";
  message: string;
}

async function cmdCheck(
  opts: CheckOptions,
  io: ObjectivesIo,
  deps: ObjectivesDeps,
): Promise<number> {
  const read = deps.readCycleDoc ?? readCycleDoc;
  const manifestPath = resolve(opts.cwd, MANIFEST_RELATIVE_PATH);

  if (!existsSync(manifestPath)) {
    const msg = `No ${MANIFEST_RELATIVE_PATH} found under ${opts.cwd} — nothing to check.`;
    if (opts.json) {
      io.stdout(JSON.stringify({ ok: true, note: msg, results: [] }, null, 2) + "\n");
    } else {
      io.stdout(`note: ${msg}\n`);
    }
    return 0;
  }

  let manifest;
  try {
    const raw = readFileSync(manifestPath, "utf8");
    manifest = parseObjectivesManifest(yamlParse(raw));
  } catch (err) {
    io.stderr(
      `df objectives check: ${MANIFEST_RELATIVE_PATH} could not be parsed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  const results: CheckResult[] = [];
  let anyFail = false;

  for (const obj of manifest.objectives) {
    const sc = obj.sourceCriterion;

    if (sc === undefined) {
      results.push({ id: obj.id, status: "note", message: "no sourceCriterion binding — skipped." });
      continue;
    }

    if (sc.kind === "human-reviewed") {
      results.push({ id: obj.id, status: "note", message: "human-reviewed — skipped." });
      continue;
    }

    if (sc.kind === "inferred") {
      results.push({
        id: obj.id,
        status: "note",
        message: "inferred (awaiting ratification) — skipped.",
      });
      continue;
    }

    // sc.kind === "text-hash"
    // Parse the locator: `<section>#<criterion-id>`
    const hashMatch = /^([^#]+)#(.+)$/.exec(sc.locator);
    if (!hashMatch) {
      results.push({ id: obj.id, status: "fail", message: `malformed locator: ${sc.locator}` });
      anyFail = true;
      continue;
    }
    const sectionSlug = hashMatch[1]!;
    const criterionId = hashMatch[2]!;

    // Only `exit_criteria` is currently resolvable.
    if (sectionSlug !== "exit_criteria") {
      results.push({
        id: obj.id,
        status: "fail",
        message: `unsupported section in locator: ${sectionSlug} (only exit_criteria is supported).`,
      });
      anyFail = true;
      continue;
    }

    // Derive cycle id from the objective id (`cycle<N>#ec<k>` → `cycle<N>`).
    const cycleIdMatch = /^(cycle[^#]+)#/.exec(obj.id);
    if (!cycleIdMatch || !obj.source || obj.source.kind !== "cycle") {
      results.push({
        id: obj.id,
        status: "fail",
        message: `cannot derive cycle doc id from objective id: ${obj.id}`,
      });
      anyFail = true;
      continue;
    }
    const cycleDocId = `cycle${obj.source.ref}`;

    const doc = await read(opts.cwd, cycleDocId);
    if (doc === null) {
      results.push({
        id: obj.id,
        status: "fail",
        message: `cycle doc ${cycleDocId} not found under ${join(opts.cwd, "docs/roadmap/cycles")}.`,
      });
      anyFail = true;
      continue;
    }

    const section = doc.sections[sectionSlug];
    if (section === undefined || section.trim() === "") {
      results.push({
        id: obj.id,
        status: "fail",
        message: `cycle doc ${cycleDocId} has no '${sectionSlug}' section.`,
      });
      anyFail = true;
      continue;
    }

    const criteria = extractExitCriteria(section);
    const criterion = criteria.find((c) => c.id === criterionId);
    if (criterion === undefined) {
      results.push({
        id: obj.id,
        status: "fail",
        message: `criterion ${criterionId} not found in ${cycleDocId} '${sectionSlug}' (${criteria.length} items found).`,
      });
      anyFail = true;
      continue;
    }

    const actualSha256 = sha256Hex(canonicalizeCriterion(criterion.raw));
    if (actualSha256 !== sc.sha256) {
      results.push({
        id: obj.id,
        status: "fail",
        message:
          `text-hash mismatch for ${criterionId} in ${cycleDocId}: ` +
          `declared ${sc.sha256.slice(0, 12)}… ≠ actual ${actualSha256.slice(0, 12)}… ` +
          `(criterion text may have changed — re-run \`df objectives derive\` to refresh).`,
      });
      anyFail = true;
      continue;
    }

    results.push({ id: obj.id, status: "ok", message: `text-hash verified (${sc.sha256.slice(0, 12)}…).` });
  }

  if (opts.json) {
    io.stdout(
      JSON.stringify(
        { ok: !anyFail, results: results.map((r) => ({ id: r.id, status: r.status, message: r.message })) },
        null,
        2,
      ) + "\n",
    );
  } else {
    for (const r of results) {
      if (r.status === "ok") {
        io.stdout(`ok      ${r.id}: ${r.message}\n`);
      } else if (r.status === "fail") {
        io.stdout(`FAIL    ${r.id}: ${r.message}\n`);
      } else {
        io.stdout(`note    ${r.id}: ${r.message}\n`);
      }
    }
    if (!anyFail && results.length > 0) {
      io.stdout(`\nAll ${results.length} objective${results.length === 1 ? "" : "s"} ok.\n`);
    } else if (!anyFail && results.length === 0) {
      io.stdout("No objectives to check.\n");
    }
  }

  return anyFail ? 1 : 0;
}

/**
 * Read an existing manifest (if any) and return a map of objective id →
 * `attestedBy` bindings to preserve across a re-derive. A malformed/unreadable
 * existing manifest is non-fatal (we warn and derive fresh) — the worst case is
 * losing hand-edits the operator can re-add, which is strictly safer than
 * refusing to derive.
 */
function loadPreservedBindings(
  manifestPath: string,
  io: ObjectivesIo,
): Map<string, Objective["attestedBy"]> {
  const preserved = new Map<string, Objective["attestedBy"]>();
  if (!existsSync(manifestPath)) {
    return preserved;
  }
  let parsed: ObjectivesManifest;
  try {
    const existing = readFileSync(manifestPath, "utf8");
    parsed = parseObjectivesManifest(yamlParse(existing));
  } catch (err) {
    io.stderr(
      `df objectives derive: warning — existing ${MANIFEST_RELATIVE_PATH} could not be ` +
        `parsed (${err instanceof Error ? err.message : String(err)}); deriving fresh, ` +
        "hand-edited attestedBy bindings are NOT preserved.\n",
    );
    return preserved;
  }
  for (const obj of parsed.objectives) {
    if (obj.attestedBy.length > 0) {
      preserved.set(obj.id, obj.attestedBy);
    }
  }
  return preserved;
}
