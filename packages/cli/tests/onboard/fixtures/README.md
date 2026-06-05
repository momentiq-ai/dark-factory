# Onboard analyzer ground-truth fixtures

Cycle 15 Phase A — Task 11 deliverable. Each subdirectory captures a real
reference repo at a pinned `git` sha as a bounded, structural snapshot that
the Phase A integration test (Task 12) replays into a synthetic git repo
and feeds to `analyze()` for a deep-equal regression check.

## Purpose

`analyze()` returns a `RepoAnalysis` envelope — the deterministic Stage A
output the Phase B LLM consumes. The integration test guarantees:

1. The analyzer composition (6 domain analyzers + orchestrator + Zod
   validation + 16 KB budget) keeps producing identical output for the
   four reference repos as the codebase evolves.
2. Real-world repo surfaces (multi-stack monorepos, Next.js apps, sage3c's
   heavy CI sprawl, and a near-empty prototype) are exercised — not just
   the synthetic unit-test cases.
3. The `RepoAnalysis` JSON stays under the 16 KB budget (a hard contract
   from the Cycle 15 D2 exit criteria) on real fixture data.

When a future analyzer change perturbs any golden, the default response is
to fix the analyzer (or revert), **not** to rebuild the golden. See
"Rebuild policy" below.

## File shape per fixture

Each `<repo>/` directory contains exactly three files:

| File | What it is |
|---|---|
| `tree.tar.gz` | Structural snapshot of the source repo (manifests, workflows, docs presence markers, slimmed lockfile). Target ≤ 50 KB; over-budget overshoots are documented per-fixture below. |
| `git-history.txt` | Compact line-oriented capture of `git remote get-url origin`, the default branch, and `git log --pretty=%s -200 --reverse`. Used by `replayGitHistory()` to materialize a synthetic `.git` over the extracted tarball. |
| `golden.json` | The `analyze()` output over the tarball-extracted + history-replayed tree, with `repoRoot` normalized to `"<NORM>"`. The deep-equal regression baseline. |

The tarball does **not** include a `.git` directory — see "Why
`git-history.txt`" below.

## What's INSIDE `tree.tar.gz`

Per Task 11's spec, the snapshot includes ONLY structural files (the
union of):

- Root manifests: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`,
  `Gemfile`, `mix.exs`, `pom.xml`, `build.gradle.kts`, `.tool-versions`,
  `.python-version`, `.nvmrc`, `.ruby-version`, `Dockerfile`. Full content
  (manifest analyzer parses them).
- Root lockfile: `package-lock.json` / `yarn.lock` / `poetry.lock` / `go.sum`.
  **Slimmed** to the top-20 direct deps with pinned versions (the
  lockfile analyzer's MAX_DEPS cap) so the tarball doesn't get blown out
  by node_modules-shadow trees (DFP's real `package-lock.json` is 124 KB).
- `.github/workflows/*.yml`/`*.yaml`. Full content (CI analyzer parses
  them). Capped at 50 alphabetically to mirror the schema cap on
  `ci.workflows` (bumped from 20 in cycle 15 Phase C — sage3c has 28
  workflows; the previous 20 cap rejected real consumer repos at the
  Zod boundary). Existing golden fixtures were generated at the old
  cap (20); they remain valid against the new schema (any list ≤ 50
  passes), and regenerating them is a deliberate manual step.
- Root docs: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`,
  `ARCHITECTURE.md`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`. Truncated to
  `# truncated for fixture\n` when the tarball would otherwise overshoot
  the 50 KB target (DFP's CLAUDE.md alone is 35 KB).
- `docs/**/*.md` (full recursive walk; preserves relative paths). Same
  truncation policy as the root docs.
- `services/<child>/.fixture-placeholder`, `apps/<child>/.fixture-placeholder`,
  `packages/<child>/.fixture-placeholder` — one empty marker per immediate
  child so the tree analyzer's service discovery still fires.
- `.husky/.fixture-placeholder` — directory-presence marker for
  `dfPresence.hooks`.
- `.agent-review/config.json` — stub `{}` (the docs analyzer only checks
  isFile; never reads contents).

Anything else (source code, helm charts, terraform, build artifacts,
test fixtures) is excluded — none of it is read by the Stage A
analyzers.

## Why `git-history.txt` (and NOT a shipped `.git`)

The git analyzer (`src/onboard/analyzers/git.ts`) reads three things from
the live repo:

1. `git remote get-url origin` → `canonicalName`.
2. `git symbolic-ref refs/remotes/origin/HEAD` → `git.defaultBranch`.
3. `git log --pretty=%s -200` → `git.recentCommitConventions.{conventional,
   cycleReferenced}`.

Shipping each fixture's full `.git` directory would (a) bloat the
fixtures with object packs (sage3c's `.git` is hundreds of MB) and (b)
tie the fixtures to the upstream repos' HEAD evolution every time
`origin/HEAD` advances. Instead, the fixture builder captures the three
inputs above into a compact text companion that the integration test
replays into a real synthetic git repo on extract.

The replay helper lives in
[`src/onboard/fixtures/replay-git-history.ts`](../../../src/onboard/fixtures/replay-git-history.ts)
— that file is the canonical source of truth for the `git-history.txt`
format and the replay semantics. The build script and the integration
test BOTH use it, so the golden generation and the regression test always
agree on what the git analyzer will see.

### Format

```
# git-history.txt for fixtures/<name>/
# Generated by build-fixture.ts at <pinned-sha> on YYYY-MM-DD.
canonical: <owner>/<name>
defaultBranch: <branch>
remote: https://github.com/<owner>/<name>.git

