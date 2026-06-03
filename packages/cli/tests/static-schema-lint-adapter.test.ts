// Consumer dark-factory-platform#107 — static-schema-lint adapter unit tests.
//
// Posture: the adapter is pure-deterministic (no SDK, no network, no LLM,
// no env). The tests cover four properties:
//
//   1. Identity + adapter contract:
//      - id === "static-schema-lint"
//      - requiredEnvVars === []
//
//   2. Code-block extraction:
//      - JSONC line-comment annotation (`// schema: name`) is recognized
//        and the marker line is stripped from the body so JSON.parse
//        succeeds.
//      - HTML-comment annotation immediately before a fence is recognized.
//      - Blocks without a recognized marker are NOT extracted (opt-in).
//
//   3. Schema validation:
//      - The consumer DFP #107 regression fixture (`effortLevel: "max"`
//        in a `~/.claude/settings.json` example) produces a `severity:
//        high` finding under the `claude-code-settings` schema.
//      - A valid example produces zero findings.
//      - An unknown schema name produces a `severity: medium` (non-
//        blocking) advisory finding.
//      - A schema-annotated block that fails to JSON-parse produces a
//        `severity: high` finding citing the parse error.
//
//   4. Verdict + summary:
//      - APPROVED when no findings of blocking severity surface.
//      - CHANGES_REQUESTED when at least one blocking-severity finding
//        surfaces.

import { test } from "vitest";
import {
  expect_eq,
  expect_truthy,
  expect_match,
} from "./_assert-shim.js";

import {
  STATIC_SCHEMA_LINT_ADAPTER_ID,
  StaticSchemaLintAdapter,
  extractSchemaBlocks,
  stripJsoncSyntax,
} from "../src/adapters/static-schema-lint.js";
import type {
  CriticConfig,
  ReviewPacket,
} from "@momentiq/dark-factory-schemas";

// ---------------------------------------------------------------------------
// Shared fixtures.

function makePacket(changedFiles: ReviewPacket["changedFiles"]): ReviewPacket {
  return {
    repoRoot: "/tmp/repo",
    branch: "main",
    commit: {
      sha: "abcdef0123456789abcdef0123456789abcdef01",
      parent: "0000000000000000000000000000000000000000",
      author: "test",
      email: "test@example.com",
      subject: "test commit",
      body: "",
      timestamp: "2026-06-02T00:00:00Z",
    },
    range: "0000..abcd",
    diffHash: "deadbeef",
    stat: "1 file changed",
    diff: "+ added line\n",
    diffTruncated: false,
    changedFiles,
    guidanceFiles: [],
    promptFragments: [],
    validation: {
      requiredQualityGates: [],
      optionalQualityGates: [],
      evidence: [],
      missing: [],
      stale: false,
    },
  };
}

const CRITIC: CriticConfig = {
  id: "schema-lint-chief-engineer",
  name: "Schema-Lint Critic",
  adapter: "static-schema-lint",
  required: false,
  runtime: "local",
  model: {
    id: "deterministic-1.0",
    params: [],
  },
};

const REVIEW_OPTIONS = {
  blockingSeverities: ["blocker", "high"] as const,
};

// ---------------------------------------------------------------------------
// Pure helpers.

test("stripJsoncSyntax strips line comments outside strings", () => {
  const out = stripJsoncSyntax('{ "model": "opus", // comment\n "x": 1 }');
  expect_truthy(!out.includes("comment"));
  // String contents are preserved (no over-stripping).
  expect_truthy(out.includes('"model": "opus"'));
});

test("stripJsoncSyntax preserves // inside string literals", () => {
  const out = stripJsoncSyntax('{ "url": "https://example.com/path" }');
  expect_truthy(out.includes("https://example.com/path"));
});

test("stripJsoncSyntax strips trailing commas before } or ]", () => {
  const out = stripJsoncSyntax('{ "a": 1, "b": 2, }');
  expect_truthy(JSON.parse(out).b === 2);
});

test("stripJsoncSyntax strips block comments", () => {
  const out = stripJsoncSyntax('{ /* note */ "a": 1 }');
  expect_truthy(!out.includes("note"));
  expect_truthy(JSON.parse(out).a === 1);
});

// ---------------------------------------------------------------------------
// Extraction.

