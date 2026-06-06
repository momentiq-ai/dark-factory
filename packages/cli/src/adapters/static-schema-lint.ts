// Consumer dark-factory-platform#107 — deterministic schema-lint adapter.
//
// Why a sixth adapter (consumer DFP #107 incident): on PR #105 of the
// consumer hosted control-plane, the local-profile quorum (cursor-cli +
// codex, quorum 2) returned APPROVED on a `~/.claude/settings.json`
// example documenting `effortLevel: "max"`. The cloud-profile cursor
// adapter (via `cursor-sdk`, different prompt envelope) caught it as a
// high-severity schema finding: the persisted `effortLevel` schema only
// permits `low|medium|high|xhigh`; `"max"` is silently ignored on
// session start (the `max` tier exists only as a session-scoped
// `/effort max` command / `--effort max` flag). Same vendor, different
// adapter, different verdict.
//
// The structural fix: a deterministic critic that does NOT depend on
// LLM judgement for this class of finding. The adapter scans changed
// markdown / config files for fenced code blocks annotated with a
// `// schema: <name>` (or `# schema: <name>` for YAML / `<!-- schema:
// <name> -->` for HTML / `/* schema: <name> */` for JSONC-block style)
// marker, looks up the named schema in a built-in registry, and runs
// `ajv` JSON-Schema validation against the parsed payload. Violations
// surface as `severity: high` findings; the PR #105 `effortLevel: "max"`
// example fails in <50ms.
//
// Posture:
//   - `requiredEnvVars: []` — no auth, no network, no LLM call.
//   - `runtime: local` (and cloud — belt-and-suspenders; deterministic
//     so the same result either side).
//   - `required: false` in the consumer config; its job is to surface
//     blocking-severity findings, which veto regardless of quorum (the
//     existing single-critic-veto pattern under min-complete-quorum).
//   - Pure function over `packet.changedFiles` — same input → same
//     output, every time. No retries, no flake, no calibration window.
//
// What it DOES validate:
//   - Fenced code blocks annotated with a recognized schema marker.
//   - Built-in schemas: `claude-code-settings`, `df-agent-review-config`.
//     The registry is extensible by call sites that supply additional
//     schemas via constructor options (a future cycle can wire
//     `~/.claude/settings.json` schema from the upstream Claude Code
//     project once it stabilizes; for now the registry is local + minimal).
//
// What it does NOT do:
//   - It does NOT auto-detect schemas from the file path (a code block
//     in CLAUDE.md showing a `~/.claude/settings.json` example needs the
//     opt-in `// schema: claude-code-settings` marker). The opt-in is
//     intentional: false positives in the local quorum are more harmful
//     than false negatives because they erode trust in the gate. A doc
//     author who forgets the marker gets a missed finding (caught by
//     the cloud cursor anyway); a marker mismatch produces a clear
//     finding the author can correct.
//   - It does NOT validate the entire markdown document as JSON. Only
//     fenced code blocks marked with the schema annotation are subject
//     to lint.
//   - It does NOT call any LLM, network endpoint, or filesystem outside
//     `packet.changedFiles`. The adapter is pure-deterministic.
//
// Where it RUNS in the gate:
//   - Local profile: paired with `cursor-cli` + `codex-sdk`. Adds a
//     deterministic backstop without touching quorum (it is veto-only via
//     `blockingSeverities`).
//   - Cloud profile: same wiring; deterministic so identical verdict.
//
// Drift control: the built-in schemas live in `STATIC_SCHEMAS` below.
// When the Claude Code settings schema evolves upstream, this registry
// needs the corresponding update. The boundary is intentional — we don't
// chase a moving upstream schema without explicit review.

import {
  type CriticConfig,
  type CriticResult,
  type DoctorCheck,
  type ReviewFinding,
  type ReviewPacket,
} from "@momentiq/dark-factory-schemas";
// Ajv ships a CJS default + named-types pattern. Under NodeNext ESM the
// default-import lands as the namespace; the constructor is on `.default`.
// Probe both shapes so the adapter survives ajv minor-version churn (the
// shape moved between 8.x patch releases historically).
import AjvImport, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsImport from "ajv-formats";
import { parse as parseYaml } from "yaml";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvCtor: new (opts?: object) => any =
  (AjvImport as unknown as { default?: new (opts?: object) => unknown }).default
    ? ((AjvImport as unknown as { default: new (opts?: object) => unknown }).default as new (
        opts?: object,
      ) => unknown)
    : (AjvImport as unknown as new (opts?: object) => unknown);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats: (ajv: any) => unknown =
  typeof addFormatsImport === "function"
    ? (addFormatsImport as unknown as (ajv: unknown) => unknown)
    : (
        (addFormatsImport as unknown as { default: (ajv: unknown) => unknown })
          .default as unknown as (ajv: unknown) => unknown
      );

