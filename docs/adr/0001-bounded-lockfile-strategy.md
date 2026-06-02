# ADR-0001 — Bounded lockfile strategy for the review packet

- Status: Proposed (plan PR awaiting DF critic-fleet review)
- Date: 2026-06-01
- Issue: [#67](https://github.com/momentiq-ai/dark-factory/issues/67)
- Driver: critic context-window overflow on diffs containing large generated lockfiles
- Decider: DF critic fleet (cursor, codex, gemini, grok). PJ will not adjudicate this ADR; the critics will.
- Supersedes: nothing
- Related: cycle 331.1 reusable-workflow consumer contract; cycle 322.3 `min-complete-quorum` aggregation (the failure-mode this is observed under is `quorum_unmet` from a `transport_error`)

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
parent..sha` and the review-packet builder
(`packages/cli/src/trusted-surface/rebind.ts:52`) feeds it into
`ReviewPacket.diff` after a single `DEFAULT_DIFF_BUDGET = 1_500_000`
byte cap. That cap is per-packet, not per-file, and the codex SDK's
model has a tighter ceiling than 1.5 MB — a single large lockfile diff
defeats the budget without triggering the truncation marker (truncation
fires after the budget; the lockfile may be the entire budget). Even
when truncation fires, it removes evidence the critics need for
non-lockfile review.

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
The strategy detects well-known generated lockfiles by path and feeds
critics a **compacted** representation that preserves the
security-relevant signal (per-package change set + integrity-hash
deltas) while keeping the byte budget under the model's context
window. The **full** diff stays in `ReviewPacket.diff` for downstream
consumers that need the patch (cache invalidation, gate-failure
evidence, audit trail). Critics receive the compacted form via a new
`ReviewPacket.compactedDiff` field that adapters consult when present.

The strategy is opt-out per policy and per-glob-overridable. The
default policy globs cover npm / pnpm / yarn lockfiles, which is the
overwhelming majority of observed overflows.

### 2.1 Where the change lands

| Layer | Module | Change |
|---|---|---|
| Schema | `packages/schemas/src/index.ts` | New optional `generatedFilePolicy` block on `ContextConfig` + parser branch in `parseAgentReviewConfig`. New optional `compactedDiff` field on `ReviewPacket`. |
| Compactor | `packages/cli/src/compact/lockfile.ts` (new) | Pure per-lockfile compactor functions, dispatched by glob match. Per-file diff body → `CompactedLockfileDelta` struct → rendered as a stable text stub. |
| Packet builder | `packages/cli/src/trusted-surface/rebind.ts` | When `generatedFilePolicy.mode !== "full"`, walk the unified diff's per-file sections, route lockfile sections through the compactor, splice the rendered stub back in, write the rendered string to `ReviewPacket.compactedDiff`. `ReviewPacket.diff` stays full. |
| Prompt builder | `packages/cli/src/prompt.ts` | When `packet.compactedDiff !== undefined`, the `<diff>` section uses it instead of `packet.diff`. The `[DIFF WAS TRUNCATED]` marker stays scoped to `diffTruncated`. |
| Audit / cache | `packages/cli/src/git.ts` (`commitDiff` callers) | Untouched. `diffHash` continues to hash the **full** diff so cache invalidation is stable across policy toggles. |

### 2.2 Config schema sketch — `context.generatedFilePolicy`

Add an optional block to `ContextConfig`:

```ts
export type GeneratedFileMode = "full" | "compact" | "omit";

export interface GeneratedFileGlobOverride {
  glob: string;             // matched via packages/cli/src/glob.ts compileGlob
  mode: GeneratedFileMode;  // overrides the policy-level default for this glob
}

export interface GeneratedFilePolicy {
  // Default for any path matched by `globs[]` below. "full" means the
  // strategy is a no-op (current behavior); "compact" emits a stub
  // built by the per-lockfile compactor; "omit" emits a minimal
  // "<path> diff omitted by policy" marker.
  mode: GeneratedFileMode;

  // Path globs that activate the strategy. Default-on globs (built into
  // the CLI; users may extend / replace via this field) cover
  // package-lock.json, pnpm-lock.yaml, yarn.lock at any depth. The
  // shipped default list is documented in the CLI README and exported
  // as `DEFAULT_GENERATED_LOCKFILE_GLOBS` so consumers can extend
  // rather than re-derive.
  globs: string[];

  // Per-glob overrides for finer-grained control. Earliest match wins.
  // Example: globs=["**/package-lock.json"], mode="compact",
  //   overrides=[{ glob: "**/services/event-ingest/package-lock.json",
  //                mode: "omit" }]
  overrides?: GeneratedFileGlobOverride[];
}

export interface ContextConfig {
  guidanceFiles: string[];
  promptFragments: string[];
  maxChangedFileBytes: number;
  includeFullChangedFiles: boolean;
  // NEW — optional. Absent → behavior identical to today (full diff fed
  // to critics; no compactedDiff field on the packet).
  generatedFilePolicy?: GeneratedFilePolicy;
}
```

**Default shipped glob list** (used when `generatedFilePolicy.globs` is
omitted but a `mode` is set — keeps the common-case config terse):

```
**/package-lock.json
**/npm-shrinkwrap.json
**/pnpm-lock.yaml
**/yarn.lock
```

**Parser validation rules** (added to `parseAgentReviewConfig` in
`schemas/src/index.ts`):

1. `mode` is required when the block is present and must be one of
   `"full" | "compact" | "omit"`.
2. `globs` is an array of non-empty strings; duplicates rejected (a
   duplicate glob string is a foot-gun — operators usually meant
   different `mode`s in `overrides`).
3. `overrides[]` entries: `glob` non-empty string, `mode` one of the
   three values; the override `glob` does NOT need to be in `globs[]`
   (overrides can carve a finer slice OR add a new path); duplicate
   override `glob` rejected.
4. Schema parser does NOT compile the glob (compilation lives in the
   CLI's `glob.ts` module; the schema package stays dependency-free).
   Invalid glob syntax surfaces at first use, not at config load. This
   matches the existing convention for `tdd.classifier.exclusionGlobs`
   and `validation.verificationRoutes[].trigger`.

### 2.3 Compaction format spec

The per-lockfile compactor produces a stable text stub from the
per-file unified-diff section. The stub is parseable by humans (so the
PR-review surface stays informative) and re-parseable by a downstream
gate that wants to assert on the deltas without re-running git. The
stub format is version-tagged so future compactor revisions don't
silently break consumers that grep the rendered text.

#### 2.3.1 Stub format (rendered into `compactedDiff` in lieu of the patch hunks)

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

Constraints:

- `lockfile-kind` is one of `npm`, `pnpm`, `yarn`. Future kinds extend
  the enum; unknown kind → fall back to `mode: "omit"` for that file
  (the compactor never invents a parse for an unknown format).
- `patch-sha256` is `sha256(unifiedDiffSection)` so a later auditor can
  cross-check that the rendered stub corresponds to the omitted patch
  body. This is the audit trail the consumer-side `-diff` workaround
  destroys.
- Package lines are sorted by `<packageName>` then by `+ / - / ~`
  category for deterministic output (matters for compactedDiff
  reproducibility tests + finding-cache stability).
- A lockfile with zero parseable per-package deltas (e.g., only a
  top-level `lockfileVersion` bump) renders a single
  `notes: lockfile-metadata-only` line instead of the empty `packages:`
  block.

#### 2.3.2 Per-lockfile-kind extraction

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
  notes?: string[];          // freeform machine-readable notes ("lockfile-metadata-only", "parse-error-fallback-omit")
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
are NOT shipped in v1. The default glob list omits them; a consumer
can still set `generatedFilePolicy.globs = ["**/Cargo.lock"]` and the
compactor will fall back to `mode: "omit"` for any path it can't
identify. v2 will register additional kinds.

### 2.4 Two diff surfaces

After this change, the review packet exposes:

- **`ReviewPacket.diff`** — the **full** unified diff, byte-budgeted
  identically to today (`DEFAULT_DIFF_BUDGET`). `diffHash` still hashes
  this string. Downstream consumers (cache invalidation, telemetry
  audit) use this.
- **`ReviewPacket.compactedDiff`** — optional. Present only when
  `generatedFilePolicy.mode !== "full"` AND at least one matched
  lockfile is present in the diff. When present, the prompt builder
  uses this string for the `<diff>` section instead of `packet.diff`.
  Carries the same per-file metadata as `packet.diff` minus the
  compacted lockfile bodies.
- **`ReviewPacket.diffTruncated`** — unchanged. Triggers when the
  underlying full diff exceeds `DEFAULT_DIFF_BUDGET`. Mutually
  compatible with `compactedDiff` being present (a diff can be both
  truncated AND have a compacted lockfile section).

Adapters consume the packet through `prompt.ts:compileCriticPrompt`,
which is the single rendering point. The prompt-side change is
mechanical:

```ts
const diffForPrompt = packet.compactedDiff ?? packet.diff;
sections.push(escapeUntrusted(diffForPrompt));
```

No adapter needs a code change; the compaction is transparent to the
adapter surface.

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

## 4. Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Compactor misreads a lockfile entry → critic gets wrong package-delta info | Medium (first ship of per-format extractors) | High (could mask a malicious dep injection) | (a) Fuzzy fallback: any extractor parse error downgrades that file to `mode: "omit"` with `notes: ["parse-error-fallback-omit"]` (cited in the stub); (b) `patch-sha256` field in the stub lets a later auditor recover the original; (c) `ReviewPacket.diff` retains the full body so a follow-up critic pass with `mode: "full"` can re-verify. |
| Glob match too narrow → real lockfile slips through and overflow returns | Low (default globs cover npm/pnpm/yarn) | High (regression to current state) | Telemetry: emit a `compacted_files` telemetry counter on each review run (per-path) so operators see the strategy firing. Doctor subcommand surfaces "no compaction expected but diff exceeds 100KB" as an info-level warning. |
| Compactor's stub format collides with a critic's existing finding shape | Low | Medium | Sentinel `[DF-COMPACT v1 <kind>]` / `[DF-COMPACT end]` brackets; format version-tagged. |
| `diffHash` keys the cache off the full diff but the prompt uses compactedDiff → cache hits that no longer correspond to the body shown to the critic | Low (compaction is purely a derived view) | Low | The cache key is the *review input*, which is bounded by `diffHash` + critic id + content hashes of the changed files (cycle 332 finding cache). A second derived view doesn't change the input identity. Cycle 332 finding-cache's `configHash` already covers config-shape changes — when `generatedFilePolicy` toggles, `configHash` shifts and the cache invalidates. |
| Compaction changes critic verdicts in a way that re-opens recently-closed findings | Medium (rollout window) | Medium | Ship behind a default-on `mode: "compact"` for the lockfile globs but document a 1-cycle rollback path: setting `mode: "full"` reverts to today's behavior with zero schema work. The on-disk policy is a single field; emergency revert is a one-line PR. |

## 5. Implementation plan

### 5.1 Files touched

```
docs/adr/0001-bounded-lockfile-strategy.md  (this file — PR 1)

packages/schemas/src/index.ts                    (PR 2 — schema + parser)
packages/cli/src/compact/lockfile.ts             (PR 2 — new — extractors + renderer)
packages/cli/src/compact/index.ts                (PR 2 — new — barrel)
packages/cli/src/trusted-surface/rebind.ts       (PR 2 — packet builder)
packages/cli/src/prompt.ts                       (PR 2 — prompt rendering)

packages/cli/tests/compact/lockfile.test.ts      (PR 2 — new — TDD pass)
packages/cli/tests/compact/fixtures/*.diff       (PR 2 — new — captured real diffs)
packages/schemas/tests/generated-file-policy.test.ts (PR 2 — new — parser)
packages/cli/tests/context.test.ts               (PR 2 — extended for compactedDiff)
```

### 5.2 Tests (TDD)

Fixture-driven `vitest` tests in `packages/cli/tests/compact/`:

1. **`extracts-npm-add-remove-upgrade.test.ts`** — feed a synthetic
   per-file unified diff that adds one package, removes one, upgrades
   one; assert the `CompactedPackageDelta[]` exactly matches the
   expected three entries with correct version + integrity fields.
2. **`extracts-pnpm-shapes.test.ts`** — same matrix for pnpm-lock.yaml.
3. **`extracts-yarn-shapes.test.ts`** — same matrix for yarn.lock.
4. **`renders-stub-deterministically.test.ts`** — same input → byte-identical
   stub across two invocations; sorted package lines; correct sentinel
   brackets; `patch-sha256` matches `sha256` of the input section.
5. **`unknown-format-falls-back-to-omit.test.ts`** — feed a malformed
   block; extractor returns `parse-error-fallback-omit` and a
   marker-only stub; no crash.
6. **`packet-builder-splices-stub.test.ts`** — end-to-end through
   `buildReviewPacket` against a temp git repo whose second commit
   adds a real `package-lock.json` diff; assert `packet.diff` retains
   the body, `packet.compactedDiff` has the stub, both render in
   `compileCriticPrompt` (prompt uses compacted form).
7. **`schema-parses-policy-block.test.ts`** — in
   `packages/schemas/tests/`; valid policy parses; missing mode rejects;
   duplicate glob rejects; nested override referencing a non-existent
   parent-glob is accepted (overrides can add paths).

Fixture diffs are captured from real `npm install` / `pnpm install` /
`yarn install` runs against synthetic package.json files committed
under `packages/cli/tests/compact/fixtures/`. The fixtures are checked
in (small — under 50 KB combined); the test harness reads them
verbatim, no shell-out.

### 5.3 Test strategy

- **Pure-function extractors** are unit-tested with fixture inputs (no
  git, no fs). The extractor signature is
  `(unifiedDiffSection: string, path: string) => CompactedLockfileDelta`.
- **Renderer** is unit-tested for byte-identical determinism.
- **`buildReviewPacket` integration** uses the existing temp-repo
  pattern from `packages/cli/tests/context.test.ts` (the `mkdtempSync` +
  `runGit` harness). The integration test commits a real
  `package-lock.json` diff so the compactor runs against `commitDiff`
  output, not synthetic strings.
- **Cross-package contract**: `parseAgentReviewConfig` accepts the new
  block in `schemas/tests/`; `buildReviewPacket` accepts a loaded
  config with the block in `cli/tests/`; matched contract.

### 5.4 Phased rollout

- **PR 2** ships the strategy as opt-in (`generatedFilePolicy` absent
  → identical to today). Internal dogfood: set
  `mode: "compact"` in this repo's `.agent-review/config.json` (the
  consumer-vs-author posture means we test it against ourselves before
  promoting the default).
- **Follow-up cycle** promotes the default to
  `mode: "compact"` for the shipped default glob list. Defer until at
  least one external consumer (taxpilot2a / lyra) has run with it for
  ≥ 1 week of normal traffic.

### 5.5 Out of scope (negative space)

- The codex SDK's read-only sandbox bwrap requirement and W3 worker
  pod-side issue (separate tracking issue
  `dark-factory-platform#116`).
- A separate critic-budget per-file truncation knob (see § 3.2).
- Lockfile formats beyond npm / pnpm / yarn (cargo, go, gemfile,
  requirements.txt) — opt-in via `globs` override; the compactor
  returns the `omit` fallback.
- Changing `diffHash` semantics. The hash continues to bind the full
  body so finding-cache identity stays stable across policy toggles.
- Adapter-scoped `diffMode` override (see § 3.4).
- Moving `generatedFilePolicy` onto a top-level `reviewPacket.*` block
  (see § 3.5).
- Telemetry counters beyond a single `compacted_files` field. A richer
  per-extractor parse-error counter is a follow-up.

## 6. Open questions for critic-fleet review

1. **Default glob list — should it include `pnpm-lock.yaml` and
   `yarn.lock` from day one even though no dogfood evidence exists for
   them?** Trade-off: shipping default-on for unobserved formats risks
   a compactor bug masking a real signal in those repos; shipping
   default-off forces every pnpm/yarn consumer to discover the knob.
   **Proposed:** ship all three globs in the default list; the
   `parse-error-fallback-omit` path means the worst case is "diff
   shows as omitted, full body still in `packet.diff`," not silent
   corruption.
2. **Should the schema enforce that `globs[]` is non-empty when `mode
   !== "full"`?** Currently the proposal accepts an empty `globs[]`
   (effectively a no-op). Arguments either way; cycle precedent
   (`tdd.classifier.exclusionGlobs`) allows empty arrays.
3. **Should the compactor accept a per-glob `mode` AND a fallback for
   non-matched paths?** Currently no — non-matched paths route through
   the unchanged full-diff path. Alternative: a `defaultModeForOversize`
   that applies a generic truncation to any per-file section over N
   bytes regardless of path. Probably folds into the orthogonal
   per-file truncation issue (§ 3.2).
4. **Cache-invalidation interaction with cycle 332 finding cache.**
   The proposal asserts `diffHash` (full body) keeps cache identity
   stable; review whether `configHash` correctly captures the policy
   shape — specifically whether toggling `generatedFilePolicy.mode`
   shifts `configHash` (it should, since the config block changes).
   Confirm in PR 2 with an integration test.

## 7. Acceptance for this ADR

The ADR is accepted when:

- The DF critic fleet (cursor + codex + gemini + grok) returns
  `APPROVED` on this PR or the open questions in § 6 are resolved with
  a follow-up ADR amendment commit.
- No `requiresHumanJudgment: true` blocker from any critic on the
  decision in § 2.
- PR 2 (implementation) cites this ADR by section number for each
  major design choice, so a follow-up critic pass on PR 2 can verify
  alignment with the accepted plan.