test("extractSchemaBlocks picks up // schema: marker inside JSONC fence", () => {
  const source = [
    "# Header",
    "",
    "```jsonc",
    "// schema: claude-code-settings",
    '{ "model": "opus", "effortLevel": "max" }',
    "```",
    "",
  ].join("\n");
  const blocks = extractSchemaBlocks(source);
  expect_eq(blocks.length, 1);
  expect_eq(blocks[0]?.schemaName, "claude-code-settings");
  // The marker line is stripped so the body parses as JSON.
  expect_truthy(!blocks[0]!.body.includes("schema:"));
  const parsed = JSON.parse(stripJsoncSyntax(blocks[0]!.body));
  expect_eq(parsed.effortLevel, "max");
});

test("extractSchemaBlocks picks up HTML-comment annotation before a strict-JSON fence", () => {
  const source = [
    "<!-- schema: claude-code-settings -->",
    "```json",
    '{ "model": "opus", "effortLevel": "max" }',
    "```",
  ].join("\n");
  const blocks = extractSchemaBlocks(source);
  expect_eq(blocks.length, 1);
  expect_eq(blocks[0]?.schemaName, "claude-code-settings");
});

test("extractSchemaBlocks ignores fences without an annotation", () => {
  const source = [
    "Just a code block:",
    "```json",
    '{ "anything": 1 }',
    "```",
  ].join("\n");
  const blocks = extractSchemaBlocks(source);
  expect_eq(blocks.length, 0);
});

test("extractSchemaBlocks picks up multiple annotated blocks in one file", () => {
  const source = [
    "```jsonc",
    "// schema: claude-code-settings",
    '{ "effortLevel": "high" }',
    "```",
    "",
    "Some prose.",
    "",
    "```jsonc",
    "// schema: df-agent-review-config",
    '{ "version": 2 }',
    "```",
  ].join("\n");
  const blocks = extractSchemaBlocks(source);
  expect_eq(blocks.length, 2);
  expect_eq(blocks[0]?.schemaName, "claude-code-settings");
  expect_eq(blocks[1]?.schemaName, "df-agent-review-config");
});

// ---------------------------------------------------------------------------
// Adapter — the consumer DFP #107 regression fixture.

test("StaticSchemaLintAdapter blocks the consumer DFP #107 `effortLevel: \"max\"` example", async () => {
  const claudemdContent = [
    "# CLAUDE.md",
    "",
    "Recommended default:",
    "",
    "```jsonc",
    "// schema: claude-code-settings",
    '{ "model": "opus", "effortLevel": "max" }',
    "```",
  ].join("\n");
  const packet = makePacket([
    { path: "CLAUDE.md", status: "modified", content: claudemdContent },
  ]);
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  expect_truthy(result.findings.length >= 1);
  const f = result.findings[0]!;
  expect_eq(f.severity, "high");
  expect_eq(f.category, "schema");
  expect_eq(f.file, "CLAUDE.md");
  expect_match(f.evidence, /effortLevel/);
  // Surface the enum constraint in the evidence: the schema lists the
  // allowed `effortLevel` values; "max" is not among them.
  expect_match(f.evidence, /allowed/i);
  expect_match(f.evidence, /xhigh/);
});

test("StaticSchemaLintAdapter APPROVES a valid claude-code-settings example", async () => {
  const claudemdContent = [
    "# CLAUDE.md",
    "",
    "```jsonc",
    "// schema: claude-code-settings",
    '{ "model": "opus", "effortLevel": "xhigh" }',
    "```",
  ].join("\n");
  const packet = makePacket([
    { path: "CLAUDE.md", status: "modified", content: claudemdContent },
  ]);
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.status, "complete");
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.findings.length, 0);
});

test("StaticSchemaLintAdapter blocks on unknown schema names (typo guard)", async () => {
  // A typo'd annotation (e.g. `claude-code-setting` missing the trailing `s`)
  // would otherwise silently disable validation for the exact class of doc
  // examples this adapter is designed to gate. Promote the verdict to
  // CHANGES_REQUESTED so the typo surfaces instead of failing open.
  const claudemdContent = [
    "```jsonc",
    "// schema: never-registered-schema",
    '{ "anything": 1 }',
    "```",
  ].join("\n");
  const packet = makePacket([
    { path: "CLAUDE.md", status: "modified", content: claudemdContent },
  ]);
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  expect_eq(result.findings.length, 1);
  expect_eq(result.findings[0]?.severity, "high");
  expect_match(result.findings[0]?.evidence ?? "", /Unknown schema/);
});

