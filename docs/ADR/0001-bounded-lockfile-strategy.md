# ADR 0001 — Bounded lockfile strategy for the review packet

- **Status:** Proposed
- **Date:** 2026-06-01
- **Deciders:** DF critic fleet (cursor, codex, gemini, grok). PJ does not adjudicate this ADR — per his explicit directive, critic-fleet review is the gating mechanism for plan vetting.
- **Scope:** `packages/schemas/src/index.ts` (schema), `packages/cli/src/trusted-surface/rebind.ts` (packet builder), `packages/cli/src/prompt.ts` (prompt rendering), new `packages/cli/src/compact/` module, `packages/cli/src/evidence/audit-trail.ts` (one new telemetry event for the compacted-files counter — see § 4 risk mitigation + § 2.5). Out-of-scope: adapters, CLI subcommands, MCP tools, doctor/report, handoff, workflows.
- **Supersedes:** none
- **Issue:** [#67](https://github.com/momentiq-ai/dark-factory/issues/67)
- **Cycle:** 331.1

## 1. Context

The consumer-side codex SDK adapter deterministically overflows the
model context window when reviewing a commit whose unified diff
includes a large generated lockfile. The observed case in
`dark-factory-platform` Cycle 7 Phase 7.1 added ~5,032 lines to
`services/event-ingest/package-lock.json`. The 2-of-2 local quorum
(`cursor-local-chief-engineer` + `codex-local-chief-engineer`) returns
`quorum_unmet` because codex errors with `transport_error` before
posting a verdict, even though the cursor critic reviews the same diff
fine. Under `block-if-any`-with-required-codex this blocks the merge
queue; under `min-complete-quorum` 2-of-2 this surfaces the same
blocker as `aggregateReason: "quorum_unmet"`.

**Why this matters.** The current `commitDiff` path
(`packages/cli/src/git.ts:127`) returns the full `git diff --patch
parent..sha`. The review-packet builder
(`packages/cli/src/trusted-surface/rebind.ts:52`) then byte-budgets it
to `DEFAULT_DIFF_BUDGET = 1_500_000` and writes the **already-truncated
string** to `ReviewPacket.diff`. `diffHash` is computed from the
**pre-truncation** `fullDiff` (`rebind.ts:58`), so the audit hash is
always over the complete body even when `packet.diff` is truncated.

That cap is per-packet, not per-file, and the codex SDK's model has a
tighter ceiling than 1.5 MB — a single large lockfile diff defeats the
budget without triggering the truncation marker (truncation fires only
when the budget is exceeded; the lockfile may BE the entire budget).
Even when truncation fires, it removes evidence the critics need for
non-lockfile review. Worse, the lockfile body can ALSO re-enter the
prompt outside the `<diff>` section: `buildReviewPacket` reads each
changed file via `changedFiles()` (`rebind.ts:60`) with
`readContent: config.context.includeFullChangedFiles`; the prompt
builder then emits the file body in the `<file path="...">` block
(`prompt.ts:96-105`). Lockfiles that aren't flagged binary by `numstat`
land in the prompt twice: once as their per-file diff hunk, once as
their full body.

**Why consumer-side levers don't work.** Two in-repo workarounds were
investigated on the consumer (`dark-factory-platform`) and both were
ruled out:

1. **`tdd.classifier.exclusionGlobs`** is the schema's only path-glob
   array. It is consumed in exactly one place (`policy/gate.ts` →
   `policy/tdd-classifier.ts`) and feeds the TDD "needs test coverage"
   classifier only. It does NOT filter the diff fed to critics; adding
   `**/package-lock.json` is a no-op for overflow.
2. **`.gitattributes path -diff`** works mechanically: `git diff
   --patch` shells out (`git.ts:commitDiff`) and respects the
   attribute, so the lockfile collapses to `Binary files differ` in the
   patch fed to critics. `changedFiles()` also tags the file `binary`
   (`-` in `numstat`) and skips per-file content read, so
   `includeFullChangedFiles: true` doesn't re-inject. BUT the attribute
   is global: it strips the lockfile from every git diff surface (local
   `git diff`, human PR review on GitHub, npm-dep audit). In a repo
   where `npm ci --include=dev` from the committed lockfile is the
   determinism contract for the gate's own binaries and services,
   that's a supply-chain blind spot. The cursor and codex critics
   themselves blocked the consumer-side `-diff` PR on this — correctly.
   The brief's intent was critic-scoped ("codex stops overflowing");
   `-diff` delivers repo-global ("nobody sees lockfile diffs ever"),
   which is the wrong scope.

The CLI's `ContextConfig` (`@momentiq/dark-factory-schemas`) exposes no
diff-path-exclusion knob, so there's no narrower in-repo lever. This is
the upstream gap.

## 2. Decision

Introduce a **bounded lockfile strategy** in the review-packet builder.
The strategy detects well-known generated lockfiles by path and
replaces both the **per-file diff hunk** AND the **per-file full
content section** with a compacted representation that preserves the
security-relevant signal (per-package change set + integrity-hash
deltas) while keeping the byte budget under the model's context window.

The byte-truncated `ReviewPacket.diff` stays as-is (today's behavior
preserved) so downstream consumers that already handle truncation see
no regression. Critics receive the compacted form via new
`ReviewPacket.compactedDiff` and per-file `compactedContent` surfaces
that adapters consult when present. `diffHash` is unchanged: it
continues to hash the **pre-truncation, pre-compaction** `fullDiff`
returned by `commitDiff`, so cache-invalidation identity is stable.

The strategy is opt-in at v1 ship (absent config → identical to today)
and per-glob-overridable. A future cycle promotes it to opt-out (a
documented default) after external-consumer dogfood.

### 2.1 Where the change lands

| Layer | Module | Change |
|---|---|---|
| Schema | `packages/schemas/src/index.ts` | New optional `generatedFilePolicy` block on `ContextConfig`; parser branch in `parseAgentReviewConfig`. New optional `compactedDiff` and `parseErrorPaths` fields on `ReviewPacket`; new optional `compactedContent` field on `ChangedFile`. |
| Compactor | `packages/cli/src/compact/lockfile.ts` (new) | Pure per-lockfile compactor functions, dispatched by glob match. Per-file diff body → `CompactedLockfileDelta` struct → rendered as a stable text stub. Same struct also renders a content-section stub (for `compactedContent` on `ChangedFile`). Both renderers honor their own byte caps and emit a `[DF-COMPACT TRUNCATED …]` marker on overflow (§ 2.4 caps). |
| Packet builder | `packages/cli/src/trusted-surface/rebind.ts` | When **any path** has an effective mode `!== "full"` (per the resolver in § 2.2.1), walk the **untruncated** `fullDiff` from `commitDiff()`, route matched per-file sections through the compactor, splice the rendered stub back in, THEN apply `DEFAULT_DIFF_BUDGET` byte-cap to the result and write to `ReviewPacket.compactedDiff` (capped). For matched paths, also write `compactedContent` on the `ChangedFile` (capped at `MAX_COMPACTED_CONTENT_BYTES`) and clear `content`. `ReviewPacket.diff` continues to hold the truncated-from-`fullDiff` body (today's shape, today's budget) — but `compactedDiff` is what the prompt reads, so compaction runs BEFORE budget truncation and the prompt budget no longer gets eaten by raw lockfile bodies (this is the core fix; see § 2.4). |
| Prompt builder | `packages/cli/src/prompt.ts` | When `packet.compactedDiff !== undefined`, the `<diff>` section uses it. For each changed file, the `<file>` block uses `file.compactedContent` when present, else `file.content`. The `[DIFF WAS TRUNCATED]` marker stays scoped to `diffTruncated`; a new `[DF-COMPACT PARSE-ERROR …]` marker fires for `parseErrorPaths` (§ 2.3.4); a new `[DF-COMPACT TRUNCATED …]` marker fires when the compacted form itself exceeds its cap (§ 2.4). |
| Telemetry | `packages/cli/src/evidence/audit-trail.ts` | One new `TelemetryEvent.event` enum value: `"compacted_files"`. Emitted once per `runReview` when the strategy fires; carries `perFileCounts: string` (JSON-stringified `{path: lockfileKind}` map, mirroring the cycle-332 perFileCounts convention) + `findingCount` repurposed as compacted-paths-count for greppability. Without this event, operators cannot detect a glob-miss regression at v1. |
| Audit / cache | `packages/cli/src/git.ts` (`commitDiff` callers) | Untouched. `diffHash` continues to hash the **pre-truncation, pre-compaction `fullDiff`** so cache invalidation is stable across policy toggles AND budget truncation (today's behavior, preserved). |

#### 2.1.1 Pipeline order (load-bearing — see codex round-2 blocker)

The order of operations matters: compaction must operate on the
**untruncated** `fullDiff`, then the byte-cap applies. Otherwise a
large lockfile early in the diff consumes the budget before later
source-file hunks land in `packet.diff`, and compacting after the cut
cannot restore those lost source-file hunks (the data is already
gone). The corrected pipeline:

```
commitDiff(parent, sha)           # untruncated fullDiff
   │
   ├── diffHash = sha256(fullDiff)  # audit hash over untruncated body
   │
   ├── packet.diff = truncate(fullDiff, DEFAULT_DIFF_BUDGET)
   │     # back-compat surface: today's shape, today's budget
   │     # — present for downstream consumers that already handle truncation
   │     # — NOT what the prompt reads when compactedDiff is set
   │
   └── compactedFullDiff = walkAndCompact(fullDiff, globPolicy)
         # compaction runs on the UNTRUNCATED fullDiff so lockfile
         # hunks shrink BEFORE the byte budget bites. Result is the
         # full diff with matched-lockfile sections replaced by stubs.
         │
         └── packet.compactedDiff = truncate(compactedFullDiff,
                                             DEFAULT_DIFF_BUDGET)
               # cap applies to the post-compaction view. In the
               # observed Cycle 7 Phase 7.1 case (5,032 added lines
               # of package-lock.json ≈ 320 KB), the lockfile section
               # shrinks to ~2 KB of stub. Source-file hunks that
               # previously overflowed the 1.5 MB budget now fit.
```

Same pattern for `ChangedFile.compactedContent`: the compactor reads
the **untruncated** file content from `gitShowFile()` (already the
case via `changedFiles()` with `readContent: true`) and renders the
stub with its own per-file cap; the resulting stub goes into
`compactedContent` and `file.content` is cleared.

### 2.2 Config schema sketch — `context.generatedFilePolicy`

Add an optional block to `ContextConfig`:

```ts
export type GeneratedFileMode = "full" | "compact" | "omit";
export type OnParseErrorMode = "refuse-and-block" | "compact-with-warning";

export interface GeneratedFileGlobOverride {
  glob: string;             // matched via packages/cli/src/glob.ts compileGlob
  mode: GeneratedFileMode;  // overrides the policy-level default for this glob
}

export interface GeneratedFilePolicy {
  // Default for any path matched by `globs[]` (effective set defined
  // below). "full" means the strategy is a no-op (current behavior);
  // "compact" emits a stub built by the per-lockfile compactor;
  // "omit" emits a minimal "<path> diff omitted by policy" marker.
  mode: GeneratedFileMode;

  // Path globs that activate the strategy. OPTIONAL: when omitted, the
  // CLI substitutes `DEFAULT_GENERATED_LOCKFILE_GLOBS` (a stable
  // exported constant covering npm/pnpm/yarn lockfiles). When provided,
  // the explicit list fully replaces the defaults — there is no merge.
  // Operators who want defaults-plus-extra glob both the defaults and
  // their extras explicitly; this avoids the silent-superset foot-gun
  // where the default list changes between CLI versions. The parser
  // accepts an omitted `globs` (no defaults substituted at parse time)
  // OR a non-empty array; an explicitly empty `globs: []` is rejected.
  globs?: string[];

  // Per-glob overrides for finer-grained control. Earliest match wins.
  // Override globs do NOT need to be in `globs[]` (overrides can carve
  // a finer slice OR add a new path). Useful for:
  // - omitting a single oversized service's lockfile while compacting
  //   the rest
  // - opting one specific generated file into compact while leaving
  //   the policy default at "full"
  overrides?: GeneratedFileGlobOverride[];

  // What to do when the per-format extractor cannot parse a matched
  // lockfile's diff section. Default `"refuse-and-block"` populates
  // `ReviewPacket.parseErrorPaths`, emits a top-of-diff parse-error
  // marker the critic prompt routes through the "treat as missing
  // evidence" branch, and renders a structured parse-error stub in
  // place of the body. The `"compact-with-warning"` opt-out emits ONLY
  // the parse-error stub (no synthetic injection, no prompt marker) —
  // for operators who knowingly accept the trade-off. See § 2.3.4.
  onParseError?: OnParseErrorMode;
}

export interface ContextConfig {
  guidanceFiles: string[];
  promptFragments: string[];
  maxChangedFileBytes: number;
  includeFullChangedFiles: boolean;
  // NEW — optional. Absent → behavior identical to today (full diff fed
  // to critics; no compactedDiff/compactedContent/parseErrorPaths fields
  // on the packet).
  generatedFilePolicy?: GeneratedFilePolicy;
}
```

**Default shipped glob list** (exported from the CLI as
`DEFAULT_GENERATED_LOCKFILE_GLOBS`; substituted at packet-build time
when `generatedFilePolicy.globs` is omitted):

```
**/package-lock.json
**/npm-shrinkwrap.json
**/pnpm-lock.yaml
**/yarn.lock
```

**Parser validation rules** (added to `parseAgentReviewConfig` in
`schemas/src/index.ts`):

1. `mode` is required when the block is present; must be one of
   `"full" | "compact" | "omit"`.
2. `globs`, when present, is a non-empty array of non-empty strings;
   duplicates rejected (a duplicate glob string is a foot-gun —
   operators usually meant different `mode`s in `overrides`). When
   absent, the CLI's `DEFAULT_GENERATED_LOCKFILE_GLOBS` constant is
   the effective list at packet-build time (the schema package itself
   does NOT substitute defaults; it stays dependency-free and the
   default constant lives in the CLI).
3. `overrides[]` entries: `glob` non-empty string, `mode` one of the
   three values; duplicate override `glob` rejected.
4. `onParseError`, when present, must be one of
   `"refuse-and-block" | "compact-with-warning"`; default
   `"refuse-and-block"` is applied at the packet-build site, not by
   the parser (parser preserves absence as `undefined`).
5. Schema parser does NOT compile the glob (compilation lives in the
   CLI's `glob.ts` module; the schema package stays dependency-free).
   Invalid glob syntax surfaces at first use, not at config load. This
   matches the existing convention for `tdd.classifier.exclusionGlobs`
   and `validation.verificationRoutes[].trigger`.

**Opt-in / opt-out semantics — explicit:**

- v1 (this PR): the entire `generatedFilePolicy` block is **optional**.
  Absent → the packet builder takes the unchanged path (no compaction,
  no `compactedDiff`, no `compactedContent`, no `parseErrorPaths`).
  This is the back-compat-safe default; nothing in any existing
  consumer breaks silently. The word "opt-in" applies to v1 strictly.
- Future cycle: promotes default to `mode: "compact"` with the default
  globs once external consumers (`taxpilot2a`, `lyra`) have run with
  it for ≥ 1 week without regression. That promotion is a separate
  ADR amendment + version bump and is NOT part of this ADR's
  acceptance.

#### 2.2.1 Effective-mode resolution per path

The packet builder must compute the **effective mode** for every
matched path, because overrides can compose non-trivially with the
top-level mode (e.g., `mode: "full"` + an override that opts ONE
specific lockfile into `compact`). The resolver is:

```
function effectiveMode(path, policy):
  # 1. Check overrides in declaration order; earliest match wins.
  for override in (policy.overrides ?? []):
      if matchGlob(path, override.glob):
          return override.mode

  # 2. Otherwise, if the path matches any glob in the effective
  #    globs list, return the policy-level mode.
  effectiveGlobs = policy.globs ?? DEFAULT_GENERATED_LOCKFILE_GLOBS
  for glob in effectiveGlobs:
      if matchGlob(path, glob):
          return policy.mode

  # 3. Unmatched path. Effective mode is implicit "full" — no
  #    compaction occurs for this path.
  return "full"
```

Key properties:

- **Override precedence is strictly per-path.** An override of
  `mode: "compact"` on `**/services/event-ingest/package-lock.json`
  fires for that one file even when `policy.mode === "full"`. This
  matches the documented use case "opt one specific file into compact
  while leaving the default at full."
- **The packet builder triggers compaction whenever ANY path has
  effective mode `!== "full"`.** Concretely, the "should we walk the
  diff and emit `compactedDiff`?" question becomes
  `someChangedFile(file => effectiveMode(file.path, policy) !== "full")`,
  NOT `policy.mode !== "full"`. This is the fix for the codex
  round-2 contracts finding: the top-level mode guard would have
  silently no-op'd the documented override contract.
- **The `omit` effective mode is honored per-path.** A path with
  effective mode `omit` renders the omit-marker stub regardless of
  the top-level mode (and the per-file `compactedContent` follows
  the same rule).
- **Unmatched paths are unaffected.** The diff section for an
  unmatched changed file is copied through verbatim from `fullDiff`.

### 2.3 Compaction format spec

The per-lockfile compactor produces a stable text stub from the
per-file unified-diff section AND from the per-file full content. The
stub is parseable by humans (so the PR-review surface stays
informative) and re-parseable by a downstream gate that wants to
assert on the deltas without re-running git. The stub format is
version-tagged so future compactor revisions don't silently break
consumers that grep the rendered text.

#### 2.3.1 Diff-section stub (rendered into `compactedDiff` in lieu of the patch hunks)

```
diff --git a/<path> b/<path>
[DF-COMPACT v1 <lockfile-kind>]
files:
  - +<added-lines> -<removed-lines> patch-sha256: <hex>
packages:
  + <packageName>@<version> integrity=<integrity-or-"unknown">
  - <packageName>@<oldVersion>
  ~ <packageName> <oldVersion> → <newVersion>  (integrity: <oldHash> → <newHash>)
[DF-COMPACT end]
```

#### 2.3.2 Content-section stub (rendered into `ChangedFile.compactedContent`)

```
[DF-COMPACT v1 <lockfile-kind> full-content omitted]
files:
  - bytes: <bytes>
  - content-sha256: <hex>
packages-after:
  - <packageName>@<version> integrity=<integrity-or-"unknown">
  ...
```

The content stub differs from the diff stub: it lists the
post-commit state (`packages-after`), not the delta. A critic reading
the content stub sees "this lockfile now declares 487 packages
including these N new ones since the parent." This preserves the
detection signal for a malicious-package-pinning attack the same way
the live lockfile body would.

Constraints (apply to both stubs):

- `lockfile-kind` is one of `npm`, `pnpm`, `yarn`. Future kinds extend
  the enum.
- `patch-sha256` (diff stub) is `sha256(unifiedDiffSection)`;
  `content-sha256` (content stub) is `sha256(fileContent)`. Both let
  a later auditor cross-check that the rendered stub corresponds to
  the omitted body. This is the audit trail the consumer-side `-diff`
  workaround destroys.
- Package lines are sorted by `<packageName>` then by `+ / - / ~`
  category for deterministic output (matters for compactedDiff
  reproducibility tests + finding-cache stability).
- A lockfile with zero parseable per-package deltas (e.g., only a
  top-level `lockfileVersion` bump) renders a single
  `notes: lockfile-metadata-only` line instead of an empty `packages:`
  block.

#### 2.3.3 Per-lockfile-kind extraction

Each kind has its own extractor that turns a per-file unified-diff
section into a `CompactedLockfileDelta`:

```ts
export interface CompactedPackageDelta {
  kind: "add" | "remove" | "upgrade";
  name: string;
  version?: string;          // present for add
  oldVersion?: string;       // present for remove / upgrade
  newVersion?: string;       // present for upgrade
  integrity?: string;        // present for add / upgrade (when parseable)
  oldIntegrity?: string;     // present for upgrade
}

export interface CompactedLockfileDelta {
  path: string;
  lockfileKind: "npm" | "pnpm" | "yarn";
  addedLines: number;        // from numstat for this path
  removedLines: number;
  patchSha256: string;       // sha256 of the original per-file unified-diff section
  packages: CompactedPackageDelta[];
  parseError?: string;       // populated when the extractor refused to parse;
                             // see § 2.3.4 — refusal is a HARD ERROR by default
  notes?: string[];          // freeform machine-readable notes
                             // ("lockfile-metadata-only", "parse-error-fallback-omit")
}
```

**npm `package-lock.json`** — extractor walks the unified diff's `+` /
`-` lines inside the `"packages"` block. Each entry is keyed by the
JSON path (e.g. `"node_modules/foo"`); the extractor pairs `+` /
`-` blocks by key to detect `upgrade` (both present), `add` (only `+`),
or `remove` (only `-`). `name` derives from the key suffix; `version` /
`integrity` come from the JSON object fields. The extractor must
tolerate workspace package entries (`""` and `"packages/<name>"`),
which encode the workspace itself rather than a third-party dep.

**pnpm `pnpm-lock.yaml`** — extractor walks the top-level `packages:`
YAML map. Each entry's key is `/<name>@<version>` (or `/<name>@<version>(peer-spec)`);
the extractor extracts `name` and `version` from the key, and reads
`integrity:` from the entry body. Pair `+` / `-` blocks by name to
detect upgrade vs. add vs. remove.

**yarn `yarn.lock`** — extractor walks top-level entries that match
`^<name>@.*?:` (yarn's "spec" line). Each entry has a `version` line
and a `resolved` / `integrity` line in its body. Pair `+` / `-` blocks
by name.

**Out-of-scope kinds** (cargo, gemfile, go.sum, requirements.txt, etc.)
are NOT shipped in v1. The default glob list omits them; v2 will
register additional kinds.

#### 2.3.4 Parse-error handling — refuse-and-block by default

If the extractor cannot parse the per-file diff (malformed shape,
unknown lockfile-kind for an explicitly-globbed path, etc.), it
populates `parseError` and the renderer emits a structured
**parse-error stub** wrapped in `[DF-COMPACT v1 PARSE-ERROR]`
sentinels with the raw `patchSha256` and the extractor's error
message inline.

**By default** (`onParseError: "refuse-and-block"`), the packet builder
treats a parse-error stub as a **load-bearing condition**:

- The packet builder writes the parse-error stub to
  `compactedDiff` / `compactedContent` (transparent — critics see it).
- AND the packet builder appends the affected path to
  `ReviewPacket.parseErrorPaths`
  (NEW — optional, omitted when no parse errors occurred).
- AND `prompt.ts` adds a fixed `[DF-COMPACT PARSE-ERROR — treat as
  missing evidence]` line at the top of the `<diff>` section listing
  the affected paths. The line uses the SAME language as the existing
  `[DIFF WAS TRUNCATED — treat missing context as a validation gap]`
  marker so critics route it through the same "missing evidence ⇒
  CHANGES_REQUESTED" branch they already follow.

Operators who want to opt out of refuse-and-block (e.g., dogfood
ramp-up where parse errors are noisy) set
`generatedFilePolicy.onParseError: "compact-with-warning"`. The
`"compact-with-warning"` mode emits the parse-error stub without the
synthetic `parseErrorPaths` injection or the prompt marker — i.e.,
today's documented (and previously rejected) `parse-error-fallback-omit`
semantics, but now an explicit opt-out rather than the silent default.

This closes the security blind-spot codex flagged: a parse error
cannot silently hide a dependency injection. The supply-chain audit
signal is preserved-by-default, with an explicit opt-out for the small
set of operators who knowingly accept the trade-off.

### 2.4 Diff surfaces — explicit field contract + byte caps

#### 2.4.1 Byte caps on the compacted surfaces

A bounded strategy needs an explicit upper bound on every
prompt-rendered surface, otherwise a sufficiently large dependency
graph reintroduces overflow through the new `compactedContent` field
(codex round-2 performance blocker). The caps are CLI-side constants
exported alongside the default-globs constant so consumers can
inspect them:

| Constant | Value (v1) | Applies to | Rationale |
|---|---|---|---|
| `DEFAULT_DIFF_BUDGET` | 1,500,000 bytes | `packet.diff` AND `packet.compactedDiff` (post-compaction cap) | Today's value; unchanged. After compaction shrinks lockfile sections, this cap rarely fires in the observed Cycle 7 case (5,032 lines → ~2 KB stub). |
| `MAX_COMPACTED_DIFF_BYTES` | 250,000 bytes | `packet.compactedDiff` (an EARLIER cap than `DEFAULT_DIFF_BUDGET`) | Even after compaction, a diff with hundreds of compacted lockfiles (mono-repo scenario) could still exceed the model context window. 250KB ≈ 60K tokens, leaving headroom below the smallest critic context window (gpt-5.5-nano: ~100K tokens). When this cap is hit, the diff is truncated and the `[DF-COMPACT TRUNCATED — N more lockfile sections elided]` marker fires inline at the truncation point. |
| `MAX_COMPACTED_CONTENT_BYTES` | 50,000 bytes | each `ChangedFile.compactedContent` | A single lockfile with 5,000+ packages (rare but possible for a workspace root in a large monorepo) renders a packages-after stub that could itself be 100KB+. 50KB per file is a soft ceiling; when exceeded, the stub truncates the `packages-after:` list with a `[DF-COMPACT TRUNCATED — N more packages elided]` marker and `content-sha256` still hashes the full content so audit recovery remains possible. |

The numbers above are starting points; PR 2 verifies them against
real fixture diffs. If empirical data on the Cycle 7 lockfile shows
the 250KB / 50KB caps fire spuriously on legitimate diffs, PR 2 may
raise them (with the new values documented inline in the same
constant block). Per the cycle-doc verifiability rule, the values
that actually ship in PR 2 are the values that pass the test plan in
§ 5.2 — those tests assert exact-byte equality against fixture
inputs, so a value-change requires a deliberate test-fixture
re-baseline.

After this change, the review packet exposes:

- **`ReviewPacket.diff`** — the unified diff after the existing
  `DEFAULT_DIFF_BUDGET` byte-cap. **This is unchanged from today.**
  When the underlying patch exceeds the budget, `diffTruncated: true`
  and the trailing characters are removed exactly as today. **This
  field is not a full-audit source by itself** — for an audit-grade
  reconstruction, consumers must recompute from `commitDiff(parent,
  sha)` directly (or trust `diffHash`, which IS over the pre-truncation
  body).
- **`ReviewPacket.diffHash`** — `sha256:<hex>` over the **untruncated,
  uncompacted** `fullDiff` returned by `commitDiff`. This is the
  cache-invalidation key; it is stable across policy toggles AND
  across budget truncation. Compaction never affects `diffHash`.
- **`ReviewPacket.compactedDiff`** — optional. Present only when at
  least one matched path has an effective mode `!== "full"` (§ 2.2.1)
  AND that path appears in the diff. When present, the prompt
  builder uses this string for the `<diff>` section instead of
  `packet.diff`. Built FROM the **untruncated** `fullDiff` returned
  by `commitDiff()` (§ 2.1.1 pipeline order), with the post-compaction
  result then byte-capped at `MAX_COMPACTED_DIFF_BYTES` (or
  `DEFAULT_DIFF_BUDGET`, whichever fires first — see § 2.4.1 caps).
  This is the load-bearing fix from the codex round-2 contracts
  blocker: compaction operates on the untruncated body so source-file
  hunks that previously overflowed the per-packet budget now fit
  after lockfile sections collapse to stubs.
- **`ReviewPacket.diffTruncated`** — unchanged. Mutually compatible
  with `compactedDiff` being present (a diff can be both truncated AND
  have a compacted lockfile section).
- **`ChangedFile.compactedContent`** — optional. Present only for
  paths whose effective mode (§ 2.2.1) is `!== "full"`. When present,
  the prompt's `<file>` block uses this stub instead of `file.content`,
  AND `file.content` is cleared on the packet (so a downstream
  consumer that JSON-stringifies the packet doesn't accidentally
  serialize both forms). The stub itself is byte-capped at
  `MAX_COMPACTED_CONTENT_BYTES` (§ 2.4.1).
- **`ReviewPacket.parseErrorPaths`** — optional (§ 2.3.4). Present
  only when at least one matched lockfile failed extractor parsing
  AND the policy mode is the default `"refuse-and-block"`.

Adapters consume the packet through `prompt.ts:compileCriticPrompt`,
which is the single rendering point. The prompt-side change covers two
spots:

```ts
// In the <diff> section:
const diffForPrompt = packet.compactedDiff ?? packet.diff;
sections.push(escapeUntrusted(diffForPrompt));

// In each <file> block:
const contentForPrompt = file.compactedContent ?? file.content ?? "";
```

No adapter needs a code change; the compaction is transparent to the
adapter surface.

### 2.5 Observability — v1 telemetry surface

Codex flagged that the round-1 risk table referenced a doctor
subcommand warning even though `doctor.ts` is out-of-scope per § 1.
The v1 observability is narrower: one new telemetry event in the
existing `_runs.ndjson` audit log, emitted by the packet builder via
the runner's `TelemetrySink`.

New event in `TelemetryEvent.event` union:

- **`compacted_files`** — emitted once per `runReview()` invocation
  when the strategy fires (at least one path has effective mode
  `!== "full"` AND the compaction step ran). Payload uses the
  existing `TelemetryEvent` field shape:
  - `findingCount`: count of paths the compactor processed
    (re-use of the existing field for greppability; semantically
    "compacted-paths-count" here)
  - `perFileCounts`: JSON-stringified `{ path: lockfileKind }` map
    (mirrors the cycle-332 `perFileCounts` convention — flat
    stringification keeps NDJSON greppable; values are the kind
    enum, not byte counts, since the byte-count question is
    answered by `findingCount` + the stub format).
  - `commit`: the SHA under review (existing field).

Operators detect a glob-miss regression by grepping `_runs.ndjson`
for `event=compacted_files` and confirming the expected paths
appear in `perFileCounts`. A missing-path-count outside an expected
window (e.g., a PR known to touch a lockfile but the event lists
zero paths) is the actionable signal.

A richer observability story (doctor warnings, per-extractor parse
error counters, dashboarding) is a follow-up and is OUT of v1 scope.
The risk-table mitigation in § 4 is now sized to what v1 actually
ships: a single telemetry counter, not a doctor warning.

## 3. Alternatives considered

### 3.1 Consumer-side `.gitattributes path -diff` — rejected

See § 1. Repo-global scope; destroys the supply-chain audit signal;
the cursor + codex critics correctly blocked the abandoned PR on this.

### 3.2 Repo-global per-file diff truncation knob (`maxFileDiffBytes`)
— orthogonal, not rejected

A per-file truncation knob would help on non-lockfile generated
artifacts (compiled grammars, generated SQL migrations) by truncating
each file's diff section at N bytes. This ADR's strategy is
complementary: lockfile compaction preserves the package-delta signal
that flat truncation destroys. Both can ship; the per-file truncation
knob is tracked separately (issue follow-up) and is NOT in this PR.

### 3.3 Strip lockfiles entirely (`mode: "omit"` as default) — rejected

`omit` is a valid mode but a bad default. The "added 5 dependencies
including suspicious-package@9.9.9" signal is exactly what the codex
critic catches today on lockfile diffs that don't overflow the window.
Compact preserves that signal at ~1% of the byte cost; omit drops it.

### 3.4 Adapter-scoped diff override — rejected

A `CriticConfig.diffMode = "compact"` field could let the consumer
keep the full diff for cursor while compacting for codex. Rejected as
overfit to the current 2-of-2 vendor mix: every critic adapter we
ship benefits from the bounded form on a 5,000-line lockfile diff
(cursor's prompt-token budget is also finite). The right scope is
packet-level. If a future critic genuinely needs the full body, we can
add `criticConfig.contextOverride.diffSource: "full"` at that time.

### 3.5 Move the policy off `context.*` onto a top-level
`reviewPacket.*` block — rejected for v1

The `context` block is already the home for packet-shaping knobs
(`maxChangedFileBytes`, `includeFullChangedFiles`); adding
`generatedFilePolicy` here keeps related concerns adjacent. A
larger reshape into `reviewPacket.*` may make sense later but pulls
the schema migration story in, which is out of scope for this fix.

### 3.6 Silent parse-error-fallback-omit — rejected (codex finding)

The original draft of this ADR proposed that an extractor parse error
silently downgraded the file to `mode: "omit"` with a
`parse-error-fallback-omit` note. Codex flagged that this recreates
the supply-chain blind spot the ADR rejects for `.gitattributes
-diff`, only scoped to parser failures. § 2.3.4 reverses the
proposal: parse errors are load-bearing by default (refuse-and-block),
with an explicit `onParseError: "compact-with-warning"` opt-out for
operators who knowingly accept the trade-off.

### 3.7 Default-merging `globs[]` with `DEFAULT_GENERATED_LOCKFILE_GLOBS`
— rejected

An earlier draft implied that when `globs[]` is provided, the CLI
unions it with the shipped defaults. Rejected because the default
list will grow (cargo, go, etc.) over CLI versions, and silently
expanding an operator's match set on `npm install -g …` is a surprise
vector. The rule is: `globs[]` provided → exact-match (CLI uses ONLY
what the operator wrote). `globs[]` omitted →
CLI uses `DEFAULT_GENERATED_LOCKFILE_GLOBS`. Operators wanting
"defaults plus extras" must glob both explicitly.

### 3.8 Diff-only compaction (leave the `<file>` content block alone)
— rejected (codex round-1 finding)

The original draft scoped compaction to the `<diff>` section only,
overlooking that `context.includeFullChangedFiles: true` causes the
prompt builder to ALSO emit each changed file's full body in a
`<file>` block. A lockfile that's compacted in the `<diff>` would
still appear in full inside `<file>` and the overflow returns. The
strategy must (and now does) apply to both surfaces: matched
lockfiles get `compactedContent` set on the `ChangedFile`, and
`file.content` is cleared so the prompt renders only the compacted
form. The integration test plan (§ 5.2 #7) explicitly asserts the raw
lockfile body appears in NEITHER section.

### 3.9 Compact-after-truncate (operate on the already-budgeted
`packet.diff`) — rejected (codex round-2 finding)

The round-1 draft of this ADR specified that compaction operates on
`packet.diff` (the already-byte-truncated string). Codex flagged that
this defeats the strategy: if a large lockfile early in the diff
consumes the budget before later source files land, compacting the
already-truncated string cannot restore those source files. § 2.1.1
reverses the order: compaction operates on the **untruncated**
`fullDiff` from `commitDiff()`, then the budget cap applies to the
post-compaction view. The cycle 7 case (lockfile = ~320 KB raw, ~2 KB
stub) demonstrates the win: source-file hunks that previously
overflowed now fit.

### 3.10 No explicit cap on `compactedContent` (rely on the natural
size of post-commit lockfile state) — rejected (codex round-2 finding)

The round-1 draft defined the content-section stub
(`packages-after:` list) with no upper bound. Codex correctly
identified that a repo with thousands of dependencies still produces a
huge stub. § 2.4.1 adds explicit byte caps (`MAX_COMPACTED_DIFF_BYTES`
and `MAX_COMPACTED_CONTENT_BYTES`) with overflow markers, and the
test plan (§ 5.2 #10) asserts they fire when expected.

### 3.11 Doctor-warning mitigation for glob-miss regressions —
rejected (codex round-2 observability finding)

The round-1 draft referenced a Doctor subcommand warning that would
fire on suspected glob misses. § 1 marks doctor/report out of scope,
making the round-1 mitigation hand-wavy. § 2.5 reverses: the v1
observability is one telemetry event (`compacted_files`) on
`_runs.ndjson`, scoped to what audit-trail.ts can ship in PR 2. A
follow-up cycle may extend doctor with the same signal once doctor.ts
returns to scope.

## 4. Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Compactor misreads a lockfile entry → critic gets wrong package-delta info | Medium (first ship of per-format extractors) | High (could mask a malicious dep injection) | (a) Refuse-and-block is the default on parse errors (§ 2.3.4); critics see the parse-error stub AND a top-of-diff marker AND the synthetic `parseErrorPaths` array; (b) `patch-sha256` / `content-sha256` in the stub lets a later auditor recover the original; (c) `ReviewPacket.diff` retains the budget-truncated body so a follow-up critic pass with `mode: "full"` can re-verify (within budget). |
| Glob match too narrow → real lockfile slips through and overflow returns | Low (default globs cover npm/pnpm/yarn) | High (regression to current state) | Telemetry: emit a `compacted_files` event on each `runReview` where the strategy fires (§ 2.5). Operators grep `_runs.ndjson` for the event + `perFileCounts` payload to confirm expected paths were compacted. Doctor warnings are explicitly OUT of v1 scope (codex round-2 observability finding); the v1 mitigation is the audit-log event only. |
| Compactor's stub format collides with a critic's existing finding shape | Low | Medium | Sentinel `[DF-COMPACT v1 <kind>]` / `[DF-COMPACT end]` brackets; format version-tagged. |
| `diffHash` keys the cache off the **pre-truncation full diff** but the prompt uses compactedDiff → cache hits that no longer correspond to the body shown to the critic | Low (compaction is purely a derived view) | Low | The cache key is the *review input*, which is bounded by `diffHash` + critic id + content hashes of the changed files (cycle 332 finding cache). A second derived view doesn't change the input identity. Cycle 332 finding-cache's `configHash` already covers config-shape changes — when `generatedFilePolicy` toggles, `configHash` shifts and the cache invalidates. Integration test in § 5.2 #8 verifies. |
| `includeFullChangedFiles: true` re-injects the lockfile body outside the `<diff>` section | High (this is the symptom codex flagged) | High | The strategy also applies to `ChangedFile.compactedContent` (§ 2.1, § 2.4, § 3.8). Tests in § 5.2 #7 specifically assert that for a matched lockfile, neither the `<diff>` section nor the `<file>` block contains the raw lockfile body. |
| Compaction changes critic verdicts in a way that re-opens recently-closed findings | Medium (rollout window) | Medium | Opt-in at v1 (§ 2.2). When promoted to a default in a follow-up cycle, the on-disk policy remains a single field; emergency revert is a one-line PR back to `mode: "full"`. |
| Default-glob-list updates between CLI versions silently expand a consumer's match set | Low (rejected default-merge — § 3.7) | Medium | `DEFAULT_GENERATED_LOCKFILE_GLOBS` ONLY applies when `globs` is omitted. Explicit `globs[]` is exact-match. Documented in the schema parser docstring + README. |
| Parse-error silently hides a malicious-dep injection (the codex security finding) | Low (only fires on extractor bug or new lockfile shape) | Critical (recreates `-diff` blind spot) | § 2.3.4 default `"refuse-and-block"` puts the parse-error path into the critic's "treat as missing evidence" branch. The `"compact-with-warning"` opt-out is documented in the same place; operators who flip it accept the trade-off explicitly. |

## 5. Implementation plan

### 5.1 Files touched

```
docs/ADR/0001-bounded-lockfile-strategy.md          (this file — PR 1)

packages/schemas/src/index.ts                       (PR 2 — schema + parser)
packages/cli/src/compact/lockfile.ts                (PR 2 — new — extractors + renderer)
packages/cli/src/compact/index.ts                   (PR 2 — new — barrel)
packages/cli/src/trusted-surface/rebind.ts          (PR 2 — packet builder)
packages/cli/src/prompt.ts                          (PR 2 — prompt rendering)

packages/cli/tests/compact/lockfile.test.ts         (PR 2 — new — TDD pass)
packages/cli/tests/compact/fixtures/*.diff          (PR 2 — new — captured real diffs)
packages/schemas/tests/generated-file-policy.test.ts (PR 2 — new — parser)
packages/cli/tests/context.test.ts                  (PR 2 — extended for compacted{Diff,Content})
```

### 5.2 Tests (TDD)

Fixture-driven `vitest` tests in `packages/cli/tests/compact/`:

1. **`extracts-npm-add-remove-upgrade`** — feed a synthetic per-file
   unified diff that adds one package, removes one, upgrades one;
   assert the `CompactedPackageDelta[]` exactly matches the expected
   three entries with correct version + integrity fields.
2. **`extracts-pnpm-shapes`** — same matrix for pnpm-lock.yaml.
3. **`extracts-yarn-shapes`** — same matrix for yarn.lock.
4. **`renders-stub-deterministically`** — same input → byte-identical
   stub across two invocations; sorted package lines; correct sentinel
   brackets; `patch-sha256` matches `sha256` of the input section.
5. **`parse-error-refuse-and-block`** — feed a malformed block;
   extractor returns `parseError`; renderer emits parse-error stub;
   packet builder sets `parseErrorPaths`; prompt builder emits the
   top-of-diff `[DF-COMPACT PARSE-ERROR …]` marker.
6. **`parse-error-compact-with-warning-opt-out`** — same input under
   `onParseError: "compact-with-warning"`; assert `parseErrorPaths`
   is NOT set and the prompt marker is absent.
7. **`packet-builder-splices-stub`** — end-to-end through
   `buildReviewPacket` against a temp git repo whose second commit
   adds a real `package-lock.json` diff; assert (a) `packet.diff`
   retains the body (byte-budgeted as today), (b) `packet.compactedDiff`
   has the stub, (c) the matched `ChangedFile` has `compactedContent`
   populated AND `content` cleared, (d) `compileCriticPrompt` uses the
   compacted form in BOTH the `<diff>` and `<file>` sections, (e) the
   raw lockfile body appears in NEITHER section of the rendered prompt.
8. **`diff-hash-stable-across-policy-toggle`** — same commit, build
   packet twice (`mode: "full"` vs `mode: "compact"`); assert
   `packet.diffHash` is byte-identical across both runs.
9. **`schema-parses-policy-block`** — in `packages/schemas/tests/`:
   - valid policy parses
   - missing `mode` rejects
   - explicitly empty `globs: []` rejects
   - omitted `globs` parses cleanly (parser does NOT substitute
     defaults; absence preserved as `undefined`)
   - duplicate glob rejects
   - duplicate override `glob` rejects
   - valid `onParseError` values both parse
   - omitted `onParseError` preserved as `undefined`
10. **`compacted-diff-cap-truncates`** — feed a synthetic fullDiff
    containing multiple lockfile sections whose combined compacted
    form exceeds `MAX_COMPACTED_DIFF_BYTES`; assert truncation marker
    `[DF-COMPACT TRUNCATED — N more lockfile sections elided]`
    appears and the rendered length is ≤ the cap.
11. **`compacted-content-cap-truncates`** — feed a synthetic lockfile
    with 5,000 packages whose `packages-after:` stub exceeds
    `MAX_COMPACTED_CONTENT_BYTES`; assert the `[DF-COMPACT TRUNCATED
    — N more packages elided]` marker fires inside the stub and the
    rendered content length is ≤ the cap. Assert `content-sha256` is
    over the FULL pre-truncation content (audit recoverability).
12. **`pipeline-order-untruncated-fulldiff`** — feed a synthetic
    fullDiff whose first per-file section is a large lockfile
    (~600 KB) and whose later per-file section is a source-code change
    (~50 KB). With `mode: "full"` (no compaction), `packet.diff`
    truncates the source-code change. With `mode: "compact"`,
    `packet.compactedDiff` contains the lockfile stub AND the full
    source-code change (because compaction runs BEFORE the budget
    cap). This test is the codex round-2 contracts blocker's specific
    assertion.
13. **`effective-mode-override-fires-under-mode-full`** — config has
    `mode: "full"` but `overrides: [{glob: "...package-lock.json",
    mode: "compact"}]`. Assert that compaction still fires for the
    matched path (the resolver returns `compact` for that file) AND
    that other matched-glob files in the default list are NOT
    compacted (their effective mode resolves to `full`). This is the
    codex round-2 high finding's specific assertion.
14. **`telemetry-compacted-files-event`** — assert that
    `runReview()` emits the new `compacted_files` event with
    `findingCount > 0` and a non-empty `perFileCounts` JSON string
    when at least one matched path goes through compaction; assert
    the event is NOT emitted when no path matches.

Fixture diffs are captured from real `npm install` / `pnpm install` /
`yarn install` runs against synthetic package.json files committed
under `packages/cli/tests/compact/fixtures/`. The fixtures are checked
in (small — under 50 KB combined for unit fixtures; the large
synthetic fixtures for tests 10-12 are generated in-test from a small
seed to keep the repo footprint tight); the test harness reads them
verbatim, no shell-out.

### 5.3 Test strategy

- **Pure-function extractors** are unit-tested with fixture inputs (no
  git, no fs). The extractor signature is
  `(unifiedDiffSection: string, path: string) => CompactedLockfileDelta`.
- **Renderer** is unit-tested for byte-identical determinism.
- **`buildReviewPacket` integration** uses the existing temp-repo
  pattern from `packages/cli/tests/context.test.ts` (the `mkdtempSync`
  + `runGit` harness). The integration test commits a real
  `package-lock.json` diff so the compactor runs against `commitDiff`
  output, not synthetic strings.
- **Cross-package contract**: `parseAgentReviewConfig` accepts the new
  block in `schemas/tests/`; `buildReviewPacket` accepts a loaded
  config with the block in `cli/tests/`; matched contract.

### 5.4 Phased rollout

- **PR 2** ships the strategy as opt-in (`generatedFilePolicy` absent
  → identical to today). Internal dogfood: set `mode: "compact"` in
  this repo's `.agent-review/config.json` (the consumer-vs-author
  posture means we test it against ourselves before promoting the
  default).
- **Follow-up cycle** promotes the default to `mode: "compact"` for
  the shipped default glob list. Defer until at least one external
  consumer (taxpilot2a / lyra) has run with it for ≥ 1 week of normal
  traffic.

### 5.5 Out of scope (negative space)

- The codex SDK's read-only sandbox bwrap requirement and W3 worker
  pod-side issue (separate tracking issue
  `dark-factory-platform#116`).
- A separate critic-budget per-file truncation knob (see § 3.2).
- Lockfile formats beyond npm / pnpm / yarn (cargo, go, gemfile,
  requirements.txt) — v2 will register additional kinds.
- Changing `diffHash` semantics. The hash continues to bind the
  pre-truncation `fullDiff` (today's behavior, preserved) so
  finding-cache identity stays stable across both policy toggles AND
  budget truncation.
- Adapter-scoped `diffMode` override (see § 3.4).
- Moving `generatedFilePolicy` onto a top-level `reviewPacket.*` block
  (see § 3.5).
- Telemetry counters beyond a single `compacted_files` field. A
  richer per-extractor parse-error counter is a follow-up.
- Default-glob merging behavior (see § 3.7).
- Promoting the policy to opt-out (a default of `mode: "compact"`) —
  that's a follow-up cycle (§ 5.4).

## 6. Open questions for critic-fleet review

1. **Default glob list — should it include `pnpm-lock.yaml` and
   `yarn.lock` from day one even though no dogfood evidence exists
   for them?** Trade-off: shipping default-on for unobserved formats
   risks a compactor bug masking a real signal in those repos;
   shipping default-off forces every pnpm/yarn consumer to discover
   the knob. **Proposed:** ship all three globs in the default list;
   the refuse-and-block parse-error default (§ 2.3.4) means the worst
   case is "diff renders parse-error stub and critic blocks on it,"
   not silent corruption.
2. **Should the schema enforce that `globs[]` is non-empty when
   `mode !== "full"`?** Currently the proposal allows omitted
   `globs[]` (defaults substitute at packet-build time) but rejects
   an explicitly empty `globs: []` (parser rule 2: non-empty array
   when present). Confirm this is the right shape.
3. **Should the compactor accept a per-glob `mode` AND a fallback
   for non-matched paths?** Currently no — non-matched paths route
   through the unchanged full-diff path. Alternative: a
   `defaultModeForOversize` that applies a generic truncation to any
   per-file section over N bytes regardless of path. Probably folds
   into the orthogonal per-file truncation issue (§ 3.2).
4. **Cache-invalidation interaction with cycle 332 finding cache.**
   The proposal asserts `diffHash` (pre-truncation full body) keeps
   cache identity stable; the test plan now includes a specific
   assertion (test § 5.2 #8). Review whether `configHash` correctly
   captures the policy shape — specifically whether toggling
   `generatedFilePolicy.mode` shifts `configHash` (it should, since
   the config block changes). Confirm in PR 2 with an integration
   test.

## 7. Acceptance for this ADR

The ADR is accepted when:

- The DF critic fleet (cursor + codex + gemini + grok) returns
  `APPROVED` on this PR or the open questions in § 6 are resolved
  with a follow-up ADR amendment commit.
- No `requiresHumanJudgment: true` blocker from any critic on the
  decision in § 2.
- PR 2 (implementation) cites this ADR by section number for each
  major design choice, so a follow-up critic pass on PR 2 can verify
  alignment with the accepted plan.
