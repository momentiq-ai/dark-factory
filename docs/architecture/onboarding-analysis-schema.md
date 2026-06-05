# RepoAnalysis schema — cycle 15 Phase A reference

> **Source of truth:** [`packages/cli/src/onboard/schema.ts`](../../packages/cli/src/onboard/schema.ts).
> This doc is the reader-facing companion. If it drifts from the Zod
> definition, the Zod definition wins — the schema is the contract; this
> page is the gloss.
>
> **Audience:** Phase B's LLM-tailoring author, the downstream consumers
> that read the `df onboard --analysis-only --json` envelope, and anyone
> proposing a structural change to `RepoAnalysis` (the schema-version
> bump policy in [§ Schema-versioning policy](#schema-versioning-policy)
> applies).

## What this schema is

`RepoAnalysis` is the **bounded, schema-versioned envelope** produced by the
deterministic Stage A scanner of `df onboard`. The CLI emits it from
`df onboard --analysis-only --json`; the orchestrator
([`packages/cli/src/onboard/analyze.ts`](../../packages/cli/src/onboard/analyze.ts))
collects partial contributions from six domain analyzers, merges them,
validates with Zod's `.strict()` parser, and enforces a final 16 KB
serialized-size byte budget before returning.

The envelope is **the only thing Phase B's LLM-tailoring step consumes from
the target repository.** It is never the full repo contents. The two-stage
split (Stage A deterministic scan + Stage B LLM tailoring — see
[cycle 15 D2](https://github.com/momentiq-ai/dark-factory-platform/blob/main/docs/roadmap/cycles/cycle15-df-onboard-agent.md))
is what keeps Phase B's prompt size sub-linear in repo size: regardless of
whether the target repo is 200 files or 200,000 files, the envelope stays
≤ 16 KB. That bound is the prerequisite for a single LLM call to produce a
`ScaffoldPlan` without context-window thrash or fact hallucinations.

The 16 KB budget is enforced two ways: (1) per-array `.max()` caps on the
Zod schema bound the common overflow paths (stacks 12, dependencies 20,
decisions 10, headings 50, etc.); (2) a final `JSON.stringify` byte check
in the orchestrator is the backstop for unforeseen growth (giant headings,
very long `canonicalName`, etc.) and throws on overflow. See
[§ Why the 16 KB budget](#why-the-16-kb-budget) for the full breakdown.

The schema is versioned via a single exported constant
`AGENT_CONTEXT_SCHEMA_VERSION = 1`. The literal `schemaVersion: 1` on the
root of every emitted envelope is the version tag Phase B reads to decide
which prompt template to use. Bumps follow the policy in
[§ Schema-versioning policy](#schema-versioning-policy) — they are
infrequent and deliberate.

## Field reference

`RepoAnalysis` is a `z.object({...}).strict()` at its root: unknown fields
are rejected on validation. Every field is listed below. The **Owner**
column names the analyzer that populates the field (see
[`packages/cli/src/onboard/analyzers/`](../../packages/cli/src/onboard/analyzers/));
the **Source** column names the target-repo file (or git surface) the
analyzer derives the field from.

### Top-level metadata

| Field | Type | Cap | Owner | Source | Description |
|---|---|---|---|---|---|
| `schemaVersion` | `z.literal(1)` | — | orchestrator | (constant) | The `AGENT_CONTEXT_SCHEMA_VERSION` literal. Always `1` at v1. Phase B branches on this to pick its prompt template. |
| `repoRoot` | `string` | — | orchestrator | (CLI argument) | Absolute path the analyzer ran against. Captured for audit; Phase B does NOT use it as a content source. |
| `canonicalName` | `string` | — | git | `git remote get-url origin` | `<owner>/<repo>` parsed from the origin remote (HTTPS or SSH form, host-agnostic). Empty string when no origin remote is configured. |

### `stacks[]` — detected language stacks

Schema: `z.array(StackSchema).max(12)`. Owner analyzer: **manifest**
([`analyzers/manifest.ts`](../../packages/cli/src/onboard/analyzers/manifest.ts)).
One entry per detected stack. The 12-entry cap is generous — most repos
have 1–3 stacks; even a polyglot monorepo rarely exceeds 6.

| Field | Type | Cap | Source | Description |
|---|---|---|---|---|
| `stacks[].language` | enum (12 values) | — | (per-stack manifest) | One of `typescript`, `javascript`, `python`, `go`, `rust`, `ruby`, `elixir`, `java`, `kotlin`, `csharp`, `swift`, `other`. The enum is deliberately narrow; an exotic stack falls into `"other"` until a new detector lands in `manifest.ts`. |
| `stacks[].versionPin` | `string \| null` | — | engines / `.tool-versions` / runtime files | The version pin parsed from the primary manifest (e.g. `engines.node`, `tool.poetry.dependencies.python`, `go` directive). `null` when no pin is declared. `.tool-versions` overrides primary-manifest pins per the manifest-analyzer merge rule; the primary manifest's path is preserved as `manifestPath`. |
| `stacks[].manifestPath` | `string` | — | (filesystem path) | Repo-relative path to the manifest that produced the entry (e.g. `package.json`, `pyproject.toml`, `go.mod`, `.tool-versions`). Forward-slash form regardless of host OS. |

**Detection order** (see `manifestAnalyzer.detect` for the call order):
Node → Python → Go → Rust → Ruby → Elixir → Java → Kotlin → Dockerfile,
then `.tool-versions` merged in. Dockerfile sits last as a fallback signal
(`language: "other"`, `versionPin` = the `FROM` line image+tag).

### `services[]` — discovered service directories

Schema: `z.array(ServiceSchema).max(30)`. Owner analyzer: **tree**
([`analyzers/tree.ts`](../../packages/cli/src/onboard/analyzers/tree.ts)).
Populated from immediate children of top-level directories classified as
`services` (literally `services/` or `apps/`).

| Field | Type | Cap | Source | Description |
|---|---|---|---|---|
| `services[].name` | `string` | — | (basename) | Directory basename (e.g. `worker`, `aggregation`). |
| `services[].path` | `string` | — | (filesystem path) | Repo-relative path (e.g. `services/worker`, `apps/dashboard`). Forward-slash form. |
| `services[].stack` | `string \| null` | — | — | Stack the service runs on. **Always `null` in v1** — per-service stack detection is deferred to Phase B (or a v2 enrichment of the manifest analyzer). The field is present so Phase B can fill it without a schema bump. |

### `dependencies[]` — top 20 direct deps with pinned versions

Schema: `z.array(DependencySchema).max(20)`. Owner analyzer: **lockfile**
([`analyzers/lockfile.ts`](../../packages/cli/src/onboard/analyzers/lockfile.ts)).
This is the **deterministic name+version table the LLM cites verbatim** in
ADR seeds — `dependencies[]` is fact, `decisions[]` is heuristic
narrative. The 20-entry cap matches cycle 15 D2 lines 132–134.

| Field | Type | Cap | Source | Description |
|---|---|---|---|---|
| `dependencies[].name` | `string` | — | (lockfile entry) | Package name as it appears in the lockfile (e.g. `next`, `fastapi`, `github.com/spf13/cobra`). |
| `dependencies[].version` | `string` | — | (lockfile pin) | The PINNED resolved version (e.g. `15.0.3`, `0.111.0`, `v1.8.1`). NOT a range — only a real lockfile produces this, which is why the analyzer returns `null` when no lockfile is present. |
| `dependencies[].manifestPath` | `string` | — | (filesystem path) | Repo-relative path to the lockfile (e.g. `package-lock.json`, `yarn.lock`, `poetry.lock`, `go.sum`). |

**Lockfile precedence:** `package-lock.json` > `yarn.lock` > `poetry.lock`
> `go.sum`. The analyzer reads ONE lockfile per repo. The 20-entry cap is
filled in declaration order (direct deps from `package.json` /
`pyproject.toml`); transitive deps are NOT included.

### `ci` — workflow + deploy-story signal

Schema: `z.object({ workflows, deployStory })`. Owner analyzer: **ci**
([`analyzers/ci.ts`](../../packages/cli/src/onboard/analyzers/ci.ts)).

| Field | Type | Cap | Source | Description |
|---|---|---|---|---|
| `ci.workflows[]` | `Workflow[]` | 50 | `.github/workflows/*.{yml,yaml}` | One entry per workflow file. Non-GHA CI systems (CircleCI, GitLab CI, Buildkite) are NOT detected in v1. Cap bumped from 20 → 50 in cycle 15 Phase C (sage3c has 28 workflows; previous cap rejected real consumer repos at the Zod boundary). |
| `ci.workflows[].name` | `string` | — | YAML `name` key | Workflow's `name:` field, falling back to the filename when `name:` is absent. |
| `ci.workflows[].path` | `string` | — | (filesystem path) | Repo-relative path (always `.github/workflows/<basename>`). |
| `ci.workflows[].triggers` | `string[]` | — | YAML `on` key | Normalized list of trigger names (`push`, `pull_request`, `workflow_dispatch`, etc.). Handles all three shapes: string, array, and object. |
| `ci.workflows[].jobs` | `string[]` | — | YAML `jobs` map keys | List of job IDs declared in the workflow. |
| `ci.workflows[].matrixDimensions` | `string[]` | — | `jobs.*.strategy.matrix` | Union of matrix dimension names across all jobs (e.g. `["os", "node-version"]`). `include` / `exclude` are filtered out — those are matrix modifiers, not dimensions. |
| `ci.deployStory` | `DeployStory \| null` | — | (first matching run step) | First detected deploy command across all workflows, or `null`. |
| `ci.deployStory.workflowPath` | `string` | — | (filesystem path) | Repo-relative path to the workflow containing the deploy command. |
| `ci.deployStory.command` | `string` | — | (matched run line) | The trimmed shell line that matched a deploy verb (e.g. `helm upgrade --install api ./chart`). |
| `ci.deployStory.target` | enum (8 values) | — | (verb match) | One of `helm`, `gh-release`, `gcloud-run`, `ecs`, `vercel`, `fly`, `kubernetes`, `other`. Matched via the `DEPLOY_VERBS` regex table in `ci.ts`. |

### `tree` — directory structure + language counts

Schema: `z.object({ topLevelDirs, languageBreakdown, testDirs, fileCount })`.
Owner analyzer: **tree**
([`analyzers/tree.ts`](../../packages/cli/src/onboard/analyzers/tree.ts)).
The walk is bounded: **depth 4**, **50,000 file cap** (exceeding the cap
throws and surfaces as an `analyzerErrors[]` entry). Hidden entries
(`.git`, `.github`, dotfiles) and well-known build-artifact directories
(`node_modules`, `dist`, `build`, `target`, `.next`, `.venv`,
`__pycache__`, `.gradle`) are skipped at every level.

| Field | Type | Cap | Source | Description |
|---|---|---|---|---|
| `tree.topLevelDirs[]` | `TopLevelDir[]` | 30 | (repo root readdir) | One entry per non-hidden, non-skipped immediate subdirectory of the repo root. |
| `tree.topLevelDirs[].name` | `string` | — | (basename) | Directory basename. |
| `tree.topLevelDirs[].category` | enum (9 values) | — | (basename match) | One of `services`, `apps`, `packages`, `src`, `tests`, `docs`, `infra`, `scripts`, `other`. Derived from the `DIR_CATEGORY` table in `tree.ts` (`apps` → `services`, `lib` → `src`, `terraform` / `deploy` → `infra`, `bin` / `tools` → `scripts`, etc.). |
| `tree.topLevelDirs[].fileCount` | `number` (≥ 0) | — | (walk accumulator) | Total file count under this top-level directory (recursive, post-skip-filter, pre-extension-bucket). |
| `tree.languageBreakdown` | `Record<string, number>` | — | (extension → bucket) | Map from language-bucket name to file count (e.g. `{ "typescript": 312, "markdown": 84, "yaml": 19, "other": 6 }`). The bucket set is the `EXT_LANG` table in `tree.ts` plus `"other"`. Unmapped extensions fall into `"other"`. |
| `tree.testDirs[]` | `string[]` | 20 | (basename match at depth ≤ 3) | Repo-relative paths to every directory whose basename is `tests`, `test`, `__tests__`, or `spec`. Forward-slash form, de-duplicated. |
| `tree.fileCount` | `number` (≥ 0) | — | (walk accumulator) | Total file count across the entire walk (post-skip-filter). |

### `git` — repository signal

Schema: `z.object({ recentCommitConventions, defaultBranch })`. Owner
analyzer: **git**
([`analyzers/git.ts`](../../packages/cli/src/onboard/analyzers/git.ts)).
The analyzer also owns the top-level `canonicalName` field. Returns
`null` (opting out) when the directory isn't a git repo or has zero
commits.

| Field | Type | Cap | Source | Description |
|---|---|---|---|---|
| `git.recentCommitConventions.conventional` | `boolean` | — | `git log --pretty=%s -200` | `true` when ≥ 30% of the last 200 subjects match the conventional-commits prefix regex (`feat|fix|docs|chore|refactor|test|perf|build|ci`). |
| `git.recentCommitConventions.cycleReferenced` | `boolean` | — | (same sample) | `true` when ≥ 20% of subjects match `Cycle \d+` or `closes #\d+`. |
| `git.defaultBranch` | `string` | — | `symbolic-ref origin/HEAD` → `rev-parse HEAD` → `"main"` | Default branch name. Prefers the origin/HEAD symref, falls back to the local HEAD's abbreviated ref, final fallback is the literal `"main"` so the field is always a non-empty string. |

### `docs` — existing documentation + agent-context-set probe

Schema: `z.object({ existing, hasClaudeMd, hasAgentsMd, agentContextSetPresent, claudeMd, agentsMd })`.
Owner analyzer: **docs**
([`analyzers/docs.ts`](../../packages/cli/src/onboard/analyzers/docs.ts)).

| Field | Type | Cap | Source | Description |
|---|---|---|---|---|
| `docs.existing[]` | `string[]` | 50 | root `README.md` / `CONTRIBUTING.md` / `CHANGELOG.md` / `ARCHITECTURE.md` + every `docs/**/*.md` | Repo-relative paths of every documentation file the scanner found. Root-doc files appear first (in declaration order); `docs/**/*.md` entries follow in sorted order for determinism. Forward-slash form. |
| `docs.hasClaudeMd` | `boolean` | — | `CLAUDE.md` at root | `true` iff a root-level `CLAUDE.md` exists. |
| `docs.hasAgentsMd` | `boolean` | — | `AGENTS.md` at root | `true` iff a root-level `AGENTS.md` exists. |
| `docs.agentContextSetPresent` | `boolean` | — | (derived) | `true` iff `hasClaudeMd && hasAgentsMd && existing[]` contains at least one `docs/` entry — the "full agent-context-set" signal Phase B branches on to decide whether to emit a fresh scaffold or merge into an existing set. |
| `docs.claudeMd` | `AgentFile \| null` | — | `CLAUDE.md` | Structural envelope only — see below. `null` when the file doesn't exist. |
| `docs.agentsMd` | `AgentFile \| null` | — | `AGENTS.md` | Structural envelope only — see below. `null` when the file doesn't exist. |

**`AgentFile` shape** (per cycle 15 D2 lines 142–145):

| Field | Type | Cap | Description |
|---|---|---|---|
| `claudeMd.sizeBytes` (and `agentsMd.sizeBytes`) | `number` (≥ 0) | — | `Buffer.byteLength(body, "utf8")` — the UTF-8 byte size of the file. |
| `claudeMd.headings[]` (and `agentsMd.headings[]`) | `string[]` | 50 | Ordered list of H1+H2 headings extracted from the markdown body. Trailing whitespace stripped; fenced code blocks tracked so `# foo` inside a ```-fence is NOT captured. |

**Bodies are NEVER stored** in the analysis envelope. Phase B reads the
full body itself (off the filesystem) if it needs the content. This is the
load-bearing budget guarantee: a 50 KB `CLAUDE.md` contributes ~1 KB of
envelope (the heading list), not 50 KB.

### `dfPresence` — is the dark-factory gate already wired here?

Schema: `z.object({ hooks, configJson, prWorkflow, cliPin })`. Owner
analyzer: **docs** (the same analyzer also probes for DF presence — both
concerns share a single tree walk).

| Field | Type | Cap | Source | Description |
|---|---|---|---|---|
| `dfPresence.hooks` | `boolean` | — | `.husky/` directory | `true` iff `.husky/` exists at root. Probe for the local-critic gate. |
| `dfPresence.configJson` | `boolean` | — | `.agent-review/config.json` | `true` iff the critic config exists. |
| `dfPresence.prWorkflow` | `boolean` | — | `.github/workflows/dark-factory-pr.yml` | `true` iff the hosted-critic Action is checked in. |
| `dfPresence.cliPin` | `string \| null` | — | root `package.json` `dependencies` then `devDependencies` | The verbatim version range / pin for `@momentiq/dark-factory-cli`, or `null` if absent. The string is captured AS-IS (e.g. `"2.0.0"`, `"^1.5.0"`, `"workspace:*"`); the analyzer does not normalize. |

### `decisions[]` — heuristic decision-surface markers

Schema: `z.array(DecisionSchema).max(10)`. Owner analyzer: **lockfile**.
Each entry is a deterministic dep-name match against the `DECISION_MARKERS`
table in `lockfile.ts`. Phase B's LLM polishes the narrative;
`decisions[]` is the Phase A skeleton.

| Field | Type | Cap | Source | Description |
|---|---|---|---|---|
| `decisions[].title` | `string` | — | (marker table) | Human-readable title (e.g. `"Repo uses Vitest as test framework"`, `"Frontend stack: Next.js"`). Verbatim from the `DECISION_MARKERS` entry. |
| `decisions[].surface` | enum (6 values) | — | (marker table) | One of `stack`, `test-framework`, `deploy-target`, `auth-model`, `ci-platform`, `other`. Classifies which decision dimension the marker informs. |
| `decisions[].evidence[]` | `string[]` | — | (lockfile path) | Repo-relative path(s) supporting the decision. In v1 always a single-element array `[lockfilePath]`. |

The global cap of 10 is intentionally low: `decisions[]` is meant to be a
sparse, high-signal skeleton, not an exhaustive enumeration. The first 10
matching markers (in lockfile-entry order) win; further matches are
silently dropped.

### `analyzerErrors[]` — first-class failure surface

Schema: `z.array(AnalyzerErrorSchema).default([])`. Owner: **orchestrator**.

| Field | Type | Cap | Source | Description |
|---|---|---|---|---|
| `analyzerErrors[].name` | `string` | — | (analyzer identifier) | The failing analyzer's `name` (one of `manifest`, `lockfile`, `ci`, `tree`, `git`, `docs`). |
| `analyzerErrors[].error` | `string` | — | (thrown `Error.message`) | The error message captured by `runAnalyzers` (`error.message` for `Error` instances, `String(error)` otherwise). |

See [§ Analyzer-error contract](#analyzer-error-contract) for the
contract Phase B branches on. The field's `.default([])` Zod modifier
guarantees it is always present in the validated output — even when no
analyzer failed, downstream code can read `analyzerErrors.length === 0`
without a `?.` chain.

## Why the 16 KB budget

The 16 KB serialized-size budget is a **hard contract** from cycle 15's
D2 exit criterion (*"RepoAnalysis JSON of bounded size (≤ 16 KB)"*).
Enforcement lives in [`analyze.ts`](../../packages/cli/src/onboard/analyze.ts)
as `REPO_ANALYSIS_BYTE_BUDGET = 16_384` and fires after Zod validation,
on the final `JSON.stringify(parsed).length` check.

The rationale is **Phase B's prompt-size budget**: Phase B's
LLM-tailoring step consumes the envelope verbatim inside a single model
call. Larger envelopes risk context-window truncation (which silently
drops fields the LLM needs to reason from) or forgetting (which degrades
the tailored output's fidelity to the source repo). 16 KB sits well below
the smallest practical critic-class model context window and leaves
substantial headroom for the prompt template + the `sage-blueprint`
ground-truth substrate Phase B layers in.

The budget is bounded by **three concentric layers**:

1. **Per-array `.max()` caps on the Zod schema** — the primary bound.
   Every list field has an explicit cap:

   | Field | Cap | Rationale |
   |---|---|---|
   | `stacks[]` | 12 | Polyglot monorepo headroom (most repos: 1–3). |
   | `services[]` | 30 | Multi-service mono-repo with up to ~30 services. |
   | `dependencies[]` | 20 | Top direct deps for ADR seeds; transitive deps excluded. |
   | `ci.workflows[]` | 50 | Workflow envelope per `.github/workflows/`. Bumped from 20 in cycle 15 Phase C — sage3c outgrew the original heuristic. |
   | `tree.topLevelDirs[]` | 30 | Repo-root directory enumeration. |
   | `tree.testDirs[]` | 20 | Test directories at depth ≤ 3. |
   | `docs.existing[]` | 50 | Documentation enumeration. |
   | `claudeMd.headings[]` / `agentsMd.headings[]` | 50 | Heading list per agent file. |
   | `decisions[]` | 10 | Heuristic skeleton, intentionally sparse. |

2. **Per-field structural bounds** — the second bound.
   `claudeMd` / `agentsMd` capture only `sizeBytes` + `headings[]`, NOT
   the body (cycle 15 D2 lines 142–145). The `tree.languageBreakdown`
   record is a flat extension → count map, not a per-file enumeration.
   `decisions[].evidence[]` is a single-path list, not a quote pile.
   Each structural decision was made to keep the per-field byte cost
   bounded irrespective of repo size.

3. **The final `JSON.stringify` byte check** — the backstop.
   After Zod validation succeeds, `analyze.ts` serializes the parsed
   envelope and asserts `length ≤ 16_384`. Overflow throws with a
   diagnostic message naming the likely overgrowth causes (oversized
   headings, decisions, or dependencies). This catches paths the
   `.max()` caps don't bound — e.g. an unusually long
   `canonicalName`, a heading list within cap but whose individual
   strings are each 800 bytes, a `languageBreakdown` with hundreds of
   exotic extensions, etc.

The backstop has never fired in fixture testing — the cap-based bounds
are sized so the realistic envelope fits with substantial headroom — but
the check is mandatory because Phase B's contract is **the envelope is
always ≤ 16 KB**, and a partial / silently-truncated envelope reaching
Phase B would be a worse failure mode than a loud Stage A error.

## Schema-versioning policy

The schema version is a single exported constant:

```ts
// packages/cli/src/onboard/schema.ts
export const AGENT_CONTEXT_SCHEMA_VERSION = 1 as const;
```

The literal `schemaVersion: 1` appears on every `RepoAnalysis` envelope.
Phase B reads this to pick its prompt template; future Phase B versions
may register multiple templates keyed by `schemaVersion`. Bumps are
**deliberate and infrequent**.

### When the version bumps

| Change | Bump? | Rationale |
|---|---|---|
| **Adding a new field to `RepoAnalysis`** | **BUMP** | `z.object({...}).strict()` rejects unknown fields. A consumer pinned to v1 cannot tolerate a new field added by a v1.x CLI release — it would fail validation. Adding a field is a structural change to the envelope shape. |
| **Renaming a field** | **BUMP** | Every consumer breaks. |
| **Changing a field's type** (e.g. `string` → `string \| null`) | **BUMP** | Downstream type assertions break. |
| **Removing a field** | **BUMP** | Every consumer that reads the field breaks. |
| **Tightening a cap** (e.g. headings cap 50 → 30) | **NO bump** | Any v1 payload that respects the new cap is still v1-valid; payloads that don't respect the new cap fail validation loudly at the producer. No silent semantic drift. |
| **Loosening a cap** (e.g. dependencies 20 → 30) | **BUMP only if Phase B's prompt-size budget can no longer accommodate the new max** | A loosened cap is technically additive — old payloads validate against the new schema — but if the new max breaks Phase B's prompt-size assumptions, the practical contract has changed. Otherwise it's a minor expansion and no bump is needed. |
| **Adding a new enum value to an existing field** | **BUMP** | A v1 consumer with an exhaustive switch on the old enum silently misses the new value. |
| **Tightening an enum** (removing a value) | **BUMP** | Any payload still emitting the removed value fails validation. |
| **Changing an analyzer's heuristic threshold** (e.g. conventional-commits 30% → 25%) | **NO bump** | Heuristic thresholds are implementation detail; the envelope shape and field meanings are unchanged. |
| **Adding a new detector to an existing analyzer** (e.g. teaching `manifest.ts` about Elixir) | **NO bump** | The envelope shape is unchanged; the same `language` enum value populates the new path. (If the new detector required a new enum value, that's the "Adding a new enum value" row above, which DOES bump.) |

### Coordination with Phase B

Phase B's LLM-prompt template version is coordinated with the schema
version. Bumping to v2 implies:

- Phase B registers a new template keyed by `schemaVersion: 2`.
- The CLI ships a single migration path: the v1 → v2 producer change
  lands in lockstep with the consumer change (one PR or a closely-
  scheduled pair).
- `df doctor` carries the schema version so an onboarded repo can detect
  drift between its scaffolded state and a newer envelope shape.

Phase A v1 is stable until Phase B proposes a v2 envelope. There is no
silent v1.x drift: the schema shape at v1 is what's documented here, and
that's what every published CLI version emits.

## Analyzer contributions

Six analyzers contribute to the merged envelope. Each implements the
`Analyzer` interface
([`analyzer.ts`](../../packages/cli/src/onboard/analyzer.ts)) — a single
async `detect(rootDir)` returning either `null` (opt-out) or a
`Partial<RepoAnalysis>`. The orchestrator runs them in parallel
(`Promise.all`), captures per-analyzer failures, and merges contributions
into a single envelope.

| Analyzer | Source file | Owns | Opts out when |
|---|---|---|---|
| **manifest** | [`analyzers/manifest.ts`](../../packages/cli/src/onboard/analyzers/manifest.ts) | `stacks[]` | No primary manifest AND no `.tool-versions` entries. |
| **lockfile** | [`analyzers/lockfile.ts`](../../packages/cli/src/onboard/analyzers/lockfile.ts) | `dependencies[]`, `decisions[]` | No lockfile present (`package.json` without a lockfile returns `null` — only a real lockfile yields pinned versions). |
| **ci** | [`analyzers/ci.ts`](../../packages/cli/src/onboard/analyzers/ci.ts) | `ci.workflows[]`, `ci.deployStory` | No `.github/workflows/` directory, or directory exists but contains no `.yml`/`.yaml` files. |
| **tree** | [`analyzers/tree.ts`](../../packages/cli/src/onboard/analyzers/tree.ts) | `tree.*`, `services[]` | Never (always returns at least an empty shape; throws on file-cap overflow). |
| **git** | [`analyzers/git.ts`](../../packages/cli/src/onboard/analyzers/git.ts) | `canonicalName`, `git.*` | Directory isn't a git repo, or repo has zero commits (no signal sample). |
| **docs** | [`analyzers/docs.ts`](../../packages/cli/src/onboard/analyzers/docs.ts) | `docs.*`, `dfPresence.*` | Never. Returns the full `docs`/`dfPresence` shape even on a fresh repo (all booleans default to `false`, lists default to empty). |

The merge rule in `analyzer.ts:mergeInto` is:

- **Array fields** are concatenated. Two analyzers contributing to
  `decisions[]` add their entries to the merged list (then truncated at
  the schema cap by the producer).
- **Object fields** are shallow-merged. Two analyzers contributing to
  `ci.*` merge into a single `ci` object.
- **Scalar fields** are last-write-wins (in analyzer iteration order).

In v1 no two analyzers contribute to the same field, so the merge
semantics are mostly degenerate. The pattern is in place so a future
analyzer can extend an existing field without restructuring.

## Analyzer-error contract

Per-analyzer failures are **surfaced, not silently dropped**. The
orchestrator wraps each `detect()` call in try/catch:

```ts
// packages/cli/src/onboard/analyzer.ts (excerpt)
try {
  return { name: a.name, value: await a.detect(rootDir), error: null };
} catch (e) {
  return { name: a.name, value: null,
           error: e instanceof Error ? e.message : String(e) };
}
```

Failures land in `RepoAnalysis.analyzerErrors[]` with the analyzer's
identifier and the error message. Three contract points downstream
consumers rely on:

1. **Partial-result reporting is the contract.** The orchestrator does
   NOT throw when a single analyzer fails. It records the failure,
   continues with the remaining analyzers' contributions, and returns
   a validated envelope. The 16 KB byte-budget check is the only
   condition that aborts the run.

2. **`analyzerErrors[]` is always present.** Zod's `.default([])`
   guarantees the field exists in the validated output even when no
   analyzer failed. Phase B and CLI consumers can branch on
   `analysis.analyzerErrors.length === 0` without an optional-chain
   guard.

3. **Phase B confidence-discounts on non-empty `analyzerErrors[]`.**
   The presence of any entry is the signal that the envelope is
   missing a domain. Phase B's documented behavior is to call this
   out in the tailored output (e.g. a note in the generated
   `CLAUDE.md` that "the analyzer couldn't read `.github/workflows/`,
   so CI conventions weren't detected") rather than silently emit a
   confident-but-incomplete scaffold.

The contract closes the silent-zero-evidence failure mode the cycle 15
spec calls out: an analyzer crash that left its fields unset would
otherwise leave Phase B reasoning over absence-of-evidence as if it were
evidence-of-absence. `analyzerErrors[]` is the loud signal that
distinguishes the two.

## See also

- [`packages/cli/src/onboard/schema.ts`](../../packages/cli/src/onboard/schema.ts)
  — the Zod schema. The source of truth for this doc.
- [`packages/cli/src/onboard/analyze.ts`](../../packages/cli/src/onboard/analyze.ts)
  — the orchestrator + 16 KB budget enforcement.
- [`packages/cli/src/onboard/analyzer.ts`](../../packages/cli/src/onboard/analyzer.ts)
  — the `Analyzer` interface + merge semantics.
- `docs/roadmap/cycles/cycle15-df-onboard-agent.md` (in
  [`momentiq-ai/dark-factory-platform`](https://github.com/momentiq-ai/dark-factory-platform)) —
  the cycle 15 spec covering the two-stage pipeline rationale, the
  Phase A → Phase B handoff, and the sage3c-quality validation
  harness.