test("StaticSchemaLintAdapter flags an unparseable schema-annotated block", async () => {
  const claudemdContent = [
    "```jsonc",
    "// schema: claude-code-settings",
    "{ not json at all }",
    "```",
  ].join("\n");
  const packet = makePacket([
    { path: "CLAUDE.md", status: "modified", content: claudemdContent },
  ]);
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  expect_eq(result.findings.length, 1);
  expect_eq(result.findings[0]?.severity, "high");
  expect_match(result.findings[0]?.evidence ?? "", /not parseable/);
});

test("StaticSchemaLintAdapter skips files outside the scanned-file patterns", async () => {
  const packet = makePacket([
    {
      path: "src/some.ts",
      status: "modified",
      content: "// schema: claude-code-settings\n// not actually a fenced block",
    },
  ]);
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.findings.length, 0);
});

test("StaticSchemaLintAdapter skips changed files that were omitted (binary, too-large)", async () => {
  const packet = makePacket([
    {
      path: "huge.md",
      status: "modified",
      omittedReason: "too_large",
    },
  ]);
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.findings.length, 0);
});

// ---------------------------------------------------------------------------
// Identity + doctor.

test("StaticSchemaLintAdapter.id is 'static-schema-lint'", () => {
  const adapter = new StaticSchemaLintAdapter();
  expect_eq(adapter.id, STATIC_SCHEMA_LINT_ADAPTER_ID);
  expect_eq(adapter.id, "static-schema-lint");
});

test("StaticSchemaLintAdapter.requiredEnvVars is []", () => {
  const adapter = new StaticSchemaLintAdapter();
  expect_eq(adapter.requiredEnvVars.length, 0);
});

test("StaticSchemaLintAdapter.doctor reports the registry compiled", async () => {
  const adapter = new StaticSchemaLintAdapter();
  const checks = await adapter.doctor(CRITIC);
  expect_truthy(checks.length >= 1);
  // Registry check exists and passes by default.
  const registryCheck = checks.find((c) => c.name === "static_schema_lint_registry");
  expect_truthy(registryCheck);
  expect_eq(registryCheck?.passed, true);
});

test("StaticSchemaLintAdapter accepts custom schemas via constructor option", async () => {
  const adapter = new StaticSchemaLintAdapter({
    schemas: {
      "custom-test-schema": {
        $id: "custom-test-schema",
        type: "object",
        required: ["mustBePresent"],
        properties: {
          mustBePresent: { type: "string" },
        },
      },
    },
  });
  const claudemdContent = [
    "```jsonc",
    "// schema: custom-test-schema",
    "{}",
    "```",
  ].join("\n");
  const packet = makePacket([
    { path: "CLAUDE.md", status: "modified", content: claudemdContent },
  ]);
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  expect_match(result.findings[0]?.evidence ?? "", /mustBePresent/);
});

test("StaticSchemaLintAdapter validates df-agent-review-config aggregation.policy enum", async () => {
  const docContent = [
    "```jsonc",
    "// schema: df-agent-review-config",
    "{",
    '  "version": 2,',
    '  "aggregation": {',
    '    "policy": "block-everything",',
    '    "blockingSeverities": ["blocker", "high"]',
    "  }",
    "}",
    "```",
  ].join("\n");
  const packet = makePacket([
    { path: "docs/example.md", status: "added", content: docContent },
  ]);
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  expect_truthy(result.findings.length >= 1);
  // Policy enum violation should be in the evidence.
  const hasPolicyFinding = result.findings.some((f) =>
    /aggregation.*policy|policy.*enum/i.test(f.evidence ?? ""),
  );
  expect_truthy(hasPolicyFinding);
});

test("StaticSchemaLintAdapter is deterministic across repeated runs", async () => {
  const claudemdContent = [
    "```jsonc",
    "// schema: claude-code-settings",
    '{ "model": "opus", "effortLevel": "max" }',
    "```",
  ].join("\n");
  const packet = makePacket([
    { path: "CLAUDE.md", status: "modified", content: claudemdContent },
  ]);
  const adapter = new StaticSchemaLintAdapter();
  const r1 = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  const r2 = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  // Verdict + findings must be byte-identical across runs (the whole
  // point of a deterministic critic is no flake / no calibration delta).
  expect_eq(r1.verdict, r2.verdict);
  expect_eq(r1.findings.length, r2.findings.length);
  expect_eq(r1.findings[0]?.evidence, r2.findings[0]?.evidence);
});