# Last 200 subject lines (oldest -> newest), captured via:
#   git log --pretty=%s -200 --reverse
subjects:
<subject 1>
<subject 2>
...
<subject 200>
```

Lines starting with `#` are comments; a blank line separates the metadata
block from the `subjects:` block. Authors / dates / SHAs are NOT
preserved — only the canonical remote, default branch, and the subject
stream.

A future maintainer who sees `git-history.txt` next to `tree.tar.gz` and
thinks "ah, redundant companion file" — please do NOT delete it. Without
it the git analyzer returns `null`, the four goldens silently bless
missing/default fields, and the integration test becomes a degenerate
no-op (this was the codex blocker on Task 7 that motivated the design).

## Pinned shas

| Repo | Pinned sha | Build date | Tarball size | Notes |
|---|---|---|---|---|
| `momentiq-ai/dark-factory-platform` | `d7a490ed6c265cb7da69711410cc84dfddc92a20` | 2026-06-03 | 20 KB | TypeScript monorepo, 5 services |
| `momentiq-ai/sage3c` | `8eeec9e911deee4ac23a482fe72f4e50b172c210` | 2026-06-03 | 137 KB | Over-budget; sage3c has unusually heavy workflow YAMLs (`agentic-eval-loop.yml` alone is 44 KB). Workflows are full-content because the CI analyzer parses them — slimming them would change `golden.json`. Documented as an accepted overshoot. |
| `momentiq-ai/dark-factory-dashboard` | `8df128e77ee4b5b1aaede7e10e5ac8182a6fb83e` | 2026-06-03 | 40 KB | Next.js dashboard, no `services/` |
| `momentiq-ai/cognaa-protoapp` | `11f1185db34db0b611d6efee7706227f816d6f2f` | 2026-06-03 | 351 B | Degenerate edge case — repo contains a single `index.html` and one commit. Exercises the analyzer's near-empty-repo path. |

## Rebuild command

The fixture builder is `packages/cli/scripts/build-fixture.ts`. It does
all six steps end-to-end (clone → stage → tarball → capture history →
replay → run `analyze()` → write golden):

```bash
# From the repo root:
cd dark-factory
npx tsx packages/cli/scripts/build-fixture.ts \
  --repo <owner/name> \
  [--ref <pinned-sha>] \
  --dest packages/cli/tests/onboard/fixtures/<repo>/
```

`--ref` is optional; without it the script captures the source clone's
HEAD when it ran and prints the resolved sha to stdout (paste it into
the table above when rebuilding).

The script uses `gh repo clone` with NO `--depth` flag — shallow clones
break `git log -200` on small histories AND triggered the 2026-06-02
`d2669eb` incident. Full clone, full history, full responsibility.

The CLI must be built first so the script can import `analyze()` and the
replay helper from `dist/`:

```bash
npm run build --workspace=@momentiq/dark-factory-cli
```

(The script falls back to a fresh in-process build if you run it via
`tsx` from the workspace root and `dist/` is missing; if you see
`ERR_MODULE_NOT_FOUND` for `dist/onboard/analyze.js`, build first.)

## Rebuild policy

A fixture's golden is **byte-stable**. If the integration test's
deep-equal fails:

1. **First, suspect the analyzer change**, not the fixture. Run the
   failing test, inspect the divergence, and ask: is the new behavior
   intentional? If not, revert / fix the analyzer.
2. **Only rebuild a golden** when the analyzer change is intentional
   AND the fixture's previous output is now wrong. Rebuild MUST be its
   own commit with a rationale message:

   ```
   test(onboard): rebuild fixtures — <reason>

   <one-paragraph explanation of which analyzer changed,
   what the golden delta is, and why the new golden is the
   right baseline going forward>
   ```

3. **Do NOT rebuild a golden just to refresh upstream-repo evolution**
   (new commits, new workflows, new docs). The point of pinning the sha
   is that the fixture is frozen in time — a rebuild for "the source
   repo moved on" defeats the regression baseline. The pinned shas
   advance only when there's a structural reason (e.g. the source repo
   added a new manifest format the analyzer should detect; rebuilding
   the fixture exercises that path).

The Cycle 15 exit criteria treat the fixture goldens as a hard regression
contract — same posture as the schema's 16 KB byte budget.

## Validation snippet

```bash
# All four fixtures present?
ls -la packages/cli/tests/onboard/fixtures/*/

# All tarballs in budget? (sage3c overshoots; see table above)
du -sh packages/cli/tests/onboard/fixtures/*/tree.tar.gz

# Pick one and spot-check the golden's git-domain fields:
node -e 'const a = require("./packages/cli/tests/onboard/fixtures/dark-factory-platform/golden.json");
         console.log(a.schemaVersion, a.canonicalName, a.git.defaultBranch);'
# → 1 momentiq-ai/dark-factory-platform main
```

The full deep-equal regression check runs as the integration test
(Task 12, `tests/onboard/integration.test.ts`).
