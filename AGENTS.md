# AGENTS.md

Universal guidance for AI coding agents working in the `momentiq-ai/dark-factory` repository.

This file targets ALL agent-assisted development tools: Claude Code, GitHub Copilot, Cursor, Codex, Gemini CLI, Windsurf, Cline, and any future AI coding agent. For Claude Code-specific overrides, see [`CLAUDE.md`](CLAUDE.md).

## Source of Truth Hierarchy

When guidance conflicts, follow this priority order (1 = highest):

1. **CLAUDE.md** — Claude Code-specific overrides
2. **AGENTS.md** — Universal agent guidance (this file)
3. **Inline code comments and docstrings**
4. **Established codebase conventions** (inferred from existing patterns)
5. **Framework documentation** (TypeScript, Node, Ajv, etc.)

Higher-numbered sources yield to lower-numbered ones.

## Repository Stance

**This repo is the AUTHOR side of Dark Factory** — the OSS CLI + reusable workflows + schemas that downstream consumers depend on. Concretely, this repo publishes:

- `@momentiq/dark-factory-cli` — OSS CLI binary (Cursor / Codex / Gemini / Grok adapters, min-complete-quorum aggregation)
- `@momentiq/dark-factory-schemas` — JSON Schemas for `darkfactory.yaml` + per-SHA evidence + cycle-doc trailer formats
- `@momentiq/sage-cli` — Sage scaffolder CLI
- Reusable GitHub Actions workflows referenced via `uses: momentiq-ai/dark-factory/.github/workflows/<name>.yml@v0.1.0`