// ---------------------------------------------------------------------------
// String-aware JSONC stripping — trailing commas inside string literals.
//
// The trailing-comma removal step must not mutate commas that live inside
// JSON string values, or the validator runs against data that does not
// match the documented example.

test("stripJsoncSyntax preserves a comma-brace sequence inside a string literal", () => {
  const out = stripJsoncSyntax('{ "literal": ",}", "after": 1 }');
  const parsed = JSON.parse(out);
  expect_eq(parsed.literal, ",}");
  expect_eq(parsed.after, 1);
});

test("stripJsoncSyntax preserves a comma-bracket sequence inside a string literal", () => {
  const out = stripJsoncSyntax('{ "literal": ",]", "after": 1 }');
  const parsed = JSON.parse(out);
  expect_eq(parsed.literal, ",]");
  expect_eq(parsed.after, 1);
});

test("stripJsoncSyntax preserves escaped quotes inside strings", () => {
  const out = stripJsoncSyntax('{ "x": "a\\",}b" }');
  const parsed = JSON.parse(out);
  expect_eq(parsed.x, 'a",}b');
});

// ---------------------------------------------------------------------------
// YAML support — `# schema: <name>` annotation inside a YAML fence.

test("StaticSchemaLintAdapter validates YAML blocks annotated with # schema:", async () => {
  const docContent = [
    "```yaml",
    "# schema: claude-code-settings",
    "model: opus",
    'effortLevel: "max"',
    "```",
  ].join("\n");
  const packet = makePacket([
    { path: "CLAUDE.md", status: "modified", content: docContent },
  ]);
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  expect_truthy(result.findings.length >= 1);
  expect_eq(result.findings[0]?.severity, "high");
  expect_match(result.findings[0]?.evidence ?? "", /effortLevel/);
});

test("StaticSchemaLintAdapter APPROVES a valid YAML claude-code-settings example", async () => {
  const docContent = [
    "```yaml",
    "# schema: claude-code-settings",
    "model: opus",
    'effortLevel: "xhigh"',
    "```",
  ].join("\n");
  const packet = makePacket([
    { path: "CLAUDE.md", status: "modified", content: docContent },
  ]);
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.findings.length, 0);
});

// ---------------------------------------------------------------------------
// Diff-fallback path — adapter must surface findings even when file bodies
// were not loaded into the packet (e.g. consumer set
// `context.includeFullChangedFiles: false`). The packet still carries the
// unified diff; the adapter reconstructs added markdown content from the
// `+` lines so the DFP #107 regression fixture is caught end-to-end.

test("StaticSchemaLintAdapter falls back to packet.diff when file content is absent", async () => {
  // Simulates the production packet shape under
  // context.includeFullChangedFiles: false: changedFiles entry has no
  // `content`, but packet.diff includes the added markdown lines.
  const diff = [
    "diff --git a/CLAUDE.md b/CLAUDE.md",
    "index abc..def 100644",
    "--- a/CLAUDE.md",
    "+++ b/CLAUDE.md",
    "@@ -0,0 +1,5 @@",
    "+# CLAUDE.md",
    "+",
    "+```jsonc",
    "+// schema: claude-code-settings",
    '+{ "model": "opus", "effortLevel": "max" }',
    "+```",
    "",
  ].join("\n");
  const packet = makePacket([{ path: "CLAUDE.md", status: "modified" }]);
  packet.diff = diff;
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  expect_truthy(result.findings.length >= 1);
  const f = result.findings[0]!;
  expect_eq(f.severity, "high");
  expect_eq(f.file, "CLAUDE.md");
  expect_match(f.evidence, /effortLevel/);
});

test("StaticSchemaLintAdapter diff fallback ignores deletion-only hunks", async () => {
  // A REMOVED schema-annotated block (i.e. the consumer fixed the
  // violation) must not be reported as a new finding. Only `+` lines are
  // candidate content for fallback parsing.
  const diff = [
    "diff --git a/CLAUDE.md b/CLAUDE.md",
    "index abc..def 100644",
    "--- a/CLAUDE.md",
    "+++ b/CLAUDE.md",
    "@@ -1,5 +1,0 @@",
    "-```jsonc",
    "-// schema: claude-code-settings",
    '-{ "model": "opus", "effortLevel": "max" }',
    "-```",
    "",
  ].join("\n");
  const packet = makePacket([{ path: "CLAUDE.md", status: "modified" }]);
  packet.diff = diff;
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.findings.length, 0);
});