import type { CriticAdapter, CriticReviewOptions } from "./critic.js";

export const STATIC_SCHEMA_LINT_ADAPTER_ID = "static-schema-lint";

// ---------------------------------------------------------------------------
// Built-in schema registry.
//
// Each entry is a JSON Schema (draft-07-compatible) the adapter validates
// extracted code blocks against. The schemas are intentionally MINIMAL —
// they encode only the fields whose schema-violation is a real defect-class
// observed in the consumer incident (consumer DFP #107) or its near
// neighbors. A schema that tries to validate every field of an upstream
// settings file becomes brittle the moment the upstream adds a field, so
// the adapter prefers a smaller surface that catches the named regressions
// over a larger surface that breaks on every upstream addition.

/**
 * Schema for `~/.claude/settings.json` examples.
 *
 * The PRIMARY field this schema is designed to gate is `effortLevel`: the
 * persisted-config tier is `low|medium|high|xhigh` only; `"max"` is a
 * session-scoped value (only accepted by `/effort max` and `--effort
 * max`). The consumer DFP PR #105 incident: a CLAUDE.md example
 * documenting `effortLevel: "max"` as a recommended persisted default
 * sailed past the local quorum and was caught by the cloud cursor
 * adapter as a high-severity schema finding.
 *
 * `additionalProperties: true` because the upstream Claude Code settings
 * file accepts many more fields than we want to encode here. The schema
 * is OPT-IN: doc authors mark a code block with `// schema:
 * claude-code-settings` only when they're showing a settings example.
 */
const CLAUDE_CODE_SETTINGS_SCHEMA = {
  $id: "claude-code-settings",
  type: "object",
  additionalProperties: true,
  properties: {
    model: { type: "string", minLength: 1 },
    effortLevel: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh"],
    },
    theme: { type: "string" },
  },
} as const;

/**
 * Schema for `.agent-review/config.json` examples.
 *
 * Mirrors a SUBSET of `parseAgentReviewConfig` (the canonical runtime
 * validator in `@momentiq/dark-factory-schemas`). The mirror is bounded
 * to the high-churn fields where a doc-example regression is most likely
 * to mislead a consumer:
 *   - top-level `version` enum (the parser rejects unknown versions)
 *   - `aggregation.policy` enum
 *   - `aggregation.blockingSeverities` enum-array
 *   - `aggregation.quorum` integer constraints (>= 2 when policy is
 *     `min-complete-quorum`)
 *   - `critics[].runtime` ("local" | "cloud")
 *   - `critics[].adapter` (known adapter id)
 *
 * The narrower fields (per-adapter params, profiles, validation routes)
 * are NOT validated here — the runtime parser does that, and chasing every
 * field at the doc-lint layer would make this schema a maintenance
 * burden disproportionate to the catch rate. The doc-lint surface is the
 * fields whose typo is most likely to ship and most expensive to debug.
 */
const DF_AGENT_REVIEW_CONFIG_SCHEMA = {
  $id: "df-agent-review-config",
  type: "object",
  additionalProperties: true,
  properties: {
    version: { type: "integer", enum: [1, 2] },
    aggregation: {
      type: "object",
      additionalProperties: true,
      properties: {
        policy: {
          type: "string",
          enum: ["block-if-any", "min-complete-quorum"],
        },
        blockingSeverities: {
          type: "array",
          items: {
            type: "string",
            enum: ["blocker", "high", "medium", "low", "note"],
          },
        },
        quorum: { type: "integer", minimum: 2 },
      },
    },
    critics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          adapter: {
            type: "string",
            enum: [
              "cursor-sdk",
              "cursor-cli",
              "codex-sdk",
              "gemini-sdk",
              "grok-direct-sdk",
              "minimax-direct-sdk",
              "static-schema-lint",
            ],
          },
          required: { type: "boolean" },
          runtime: { type: "string", enum: ["local", "cloud"] },
        },
      },
    },
  },
} as const;

/**
 * The built-in schema registry. Maps a schema name (the value of the
 * `// schema: <name>` annotation) to the JSON Schema definition the
 * adapter validates against.
 */
export const STATIC_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  "claude-code-settings": CLAUDE_CODE_SETTINGS_SCHEMA as Record<string, unknown>,
  "df-agent-review-config": DF_AGENT_REVIEW_CONFIG_SCHEMA as Record<string, unknown>,
});

