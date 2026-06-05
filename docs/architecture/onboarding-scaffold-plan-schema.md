# ScaffoldPlan schema (cycle 15 Phase B)

> Companion to [`onboarding-analysis-schema.md`](./onboarding-analysis-schema.md).
> Both schemas are versioned via `schemaVersion: 1` (cycle 15 Phase A baseline)
> and `SCAFFOLD_PLAN_SCHEMA_VERSION: 1` (this doc's subject).

The `ScaffoldPlan` is Phase B's output envelope — the Stage B LLM's structured
return shape, consumed by the three writers (`apply-plan.ts`, `pr-writer.ts`,
`dry-run-renderer.ts`) and by the MCP surface (Phase C).

## Provenance

- **Producer:** `generatePlan(analysis, template, opts)` in
  `packages/cli/src/onboard/generate-plan.ts`.
- **LLM:** Anthropic Messages API via `@anthropic-ai/sdk`, tool-use binding on
  the `emit_scaffold_plan` tool. Default model `claude-3-7-sonnet-latest`;
  override via `--model`.
- **Prompt asset:** `packages/cli/src/onboard/prompts/scaffold.md` — co-located
  with the calling code per Cycle 15 D6. Asset is copied to `dist/` at build
  time (`scripts/copy-assets.mjs`).
- **Source-analysis pin:** `sourceAnalysisSchemaVersion: 1` references the
  Phase A `RepoAnalysis` shape; bumping `AGENT_CONTEXT_SCHEMA_VERSION` (Phase A)
  invalidates plans that pin the older version.

## Shape

| Field | Type | Constraint |
|---|---|---|
| `schemaVersion` | `1` | literal; bumped on structural change |
| `sourceAnalysisSchemaVersion` | `1` | literal; pinned to the Phase A producer |
| `templateRef` | string | `gh:<owner>/<repo>@<ref>` or `file:///<abs>@<ref>` |
| `generatedAtIso` | string | ISO-8601 datetime, no offset |
| `files` | `FilePlan[]` | cap 100 |
| `summary` | string | ≤ 800 chars |

### `FilePlan` (discriminated union on `action`)

| Action | Required fields | Rejected fields |
|---|---|---|
| `emit` | `path`, `rationale`, `tailored_content` (≤ 16 KB) | extras (strict) |
| `merge` | `path`, `rationale`, `tailored_content` (≤ 16 KB) | extras (strict) |
| `skip` | `path`, `rationale` | `tailored_content` |

## Byte budgets

- **Whole plan:** ≤ 64 KB (serialized JSON). Enforced in `generate-plan.ts` as
  the backstop to per-array `.max()` caps.
- **Per-file `tailored_content`:** ≤ 16 KB. Phase B's CLAUDE.md tailored body
  is ≤ 10 KB in practice; the 16 KB cap allows for ADR-sized seeds in cycle C.

## Action semantics

- **`emit`** — writer: `writers/emit.ts`. Behavior: write `tailored_content`
  to `<rootDir>/<path>`. Refuses to overwrite an existing file unless
  `force: true`. Refuses absolute paths and path traversal.
- **`merge`** — writer: `writers/merge.ts`. Behavior: additive-append the
  `tailored_content` after the existing file, wrapped in
  `<!-- df onboard: inserted-by-cycle-15 BEGIN -->` /
  `<!-- df onboard: inserted-by-cycle-15 END -->` markers. On re-run, REPLACES
  the existing marker block (preserving everything outside). On parse failure
  (binary, > 128 KB, unbalanced fences, no headings), SKIPS the merge with a
  stderr warning; file untouched. Cycle 15 risk surface.
- **`skip`** — writer: `writers/skip.ts`. Behavior: no-op + audit envelope.

## Template loader contract

See `packages/cli/src/onboard/template-loader.ts`. The loader resolves a
ref to a sha (via `git ls-remote` for `gh:` refs; identity for `file://`),
content-addresses the cache at `~/.df/cache/templates/<owner>__<repo>__<sha>/`,
and walks the cached tree with the filter rules: skip `.git/`, `node_modules/`,
`dist/`, `build/`; ≤ 64 KB per file; binary skipped; ≤ 200 entries total.
Sage-blueprint Copier `{{ }}` placeholders are passed through unchanged — the
LLM stage substitutes them.

The ref-parsing primitive (`parseTemplateRef` + the shape regex + the
parsed-ref types) lives in the co-located foundation file
`packages/cli/src/onboard/template-ref.ts` (shipped with Task 1 alongside the
schema). The loader imports the parser from there; the Zod schema's
`.refine()` ALSO imports the parser from there — single source of truth for
the semantic ref check, no circular dependency possible (round-4
restructure-completion of the round-3 advisor call).

## Phase B↔Phase C contract

Phase B's prompt (`packages/cli/src/onboard/prompts/scaffold.md`, rule 4a)
instructs the LLM to **always SKIP `.agent-review/config.json`** — the
deterministic Phase C seeder owns that path. Phase B still resolves the
`--profile local|cloud` value (via `autoProfile(analysis)` in
`packages/cli/src/onboard/auto-profile.ts` when no explicit flag is given)
and threads it through `generatePlan`'s options bag for downstream
seeders. The seeder reads the resolved profile to emit the matching
canonical critic-fleet JSON.

`autoProfile` ships as its own module so Phase C can import it via
`import { autoProfile } from "../auto-profile.js"` and re-use the
exact same heuristic — no drift between the two phases.

## CLI surface (the Phase B operator view)

```
df onboard [--analysis-only | --dry-run | --apply | --pr] [target-dir]
           [--template <ref>] [--api-key <k>] [--model <id>]
           [--profile local|cloud] [--force] [--json]
```

Defaults: `--dry-run` when no mode flag; template `gh:momentiq-ai/sage-blueprint@latest`;
model `claude-3-7-sonnet-latest`; profile auto-detect based on existing
DF gate presence.

## Rejected: `--include-runtime-infra`

Per Cycle 15 D5: generating Terraform / Helm is outside the agent-context-set
bar. The flag is parsed and rejected with a deferred-to-v2 message.

## Cross-references

- Phase A schema doc: `docs/architecture/onboarding-analysis-schema.md`.
- Cycle 15 spec: [`docs/roadmap/cycles/cycle15-df-onboard-agent.md`](https://github.com/momentiq-ai/dark-factory-platform/blob/main/docs/roadmap/cycles/cycle15-df-onboard-agent.md) (in DFP).
- Phase B plan: [`docs/superpowers/plans/2026-06-03-cycle15-phase-b-scaffold-generation-plan.md`](https://github.com/momentiq-ai/dark-factory-platform/blob/main/docs/superpowers/plans/2026-06-03-cycle15-phase-b-scaffold-generation-plan.md) (in DFP).