Consumers (`sage3c`, `cerebe-platform`, `dark-factory-dashboard`, `sage-blueprint`, `taxpilot2a`, `lyra`, and future external repos) pin to versioned npm devDeps + exact-tag reusable workflows. The author-vs-consumer split is load-bearing — see [Consumer-vs-author posture](#consumer-vs-author-posture) below.

## Non-Negotiable Rules

Every agent, every change, every time. No exceptions.

1. **Quality gates before completion**: `npm test`, `npm run build`, and `npm run type-check` at the workspace root must pass before declaring any work done. Run `npm run build` BEFORE `npm test` from a fresh install — the cli test suite consumes built schemas from `@momentiq/dark-factory-schemas`.
2. **Worktree-first for branches**: Always create a `git worktree` for branch work. Never switch branches in the main checkout. Each agent session works under `.claude/worktrees/`.
3. **No secret exposure**: Never hardcode secrets, API keys, or credentials. The `.gitignore` excludes `.env*` and `.doppler*`. CI uses `MOMENTIQ_NPM_READ_TOKEN` for the private `@momentiq` npm scope (until 331.3 public-flip) — never echo, log, or commit it.
4. **No destructive git without confirmation**: Never run `git push --force`, `git reset --hard`, or `git clean -fd` without explicit user approval.
5. **Auto-merge is the default**: Immediately after `gh pr create` for a non-draft PR, run `gh pr merge --auto --squash`. Plan PRs start as `--draft` and only get auto-merge after `gh pr ready`.
6. **Cite the cycle**: Until W2 onset, every code PR includes a `Cycle: 331.1` trailer (or sub-cycle as W1 progresses). Post-closure follow-up PRs use `Issue: #<N>` or `Closes #<N>` instead.
7. **Accurate code examples**: All code in docs, comments, and planning materials must be compilable and use real API signatures. Bad pseudocode gets copy-pasted into production.
8. **N=2 iteration ceiling**: If you've made 2 rounds of fixes and a third round of findings on the **same finding-class** is appearing, STOP and surface to PJ. "Same finding-class" does not require literally the same finding text — *any* new critic finding introduced by a fix is a thrash signal, regardless of severity drop (`[high]` → `[medium]` is not convergence), location change (a finding in a different file is not progress), or vendor agreement (cross-vendor consensus is real signal but the right response is **restructure**, not **patch**). **Mandatory response at the 2nd consecutive round of fix-introduced findings**: call `advisor` (Claude Code) or the equivalent independent-reviewer capability in your tool + identify the structural cause + apply DRY / restructure to the doctrine or content being iterated on, **before** any further FIX attempt. **Mandatory advisor cadence**: at 2+ critic-iteration rounds with zero advisor calls, the advisor call is mandatory by round 3. Motivating evidence: `momentiq-ai/dark-factory-platform#218` took 14 rounds because the agent rationalized past the prior (looser) "same critic finding" framing.

## Consumer-vs-author Posture

This repo is the **author**. Consumer repos pin to versioned releases. Practical implications:

- **Breaking changes are expensive.** Every consumer's `package.json` pins to `0.1.0`; every consumer's `.github/workflows/*.yml` pins to `@v0.1.0`. A change that breaks the public API breaks every consumer. Bump the minor version (or major per semver) and let consumers opt in.
- **Test against multiple consumers, not just self-dogfood.** Phase F dogfoods inside this repo; Phase F.5a + F.5b validate against `taxpilot2a` + `lyra` BEFORE the sage3c migration (Phase G). Dogfooding alone is necessary but not sufficient.
- **Reusable workflows MUST be tagged at exact semver** (`@v0.1.0`, never `@v0`). Floating major tags let upstream silently alter consumer CI; per-SHA reproducibility requires consumers to pin exactly.
- **Update the consumer adoption guide in the same PR.** When changing the public surface (CLI subcommands, reusable workflow inputs, schema fields, `.agent-review/config.json` shape), update [`docs/CONSUMER-ADOPTION.md`](docs/CONSUMER-ADOPTION.md) in the same PR. Drift between that doc and reality produces silent breakage downstream.

## DF-platform IP Split — Baseline vs. Calibrated

Two-tier prompt + policy model is load-bearing (resolves the "OSS CLI vs. closed-source IP" tension):

| Tier | Where it lives | License | Loaded by |
|---|---|---|---|
| **Baseline** prompts + classifiers | `packages/cli/prompts/baseline/*.md` + `packages/cli/src/policy/baseline-classifier.ts` inside this repo | Apache-2.0 (ships in npm tarball) | OSS CLI users by default; air-gap-capable |
| **Calibrated** prompts + classifiers | Separate **private** `momentiq-ai/dark-factory-prompts` repo (and `momentiq-ai/dark-factory-worker` for code) | Proprietary; never enters this repo's git history | Hosted App runtime only; checked out at container build time |

**Sentinel headers** distinguish them: baseline prompts start with `<!-- DF-PROFILE: baseline -->`, calibrated start with `<!-- DF-PROFILE: calibrated -->`. The CLI adapter validates the loaded prompt's profile against the expected profile for the call site.

**What you must NOT do:**

- Do not commit any file with the `<!-- DF-PROFILE: calibrated -->` sentinel to this repo. The pre-push gate will block it (Phase B adds the check).
- Do not import calibrated classifier code from this repo's source. The dependency-injection contract is one-way: baseline ships here, calibrated is overlaid at App runtime.
- Do not reference the private prompts repo by URL in any file shipped in the npm tarball. Internal repo docs may reference it for context.

## Repository Layout

```
momentiq-ai/dark-factory/
├── packages/
│   ├── cli/          # @momentiq/dark-factory-cli
│   ├── schemas/      # @momentiq/dark-factory-schemas
│   └── sage-cli/     # @momentiq/sage-cli (Sage scaffolder)
├── .github/
│   ├── workflows/    # Reusable workflows (consumed by external repos)
│   ├── rulesets/     # Branch ruleset mirror
│   └── CODEOWNERS
├── docs/             # Architecture, consumer adoption, ADRs
├── package.json      # workspaces root
├── CLAUDE.md         # Claude-specific guidance
├── AGENTS.md         # This file
└── GEMINI.md         # Gemini pointer to AGENTS.md
```

## Development Commands

All commands run at the workspace root unless noted.

```bash
# First-time setup (or after pulling/switching branches with dep changes)
npm ci --include=dev

# Build all workspaces (schemas → cli → sage-cli, in that order)
npm run build

# Run all tests across all workspaces
npm test

# Type-check all workspaces (no emit)
npm run type-check

# Per-workspace operations
npm run build --workspace=@momentiq/dark-factory-cli
npm test --workspace=@momentiq/dark-factory-schemas
```

**Important**: From a fresh `npm ci`, run `npm run build` BEFORE `npm test`. The cli test suite imports built artifacts from `@momentiq/dark-factory-schemas`; running test before build will produce TypeScript "Cannot find module" errors that are NOT real test failures.

There is no Makefile in this repo. Everything goes through `npm` scripts in the workspace root `package.json`. There are no containers — Node ≥20 on the host is sufficient.

## Verifiable objectives (author at plan time)

A PR implementing a cycle/issue's acceptance criteria carries an explicit, agreed
objectives contract generated from the linked source — so "done" is proof-bound,
not free text. Author it at plan time (before writing code) via the `/objectives`
skill or directly:

- `df objectives derive --cycle <N> --apply` → `.darkfactory/objectives.yaml`
  (one objective per `## Exit criteria` item, `text-hash`-bound to its source;
  re-runs preserve `attestedBy`).
- Bind each objective's `attestedBy` to real proof — a `df verify` `route` or a
  named `test`. `critic` bindings are a labeled on-ramp only (joined post-hoc;
  they prove "the gate passed", not the criterion).
- Plan approval is the agreement; `df objectives check` verifies binding locally;
  declare victory at closeout with `df prove`, not free-text "done".

Tracking: `#207`.

## Pre-existing Main-branch Blockers

When a gate fails and the failure is **not** caused by your PR's diff (an issue inherited from `origin/main` that happens to route through your PR via path filters), do NOT chase the fix down a rabbit hole.

**Triage (mandatory):** verify the failure in a **disposable worktree** so you don't disturb your active branch state.

```bash
git worktree add /tmp/main-pristine origin/main
( cd /tmp/main-pristine && npm ci --include=dev && npm run build && <failing-gate> )
git worktree remove /tmp/main-pristine
# If the gate failed identically inside the disposable worktree, it's pre-existing.
```

**Protocol if pre-existing:**

1. **File a GitHub issue** describing the failure (label: `bug` or `tech debt`). Include the failing command, the error excerpt, and the workflow/file that's broken.
2. **Add a "Pre-existing failures" row to your PR description** linking the issue.
3. **Bypass with a structured reason** citing the triage:
   ```bash
   AGENT_REVIEW_BYPASS="<workflow> fails on main with <cause>; pre-existing, not in this PR's diff; tracked at #<issue>" git push
   ```

**Hard stops (do NOT bypass):**

- The failure IS in your PR's diff. Fix it.
- The fix is trivial (≤10 LOC, no test infra, adjacent to your scope). Fix it inline.

**Time budget:** if you've spent more than **30 minutes** trying to fix something pre-existing, that's the signal to issue-and-bypass instead.

## Reusable Workflow Conventions (Consumer Contract)

This is the **author** side of the reusable workflows; treat the consumer contract as load-bearing.

- **Exact-semver tags only** (`@v0.1.0`, never `@v0`). Floating major tags let upstream silently alter consumer CI. The release-CI guard ships in Phase E to enforce this.
- **Workflow-controlled install path.** The reusable workflow downloads the CLI tarball directly via `npm pack @momentiq/dark-factory-cli@$EXPECTED_CLI_VERSION`, verifies the workflow-baked `EXPECTED_INTEGRITY`, and extracts to `$RUNNER_TEMP/df-trusted-*`. Gate steps invoke `$DF_BINARY` (NOT `./node_modules/.bin/dark-factory`, which would expose the lockfile-substitution attack).
- **Secrets passed by the consumer, NOT inherited.** Each reusable workflow declares its `secrets:` block explicitly. Consumers pass via `secrets: inherit` or per-secret mapping. Missing secrets fail closed with a structured remediation hint.
- **Two paths converge on the same version pin.** Local Husky (consumer's project-local `./node_modules/.bin/dark-factory` from the committed lockfile) and CI workflows (workflow-baked `EXPECTED_CLI_VERSION` + integrity) MUST resolve to the same CLI version. The `dark-factory doctor` subcommand surfaces drift between them.

## Source-of-truth Pointer (During W1)

Until W2 onset (Phase G + Phase H), the **source of truth for Dark Factory design + status is sage3c's roadmap and cycle docs**:

- Roadmap: [`momentiq-ai/sage3c:docs/roadmap/dark-factory-roadmap.md`](https://github.com/momentiq-ai/sage3c/blob/main/docs/roadmap/dark-factory-roadmap.md)
- Parent cycle: [`cycles/cycle331-dark-factory-platformization.md`](https://github.com/momentiq-ai/sage3c/blob/main/docs/roadmap/cycles/cycle331-dark-factory-platformization.md)
- Extraction cycle: [`cycles/cycle331.1-extract-from-sage3c.md`](https://github.com/momentiq-ai/sage3c/blob/main/docs/roadmap/cycles/cycle331.1-extract-from-sage3c.md)
- Manifesto: [`docs/engineering/ai-native-manifesto.md`](https://github.com/momentiq-ai/sage3c/blob/main/docs/engineering/ai-native-manifesto.md)

This repo's [`docs/roadmap/dark-factory-roadmap.md`](docs/roadmap/dark-factory-roadmap.md) is a pointer that becomes canonical at W2 onset.

## Tool-specific Configuration

Each AI tool reads its own configuration format. `AGENTS.md` (this file) is the canonical source of truth — tool-specific configs are projections of these rules adapted to each tool's format.

| Tool | Config location | Purpose |
|------|----------------|---------|
| **Claude Code** | `CLAUDE.md`, `.claude/settings.json`, `.claude/agents/` | Primary guidance + model defaults + specialist agents |
| **Gemini CLI** | `GEMINI.md` | Pointer to AGENTS.md for Gemini |
| **All tools** | `AGENTS.md` (this file) | Universal authority — non-negotiable rules, architecture, patterns |

**Maintenance rule**: When updating guidance, update `AGENTS.md` first, then propagate to tool-specific files. Tool configs must never contradict this file.

## Change Discipline

Do not: silently alter public API contracts, weaken the trusted-surface security model, ship reusable workflow changes without bumping the exact-semver tag, pad a PR with unrelated cleanup, or commit secrets.

When in doubt, read the parent cycle doc on sage3c (`docs/roadmap/cycles/cycle331.1-extract-from-sage3c.md`). It is the spec. If the spec doesn't cover the situation, surface a concise design question (2-3 sentences + trade-offs) before guessing.