// ---------------------------------------------------------------------------
// Code-block extraction.
//
// The extractor scans a markdown source for fenced code blocks annotated
// with a recognized schema marker. The marker forms accepted (per the
// spec's "opt-in via annotation"):
//
//   ```jsonc
//   // schema: claude-code-settings
//   { "effortLevel": "max" }
//   ```
//
//   ```yaml
//   # schema: github-actions-workflow
//   on: push
//   ```
//
//   ```json
//   /* schema: df-agent-review-config */
//   { "version": 2, ... }
//   ```
//
// Plus an HTML-comment form for fences that wrap JSON proper (no
// comment-prefix inside the JSON itself, because JSON forbids comments):
//
//   <!-- schema: claude-code-settings -->
//   ```json
//   { "model": "opus", "effortLevel": "max" }
//   ```
//
// The HTML-comment form is the only way to annotate a strict-JSON block;
// `// schema:` and `# schema:` produce invalid JSON if placed inside a
// `json` fence. The extractor handles both: an HTML comment IMMEDIATELY
// preceding a fence (separated by at most blank lines) attaches its
// schema to that fence.

const FENCE_RE = /(^|\n)```([^\n]*)\n([\s\S]*?)\n```/g;
const HTML_SCHEMA_RE = /<!--\s*schema:\s*([A-Za-z0-9_\-./]+)\s*-->/g;
const INLINE_SCHEMA_RES: ReadonlyArray<RegExp> = [
  // // schema: name  (JS/TS/JSONC comment style)
  /(?:^|\n)\s*\/\/\s*schema:\s*([A-Za-z0-9_\-./]+)\s*(?:\n|$)/,
  // # schema: name  (YAML / shell comment style)
  /(?:^|\n)\s*#\s*schema:\s*([A-Za-z0-9_\-./]+)\s*(?:\n|$)/,
  // /* schema: name */  (block comment style)
  /\/\*\s*schema:\s*([A-Za-z0-9_\-./]+)\s*\*\//,
];

export interface ExtractedBlock {
  /** Schema name from the annotation. */
  schemaName: string;
  /** Code-block body with the schema-marker line stripped (parseable as JSON). */
  body: string;
  /** Fence language tag (e.g. "jsonc", "json", "yaml", or "" if absent). */
  language: string;
  /** 1-based line in the source markdown where the fence body starts. */
  startLine: number;
}

/**
 * Strip JSONC / JSON5-style comments AND trailing commas from a JSON-ish
 * payload so `JSON.parse` succeeds on JSONC examples. Single-pass state
 * machine — comment stripping AND trailing-comma removal both honor
 * string-literal boundaries, so a comma-brace sequence inside a string
 * value (`",}"`) is preserved verbatim. Designed for the limited surface
 * of config-file examples in docs, not as a general JSON5 parser.
 *
 * Exported for unit-testability.
 */
export function stripJsoncSyntax(text: string): string {
  // Single pass: walk the text character-by-character and emit chars to
  // the output buffer. State tracked: whether we're inside a string
  // literal, and the index of the most recent comma emitted at the
  // top-of-output (used to retroactively drop trailing commas when the
  // next non-whitespace, non-comment, non-string token is `}` or `]`).
  const out: string[] = [];
  let i = 0;
  let inString: string | null = null;
  let escape = false;
  // pendingCommaIndex: index into `out` of the last emitted ',' that has
  // only seen whitespace / comments since. Reset to -1 once the comma is
  // either kept (any other char emitted) or dropped (closer encountered).
  let pendingCommaIndex = -1;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (inString !== null) {
      out.push(c);
      pendingCommaIndex = -1;
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === inString) {
        inString = null;
      }
      i++;
      continue;
    }
    // Not inside a string.
    if (c === '"' || c === "'") {
      inString = c;
      out.push(c);
      pendingCommaIndex = -1;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      // Line comment — skip to end-of-line (the newline is consumed
      // outside this branch on the next loop iteration). pendingCommaIndex
      // is preserved across the comment.
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      // Block comment — skip to closing */ (pendingCommaIndex preserved).
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === ",") {
      out.push(c);
      pendingCommaIndex = out.length - 1;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      // Trailing-comma case: if the most-recent non-whitespace token
      // emitted was ',', drop it. Splicing the array preserves the
      // single-pass invariant without an extra string-rewrite step.
      if (pendingCommaIndex !== -1) {
        out.splice(pendingCommaIndex, 1);
      }
      out.push(c);
      pendingCommaIndex = -1;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      // Whitespace does NOT close the trailing-comma window.
      out.push(c);
      i++;
      continue;
    }
    // Any other character commits the pending comma (it's a real
    // separator, not trailing).
    out.push(c);
    pendingCommaIndex = -1;
    i++;
  }
  return out.join("");
}