// codex critic #116 — modify-only-payload-line case. The PR edits only
// the payload line inside an existing annotated fenced block; the
// surrounding fence + `<!-- schema: ... -->` annotation are context
// lines. Without context preservation, the reconstructed body would be
// JUST the JSON payload — no fence, no annotation — and the gate would
// silently APPROVE the schema-invalid edit. With context preservation,
// extractSchemaBlocks sees the fence + annotation around the added line
// and the violation is caught.
test("StaticSchemaLintAdapter diff fallback catches in-place edits inside existing annotated blocks", async () => {
  const diff = [
    "diff --git a/CLAUDE.md b/CLAUDE.md",
    "index abc..def 100644",
    "--- a/CLAUDE.md",
    "+++ b/CLAUDE.md",
    "@@ -10,5 +10,5 @@ Some heading",
    " <!-- schema: claude-code-settings -->",
    " ```jsonc",
    " {",
    '-  "effortLevel": "high"',
    '+  "effortLevel": "max"',
    " }",
    " ```",
    "",
  ].join("\n");
  const packet = makePacket([{ path: "CLAUDE.md", status: "modified" }]);
  packet.diff = diff;
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  // Find the effortLevel finding (truncation guard is not active here —
  // packet.diffTruncated is false in makePacket()).
  const f = result.findings.find((x) => /effortLevel/.test(x.evidence));
  expect_truthy(f !== undefined);
  expect_eq(f!.severity, "high");
  expect_eq(f!.file, "CLAUDE.md");
});

// cursor critic #116 — diff-truncation guard. When the adapter relied on
// the diff-fallback path for any scanned file AND packet.diffTruncated is
// true, the adapter MUST emit a blocking-severity finding rather than
// silently APPROVE. The unified diff was cut by rebind.ts at
// DEFAULT_DIFF_BUDGET, so the adapter cannot prove the absence of
// violations in the truncated tail.
test("StaticSchemaLintAdapter emits blocking finding when diff fallback used AND diffTruncated", async () => {
  // A benign diff (no schema violations) that exercises ONLY the diff-
  // fallback path. With diffTruncated=true, the adapter must still
  // surface a blocking finding because the truncated tail is opaque.
  const diff = [
    "diff --git a/CLAUDE.md b/CLAUDE.md",
    "index abc..def 100644",
    "--- a/CLAUDE.md",
    "+++ b/CLAUDE.md",
    "@@ -0,0 +1,2 @@",
    "+# CLAUDE.md",
    "+(content not schema-annotated)",
    "",
  ].join("\n");
  const packet = makePacket([{ path: "CLAUDE.md", status: "modified" }]);
  packet.diff = diff;
  packet.diffTruncated = true;
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "CHANGES_REQUESTED");
  const f = result.findings.find((x) => /diffTruncated/.test(x.evidence));
  expect_truthy(f !== undefined);
  expect_eq(f!.severity, "high");
  expect_match(f!.requiredFix, /includeFullChangedFiles: true/);
});

// Companion: when packet.diff is truncated but the adapter did NOT use
// the fallback path (file.content present), there is no fail-open risk —
// the adapter saw the full file content directly. The truncation guard
// must NOT fire in that case.
test("StaticSchemaLintAdapter truncation guard quiet when file.content present", async () => {
  const goodContent = [
    "<!-- schema: claude-code-settings -->",
    "```jsonc",
    '{ "effortLevel": "high" }',
    "```",
  ].join("\n");
  const packet = makePacket([
    { path: "CLAUDE.md", status: "modified", content: goodContent },
  ]);
  packet.diff = "diff --git a/CLAUDE.md b/CLAUDE.md\n... [diff truncated]\n";
  packet.diffTruncated = true;
  const adapter = new StaticSchemaLintAdapter();
  const result = await adapter.review(packet, CRITIC, REVIEW_OPTIONS);
  expect_eq(result.verdict, "APPROVED");
  expect_eq(result.findings.length, 0);
});
