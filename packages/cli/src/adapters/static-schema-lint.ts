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
 * Strip JSONC / JSON5-style comments and trailing commas from a JSON-ish
 * payload so `JSON.parse` succeeds on JSONC examples. Pure / regex-based;
 * does NOT recurse into string contents (matches inside `"..."` are left
 * alone). Designed for the limited surface of config-file examples in
 * docs, not as a general JSON5 parser.
 *
 * Exported for unit-testability.
 */
export function stripJsoncSyntax(text: string): string {
  // Pass 1: remove // line comments and /* block comments */ that are NOT
  // inside a string literal. We process character-by-character with a
  // small state machine — regex alone can't reliably skip strings.
  const chars: string[] = [];
  let i = 0;
  let inString: string | null = null; // the quote char ('"') when inside a string
  let escape = false;
  while (i < text.length) {
    const c = text[i] ?? "";
    if (inString !== null) {
      chars.push(c);
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
    // not inside a string
    if (c === '"' || c === "'") {
      inString = c;
      chars.push(c);
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      // line comment — skip to end-of-line (preserve the newline)
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      // block comment — skip to closing */
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // consume the */
      continue;
    }
    chars.push(c);
    i++;
  }
  let stripped = chars.join("");
  // Pass 2: remove trailing commas before } or ]. Outside strings (the
  // string-skipping above is no longer in effect, but trailing-comma
  // patterns inside strings are vanishingly rare and the gate-payload
  // domain is config files, not arbitrary text).
  stripped = stripped.replace(/,(\s*[}\]])/g, "$1");
  return stripped;
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

    for (const file of packet.changedFiles) {
      if (!this.scannedFilePatterns.some((re) => re.test(file.path))) continue;
      if (file.omittedReason) continue;
      const content = file.content ?? file.compactedContent;
      if (!content) continue;
      scannedFiles++;

      const blocks = extractSchemaBlocks(content);
      for (const block of blocks) {
        extractedBlocks++;
        const validator = this.registry.get(block.schemaName);
        if (!validator) {
          // Unknown schema — emit a `medium`-severity finding so the
          // doc author knows their annotation is dead weight, but do
          // NOT block. The remediation is either to register the
          // schema or fix the annotation.
          findings.push({
            severity: "medium",
            category: "schema",
            file: file.path,
            line: block.startLine,
            evidence: `Unknown schema name "${block.schemaName}" in fenced code-block annotation (registered: ${this.registry.names().join(", ") || "(none)"}).`,
            impact:
              "The schema annotation is present but the named schema is not in the adapter registry, so this block is NOT being validated. The annotation is silently inert.",
            requiredFix: `Use one of the registered schema names, OR register a new schema by extending \`STATIC_SCHEMAS\` in \`packages/cli/src/adapters/static-schema-lint.ts\`.`,
          });
          continue;
        }
        // Parse the block body. JSONC-friendly so `// ...` comments and
        // trailing commas don't trip JSON.parse on doc examples.
        let parsed: unknown;
        try {
          const normalized = stripJsoncSyntax(block.body);
          parsed = JSON.parse(normalized);
        } catch (err) {
          parseFailures++;
          findings.push({
            severity: "high",
            category: "schema",
            file: file.path,
            line: block.startLine,
            evidence: `Schema-annotated block (\`${block.schemaName}\`) is not parseable as JSON/JSONC: ${(err as Error).message}`,
            impact:
              "Doc examples that claim a schema MUST be valid JSON/JSONC against that schema; an unparseable block produces a silent regression for any consumer copy-pasting the example.",
            requiredFix:
              "Fix the syntax error in the code block, or remove the `// schema:` annotation if the block is intentionally illustrating malformed input.",
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