/**
 * Extract schema-annotated code blocks from a markdown source. Returns
 * an empty array when the source contains no annotated blocks.
 *
 * The schema annotation may be embedded INSIDE the code block — three
 * forms: JSONC line comment, YAML / shell line comment, or block
 * comment — or as an HTML comment IMMEDIATELY before the fence (the
 * only form compatible with strict JSON blocks, since JSON forbids
 * inline comments).
 */
export function extractSchemaBlocks(source: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = [];
  // First pass: collect every HTML-comment schema annotation with its
  // position so we can attach it to the next fence that follows.
  const htmlAnnotations: Array<{ name: string; index: number }> = [];
  HTML_SCHEMA_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_SCHEMA_RE.exec(source)) !== null) {
    htmlAnnotations.push({ name: m[1] ?? "", index: m.index });
  }
  // Second pass: walk fences. For each, look for an INSIDE annotation
  // first; if none, search backwards for the nearest HTML annotation
  // that precedes the fence with only whitespace / blank lines between.
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(source)) !== null) {
    const leading = m[1] ?? "";
    const language = (m[2] ?? "").trim().split(/\s+/)[0] ?? "";
    const body = m[3] ?? "";
    const fenceIndex = m.index + leading.length;
    // INSIDE annotation
    let schemaName: string | undefined;
    let strippedBody = body;
    for (const re of INLINE_SCHEMA_RES) {
      const inner = re.exec(body);
      if (inner) {
        schemaName = inner[1];
        // Remove the matched line(s) from the body so JSON.parse won't trip.
        strippedBody = body.replace(re, "\n").replace(/^\s*\n/, "");
        break;
      }
    }
    if (!schemaName) {
      // HTML-comment annotation IMMEDIATELY before the fence — find the
      // nearest one whose index is < fenceIndex and whose intervening
      // text is only whitespace.
      for (let h = htmlAnnotations.length - 1; h >= 0; h--) {
        const ann = htmlAnnotations[h];
        if (!ann || ann.index >= fenceIndex) continue;
        const between = source.slice(ann.index, fenceIndex);
        // Allow the closing `-->`, whitespace, and at most one blank line.
        const trimmed = between.replace(/<!--\s*schema:\s*[A-Za-z0-9_\-./]+\s*-->/, "");
        if (/^[\s\n]*$/.test(trimmed)) {
          schemaName = ann.name;
        }
        break;
      }
    }
    if (!schemaName) continue;
    // Compute 1-based start line of the fence body for diagnostics.
    const startLine = source.slice(0, fenceIndex).split("\n").length + 1;
    blocks.push({
      schemaName,
      body: strippedBody,
      language,
      startLine,
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Parser dispatch.
//
// `parseBlockBody` selects between JSON/JSONC and YAML parsing based on
// the fence language tag captured during extraction. The YAML branch
// runs `yaml.parse` directly (no comment-stripping pass — YAML's syntax
// already permits `#` line comments, which the parser handles natively).
// JSON / JSONC / strict-JSON fences go through `stripJsoncSyntax` so
// `// ...` / `/* ... */` comments and trailing commas don't trip
// `JSON.parse` on doc examples.
//
// Language tags recognized:
//   - "yaml", "yml" → YAML parser
//   - "" (no tag), "json", "jsonc", "json5" → JSON-with-JSONC-strip path
//
// An unknown / non-empty language tag falls back to the JSON path. The
// extractor enforces opt-in via the schema annotation, so this only
// runs against blocks the author explicitly opted in to.

const YAML_LANGUAGES: ReadonlySet<string> = new Set(["yaml", "yml"]);

function parseBlockBody(block: ExtractedBlock): unknown {
  const lang = block.language.toLowerCase();
  if (YAML_LANGUAGES.has(lang)) {
    return parseYaml(block.body);
  }
  const normalized = stripJsoncSyntax(block.body);
  return JSON.parse(normalized);
}

// ---------------------------------------------------------------------------
// Diff fallback — reconstruct added markdown content from packet.diff.
//
// When `context.includeFullChangedFiles: false`, `git.ts:changedFiles`
// skips the `git show <sha>:<path>` content read and emits each entry
// without a `content` field. The adapter would otherwise scan zero
// files and silently APPROVE every markdown-only PR. The fallback
// extracts the `+` lines from each file's hunks in the unified diff,
// producing a best-effort reconstruction of the ADDED content the
// adapter can scan.
//
// Caveats (documented in CONSUMER-ADOPTION §4.1):
//   - Only hunks that ADD at least one `+` line contribute — a pure
//     deletion hunk (the consumer fixed the violation) is correctly NOT
//     reported as a new finding.
//   - Within a contributing hunk, BOTH `+` (added) and ` ` (context) lines
//     are preserved so the surrounding fenced-block boundary and the
//     `<!-- schema: ... -->` / `// schema: ...` / `# schema: ...`
//     annotation survive the reconstruction. Without context preservation,
//     a PR that modifies only the payload line inside an existing
//     annotated fenced block produces a body without a fence or schema
//     marker, `extractSchemaBlocks` returns nothing, and the gate
//     silently APPROVES the violation (codex critic #116 — fail-open
//     contract breach for the deterministic backstop).
//   - Deletion (`-`) lines are still dropped — they are NOT current
//     repo state.
//   - Hunks across the same file accumulate; each contributing hunk
//     is appended with a blank line separator so distinct hunks do not
//     fuse into one virtual fenced block.
//   - If the diff itself is truncated (`packet.diffTruncated: true`),
//     fallback coverage is partial. The adapter emits a BLOCKING-
//     severity finding when diffFallbacks were used on any scanned file
//     and the diff was truncated (cursor critic #116) — see review()
//     below.

export function reconstructAddedContentFromDiff(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!diff) return out;
  const lines = diff.split("\n");
  let currentPath: string | null = null;
  // Per-hunk buffers: lines accumulate into the CURRENT hunk's buffer;
  // when the hunk ends (next `@@` header, file boundary, or end of diff)
  // it flushes into the file's content map IFF it contained at least one
  // `+` (added) line. Pure context-only hunks (impossible in normal git
  // diff output but defended against here) and pure deletion-only hunks
  // contribute nothing — matching the cycle's "regressions introduced by
  // this PR" charter.
  let hunkBuffer: string[] = [];
  let hunkHasAdd = false;
  const flushHunk = (): void => {
    if (currentPath !== null && hunkHasAdd && hunkBuffer.length > 0) {
      const prior = out.get(currentPath);
      const joined = hunkBuffer.join("\n");
      // Separate distinct hunks with a blank line so an unclosed fence in
      // one hunk does not fuse into a fenced block from a later hunk.
      out.set(currentPath, prior ? `${prior}\n\n${joined}` : joined);
    }
    hunkBuffer = [];
    hunkHasAdd = false;
  };
  for (const line of lines) {
    // `+++ b/<path>` — header for the destination file in a hunk header.
    // The leading `b/` is the standard `git diff` prefix; strip it if
    // present, fall back to the raw path otherwise.
    if (line.startsWith("+++ ")) {
      flushHunk();
      const rest = line.slice(4).trim();
      if (rest === "/dev/null") {
        currentPath = null;
      } else if (rest.startsWith("b/")) {
        currentPath = rest.slice(2);
      } else {
        currentPath = rest;
      }
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git ")) {
      // File-level headers — DO NOT contribute content, DO NOT switch
      // path (the `+++` line is the authoritative path source).
      continue;
    }
    if (line.startsWith("@@")) {
      // Hunk boundary. Flush whatever the previous hunk gathered.
      flushHunk();
      continue;
    }
    if (currentPath === null) continue;
    if (line.startsWith("+")) {
      hunkBuffer.push(line.slice(1));
      hunkHasAdd = true;
      continue;
    }
    if (line.startsWith("-")) {
      // Deletion — NOT current state. Drop.
      continue;
    }
    if (line.startsWith(" ")) {
      // Context line. Preserve it (strip the single leading space) so
      // surrounding fence + schema annotations survive when the PR
      // edits only the payload line inside an existing annotated block.
      hunkBuffer.push(line.slice(1));
      continue;
    }
    if (line === "\\ No newline at end of file") {
      // Standard git diff marker. Skip.
      continue;
    }
    // Anything else (blank line between hunks, etc.) — drop.
  }
  flushHunk();
  return out;
}

// ---------------------------------------------------------------------------
// Validator construction.
//
// `ajv` is constructed lazily on first call. The single Ajv instance is
// shared across review() invocations within an adapter instance — schema
// compilation is cached per `$id`, so repeated reviews don't pay the
// compile cost twice. Each schema is compiled once and the resulting
// `ValidateFunction` is reused.
//
// `strict: false` is intentional: the built-in schemas use draft-07 keyword
// semantics; strict mode would warn on `additionalProperties: true` and
// other defensive defaults that are correct for our use case (we want
// known-keys to be tight while permitting forward-compat fields).

interface SchemaRegistry {
  get(name: string): ValidateFunction | undefined;
  names(): readonly string[];
}

function buildRegistry(
  schemas: Readonly<Record<string, Record<string, unknown>>>,
): SchemaRegistry {
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormats(ajv);
  const compiled = new Map<string, ValidateFunction>();
  for (const [name, schema] of Object.entries(schemas)) {
    compiled.set(name, ajv.compile(schema) as ValidateFunction);
  }
  return {
    get: (name) => compiled.get(name),
    names: () => [...compiled.keys()],
  };
}

// ---------------------------------------------------------------------------
// Finding construction.
//
// Each Ajv `ErrorObject` produces ONE `ReviewFinding`. The mapping
// preserves the schema path (`instancePath`) and the constraint message so
// the doc author can locate and correct the violation without re-running
// Ajv themselves. `severity: high` matches the spec's recommendation:
// schema-shape regressions in code examples are a defect the gate should
// block on, not a stylistic note.

function findingsForAjvErrors(args: {
  errors: ErrorObject[];
  filePath: string;
  schemaName: string;
  startLine: number;
  blockBody: string;
}): ReviewFinding[] {
  const { errors, filePath, schemaName, startLine, blockBody } = args;
  return errors.map((err) => {
    const path = err.instancePath || "(root)";
    const params = JSON.stringify(err.params);
    const evidence = `${schemaName}${path}: ${err.message ?? "schema violation"} (constraint params=${params})`;
    // Best-effort line offset within the block. ajv doesn't track source
    // lines (it operates on parsed JS values), so we surface the fence
    // start line and let the author scan the local context.
    return {
      severity: "high",
      category: "schema",
      file: filePath,
      line: startLine,
      evidence,
      impact: `Code example in ${filePath} violates JSON Schema \`${schemaName}\`. A consumer copy-pasting this example would produce a silently-invalid config; the violation is identical in pattern to consumer dark-factory-platform#107 (the \`effortLevel: "max"\` regression that the local LLM quorum missed).`,
      requiredFix: `Correct the example so it satisfies the schema, or remove the schema annotation if the example is intentionally illustrating an invalid shape. Block body excerpt:\n${blockBody.slice(0, 200)}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Adapter class.

/**
 * Options for constructing the adapter. The `schemas` override lets
 * callers add additional schemas without modifying the built-in registry
 * (useful for tests and for consumer repos that want to lint their own
 * config shapes). Supplied schemas merge with `STATIC_SCHEMAS`; a
 * caller-supplied schema with the same name as a built-in overrides it.
 */
export interface StaticSchemaLintAdapterOptions {
  schemas?: Readonly<Record<string, Record<string, unknown>>>;
  /**
   * File globs (basenames + extensions) the adapter will scan. The
   * default covers the high-churn doc surfaces. Anything not matching
   * is skipped without inspection.
   */
  scannedFilePatterns?: readonly RegExp[];
}

const DEFAULT_SCANNED_FILE_PATTERNS: readonly RegExp[] = [
  /\.md$/i,
  /\.mdx$/i,
  /CLAUDE\.md$/i,
  /AGENTS\.md$/i,
  /GEMINI\.md$/i,
];

export class StaticSchemaLintAdapter implements CriticAdapter {
  readonly id = STATIC_SCHEMA_LINT_ADAPTER_ID;
  readonly requiredEnvVars: readonly string[] = [];

  private readonly registry: SchemaRegistry;
  private readonly scannedFilePatterns: readonly RegExp[];

  constructor(options: StaticSchemaLintAdapterOptions = {}) {
    const mergedSchemas = { ...STATIC_SCHEMAS, ...(options.schemas ?? {}) };
    this.registry = buildRegistry(mergedSchemas);
    this.scannedFilePatterns = options.scannedFilePatterns ?? DEFAULT_SCANNED_FILE_PATTERNS;
  }

  async review(
    packet: ReviewPacket,
    critic: CriticConfig,
    options: CriticReviewOptions,
  ): Promise<CriticResult> {
    const findings: ReviewFinding[] = [];
    const startMs = Date.now();
    options.emit?.({
      ts: new Date().toISOString(),
      event: "critic_run_started",
      commit: packet.commit.sha,
      criticId: critic.id,
      adapter: this.id,
      model: critic.model.id,
    });

    let scannedFiles = 0;
    let extractedBlocks = 0;
    let parseFailures = 0;
    // Track which scanned files relied on the diff-fallback path so we
    // can emit a blocking finding when `packet.diffTruncated === true`
    // (cursor critic #116 — on large PRs with includeFullChangedFiles:
    // false, the truncation cap in rebind.ts can cut a violating hunk
    // before it reaches the adapter, and the gate would otherwise
    // silently APPROVE).
    const diffFallbackFiles: string[] = [];

    // Fallback-source map: when a changed file body is not loaded into
    // `changedFiles[].content` (the consumer set
    // `context.includeFullChangedFiles: false`, so git.ts skips the
    // `git show <sha>:<path>` read), we reconstruct the added markdown
    // content from `packet.diff` so the adapter is not silently starved.
    // This keeps the deterministic backstop on for the DFP #107 fixture
    // without requiring every consumer to flip a context flag.
    const diffFallbacks = reconstructAddedContentFromDiff(packet.diff);

    for (const file of packet.changedFiles) {
      if (!this.scannedFilePatterns.some((re) => re.test(file.path))) continue;
      if (file.omittedReason) continue;
      const direct = file.content ?? file.compactedContent;
      const fallback = direct === undefined ? diffFallbacks.get(file.path) : undefined;
      const content = direct ?? fallback;
      if (!content) continue;
      if (fallback !== undefined) {
        diffFallbackFiles.push(file.path);
      }
      scannedFiles++;

      const blocks = extractSchemaBlocks(content);
      for (const block of blocks) {
        extractedBlocks++;
        const validator = this.registry.get(block.schemaName);
        if (!validator) {
          // Unknown schema — `high` severity by default (blocks merge).
          // A typo in the annotation (e.g. `claude-code-setting` instead
          // of `claude-code-settings`) would otherwise silently disable
          // validation for the exact class of doc examples this adapter
          // is meant to gate. Treat unknown schemas as a configuration
          // error the author must resolve before merge.
          findings.push({
            severity: "high",
            category: "schema",
            file: file.path,
            line: block.startLine,
            evidence: `Unknown schema name "${block.schemaName}" in fenced code-block annotation (registered: ${this.registry.names().join(", ") || "(none)"}).`,
            impact:
              "The schema annotation is present but the named schema is not in the adapter registry, so this block is NOT being validated. A one-character typo here disables the deterministic backstop for that block; the gate must surface it rather than fail open.",
            requiredFix: `Use one of the registered schema names (${this.registry.names().join(", ") || "(none)"}), OR register a new schema by extending \`STATIC_SCHEMAS\` in \`packages/cli/src/adapters/static-schema-lint.ts\` (or via the \`schemas\` constructor option for repo-local adapters), OR remove the schema annotation if the block is intentionally not subject to schema lint.`,
          });
          continue;
        }
        // Parse the block body. Dispatch on the fence language: YAML
        // fences (annotated with `# schema:`) parse via the `yaml`
        // package; JSON / JSONC / strict-JSON fences parse via the
        // JSONC-stripping JSON.parse path.
        let parsed: unknown;
        try {
          parsed = parseBlockBody(block);
        } catch (err) {
          parseFailures++;
          findings.push({
            severity: "high",
            category: "schema",
            file: file.path,
            line: block.startLine,
            evidence: `Schema-annotated block (\`${block.schemaName}\`, language=\`${block.language || "(none)"}\`) is not parseable: ${(err as Error).message}`,
            impact:
              "Doc examples that claim a schema MUST be valid in their declared format (JSON/JSONC/YAML); an unparseable block produces a silent regression for any consumer copy-pasting the example.",
            requiredFix:
              "Fix the syntax error in the code block, or remove the schema annotation if the block is intentionally illustrating malformed input.",
          });
          continue;
        }
        const ok = validator(parsed);
        if (!ok) {
          findings.push(
            ...findingsForAjvErrors({
              errors: validator.errors ?? [],
              filePath: file.path,
              schemaName: block.schemaName,
              startLine: block.startLine,
              blockBody: block.body,
            }),
          );
        }
      }
    }

    // cursor critic #116 — diff-truncation fail-open guard. If ANY scanned
    // file used the diff-fallback path AND packet.diffTruncated is true,
    // emit a blocking finding: the truncation cap in rebind.ts can cut a
    // violating hunk before it reaches this adapter, so the deterministic
    // backstop's silence is NOT meaningful evidence of correctness for
    // this PR. The consumer must either flip `context.includeFullChangedFiles:
    // true` (so this adapter reads file bodies directly, bypassing the
    // truncated diff) or shrink the changeset.
    if (packet.diffTruncated && diffFallbackFiles.length > 0) {
      findings.push({
        severity: "high",
        category: "schema",
        file: diffFallbackFiles[0]!,
        line: 1,
        evidence: `packet.diffTruncated=true AND ${diffFallbackFiles.length} scanned file(s) relied on diff-fallback content reconstruction (no file.content / file.compactedContent): ${diffFallbackFiles.join(", ")}. The unified diff was capped at the rebind.ts DEFAULT_DIFF_BUDGET (1_500_000 bytes); annotations in the truncated tail are NOT visible to the adapter.`,
        impact:
          "Under `context.includeFullChangedFiles: false`, the deterministic schema-lint backstop can silently APPROVE schema-invalid doc examples (the same fail-open class as consumer DFP #107) when the violating hunk falls outside the truncated diff budget. The adapter cannot prove the absence of violations in the truncated tail, so silence here is NOT evidence of correctness.",
        requiredFix:
          "Set `context.includeFullChangedFiles: true` in the consumer `.agent-review/config.json` (the adapter then reads file bodies directly via `git show <sha>:<path>` and bypasses the truncated diff), OR shrink the PR so the unified diff fits inside `DEFAULT_DIFF_BUDGET` (1.5MB). See docs/CONSUMER-ADOPTION.md §6.1 for the full mitigation matrix.",
      });
    }

    const verdict =
      findings.some(
        (f) =>
          options.blockingSeverities.includes(f.severity),
      )
        ? "CHANGES_REQUESTED"
        : "APPROVED";

    const durationMs = Date.now() - startMs;
    options.emit?.({
      ts: new Date().toISOString(),
      event: "critic_run_finished",
      commit: packet.commit.sha,
      criticId: critic.id,
      adapter: this.id,
      model: critic.model.id,
      durationMs,
      verdict,
    });

    return {
      criticId: critic.id,
      status: "complete",
      verdict,
      requiresHumanJudgment: false,
      reviewer: {
        name: critic.name,
        adapter: critic.adapter,
        model: critic.model,
        runtime: critic.runtime,
      },
      summary:
        verdict === "APPROVED"
          ? `static-schema-lint: ${scannedFiles} file(s) scanned, ${extractedBlocks} schema-annotated block(s), 0 violations.`
          : `static-schema-lint: ${scannedFiles} file(s) scanned, ${extractedBlocks} schema-annotated block(s), ${findings.length} finding(s)${parseFailures > 0 ? ` (${parseFailures} parse failure(s))` : ""}.`,
      findings,
      validation: { qualityGateResults: [], qualityGatesMissing: [] },
      confidence: "high",
      durationMs,
    };
  }

  async doctor(_critic: CriticConfig): Promise<DoctorCheck[]> {
    // The adapter is dependency-light: ajv is bundled at build time, no
    // env vars, no subprocess, no network. The doctor probes exist so
    // operators can confirm the registry compiled correctly on this
    // host (catches a malformed schema literal at adapter-load time).
    const checks: DoctorCheck[] = [];
    const names = this.registry.names();
    checks.push({
      name: "static_schema_lint_registry",
      passed: names.length > 0,
      detail: `${names.length} schema(s) registered: ${names.join(", ") || "(none)"}`,
      ...(names.length > 0
        ? {}
        : { remediation: "Extend STATIC_SCHEMAS in packages/cli/src/adapters/static-schema-lint.ts" }),
    });
    // Smoke-validate a known-good payload against the canonical schema
    // so a packaging error (e.g. ajv tree-shaken away) surfaces in
    // doctor instead of at review time.
    try {
      const validator = this.registry.get("claude-code-settings");
      const smokeOk = validator
        ? Boolean(validator({ model: "opus", effortLevel: "high" }))
        : false;
      checks.push({
        name: "static_schema_lint_smoke",
        passed: smokeOk,
        detail: smokeOk
          ? "ajv compiled the claude-code-settings schema and validated a known-good payload."
          : `ajv smoke test failed (validator present: ${Boolean(validator)})`,
        ...(smokeOk
          ? {}
          : { remediation: "Re-install ajv: `npm ci --workspace=@momentiq/dark-factory-cli`" }),
      });
    } catch (err) {
      checks.push({
        name: "static_schema_lint_smoke",
        passed: false,
        detail: `ajv threw during smoke validation: ${(err as Error).message}`,
        remediation: "Re-install ajv: `npm ci --workspace=@momentiq/dark-factory-cli`",
      });
    }
    return checks;
  }
}
