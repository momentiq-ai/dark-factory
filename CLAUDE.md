# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in `momentiq-ai/dark-factory`.

## What this repo is

**Dark Factory is pillar #1 of the momentiq.ai platform: the autonomous AI-native software development lifecycle.** This repo is the extraction target for the Dark Factory substrate being moved out of `momentiq-ai/sage3c` per cycle 331.1. Once extracted, it becomes the source-of-truth for:

- `@momentiq/dark-factory-cli` — OSS CLI binary (Cursor / Codex / Gemini / Grok adapters, min-complete-quorum aggregation)
- `@momentiq/dark-factory-schemas` — JSON Schemas for `darkfactory.yaml` + per-SHA evidence + cycle-doc trailer formats
- Reusable GitHub Actions workflows that external consumers reference via `uses: momentiq-ai/dark-factory/.github/workflows/<name>.yml@v0.1.0`

## Source-of-truth pointer (during W1)

**Until W2 onset** (cycle 331.1 Phase G + Phase H — sage3c + cerebe-platform migrate onto this extracted platform), the **source of truth for Dark Factory design + status is sage3c's roadmap and cycle docs**:

- Roadmap: [`momentiq-ai/sage3c:docs/roadmap/dark-factory-roadmap.md`](https://github.com/momentiq-ai/sage3c/blob/main/docs/roadmap/dark-factory-roadmap.md)
- Parent cycle: [`cycles/cycle331-dark-factory-platformization.md`](https://github.com/momentiq-ai/sage3c/blob/main/docs/roadmap/cycles/cycle331-dark-factory-platformization.md)
- Extraction cycle: [`cycles/cycle331.1-extract-from-sage3c.md`](https://github.com/momentiq-ai/sage3c/blob/main/docs/roadmap/cycles/cycle331.1-extract-from-sage3c.md)
- Manifesto (foundational principles): [`docs/engineering/ai-native-manifesto.md`](https://github.com/momentiq-ai/sage3c/blob/main/docs/engineering/ai-native-manifesto.md)

This file's [`docs/roadmap/dark-factory-roadmap.md`](docs/roadmap/dark-factory-roadmap.md) is a pointer that becomes canonical at W2 onset.

## Consumer adoption guide

If you're working on dark-factory itself: the consumer-side adoption pattern is documented at [`docs/CONSUMER-ADOPTION.md`](docs/CONSUMER-ADOPTION.md). When you change the public surface (CLI subcommands, reusable workflow inputs, schema fields, `.agent-review/config.json` shape), update that doc in the same PR. The doc is the contract every consumer repo is written against — drift between it and reality produces silent breakage in `taxpilot2a` / `lyra` / future external consumers.

Concrete examples cited there: [taxpilot2a PR #45](https://github.com/momentiq-ai/taxpilot2a/pull/45) (F.5a, first external consumer) + [PR #46](https://github.com/momentiq-ai/taxpilot2a/pull/46) (the cross-repo `actions/permissions/access` prereq).

## Consumer-vs-author posture

This repo is the **author** of `@momentiq/dark-factory-cli`, `@momentiq/dark-factory-schemas`, and the reusable workflows. `sage3c`, `cerebe-platform`, `sage-blueprint`, `taxpilot2a`, `lyra`, and future external consumers **consume** them via versioned npm devDeps + exact-tag reusable workflow references.

Practical implications when working here:

- **Breaking changes are expensive.** Every consumer's `package.json` pins to `0.1.0`; every consumer's `.github/workflows/*.yml` pins to `@v0.1.0`. A change that breaks the public API breaks every consumer. Bump the minor version (or major if semver demands it) and let consumers opt in.
- **Test against multiple consumers, not just self-dogfood.** Cycle 331.1 Phase F dogfoods inside this repo; Phase F.5a + F.5b validate against `taxpilot2a` + `lyra` BEFORE the sage3c migration (Phase G). The dogfood-only path is necessary but not sufficient.
- **Reusable workflows MUST be tagged at exact semver** (`@v0.1.0`, not `@v0`). Floating tags let upstream changes silently alter consumer CI; per-SHA reproducibility requires consumers to pin exactly.

## Claude Code Configuration

**Required defaults for all Claude Code sessions on this repository (humans and AI agents alike):**

- **Model:** `claude-opus-4-7-1m` (1M-context Opus)
- **Thinking:** `max`

Reason: code review and the local critic fleet are calibrated to Opus-quality output. Inconsistent model selection across the team means inconsistent review signal.

For headless invocations (e.g. agent-orchestrated work):

```bash
claude -p --model claude-opus-4-7-1m --thinking max --dangerously-skip-permissions "<task brief>"
```

Deviations are allowed for genuinely mechanical tasks (variable rename across files, formatting-only changes), but document the deviation in the PR body so reviewers calibrate accordingly.

## Architect-Orchestrator Mode

**The user (PJ) operates as lead architect and orchestrator, NOT a hands-on engineer.** Claude Code must:

1. **Own codebase navigation.** PJ gives architectural direction, not file paths. Independently explore and understand current state before implementing.
2. **Be autonomous for routine work.** Well-established patterns (new adapter shim, new schema field, mechanical refactor): implement end-to-end and present a concise summary.
3. **Be collaborative for novel/risky work.** New architectural patterns, complex debugging, risky changes: present a brief root cause analysis or design proposal (2-3 sentences + trade-offs) and get approval before implementing.
4. **Batch and parallelize.** When a change touches multiple packages, plan the full change set upfront and make parallel edits.
5. **Run gates autonomously.** Validate before declaring complete. Never ask PJ to validate what you can validate yourself.
6. **Keep communication concise.** Lead with the result, not the process.

## DF-platform IP split — baseline vs. calibrated

Two-tier prompt + policy model is load-bearing (resolves the "OSS CLI vs. closed-source IP" tension):

| Tier | Where it lives | License | Loaded by |
|---|---|---|---|
| **Baseline** prompts + classifiers | `packages/cli/prompts/baseline/*.md` + `packages/cli/src/policy/baseline-classifier.ts` inside this repo | Apache-2.0 (ships in npm tarball) | OSS CLI users by default; air-gap-capable |
| **Calibrated** prompts + classifiers | Separate **private** `momentiq-ai/dark-factory-prompts` repo (and `momentiq-ai/dark-factory-worker` for code) | Proprietary; never enters this repo's git history | Hosted App runtime only; checked out at container build time |

**Sentinel headers** distinguish them: baseline prompts start with `<!-- DF-PROFILE: baseline -->`, calibrated start with `<!-- DF-PROFILE: calibrated -->`. The CLI adapter validates the loaded prompt's profile header against the expected profile for the call site.

**What you must NOT do:**

- Do not commit any file with the `<!-- DF-PROFILE: calibrated -->` sentinel to this repo. The pre-push gate will block it (Phase B adds the check).
- Do not import calibrated classifier code from this repo's source. The dependency-injection contract is one-way: baseline ships here, calibrated is overlaid at App runtime.
- Do not reference the private prompts repo by URL in any file shipped in the npm tarball. Internal repo docs may reference it for context.

## Worktree-First for All Branch Work (MANDATORY)

When working on **any** branch (cycles, features, docs, fixes — everything), **always use `EnterWorktree`** to create an isolated worktree before making changes. This prevents cross-branch contamination and enables multiple Claude Code sessions to run in parallel.

- Use `EnterWorktree` with a descriptive name (e.g., `cycle331.1-phase-B`) at the start of any work that creates or uses a branch.
- Each worktree gets its own directory under `.claude/worktrees/` with a fully independent checkout.
- Never switch branches with `git checkout` in the main repo when worktrees exist — work inside the worktree instead.
- On session exit, you'll be prompted to keep or remove the worktree.

**Why this matters**: without worktrees, two concurrent sessions (or careless branch switching) can commit to the wrong branch. Worktrees make this impossible.

## No-human-review posture (mirrors sage3c)

This repo runs under the same Dark Factory ruleset family as sage3c — the `main1` ruleset, committed at `.github/rulesets/main.json` and **active** on `main`. It enforces:

- `required_approving_review_count: 0`
- `require_code_owner_review: false`
- `require_last_push_approval: false`
- `required_review_thread_resolution: true` — every bot review thread (Cursor Bugbot, OpenAI Codex, Copilot, `@claude`) MUST be marked Resolved before the merge queue admits the PR.

**Auto-merge is the default for non-draft PRs.** Immediately after `gh pr create`, run:

```bash
gh pr merge --auto --squash
```

Plan PRs (cycle docs) start as `--draft` and only get auto-merge after `gh pr ready` (so user architectural feedback happens before the queue can admit them). Code PRs enable auto-merge immediately.

> **Note**: the `main1` ruleset is **active** (`enforcement: active`; the committed `.github/rulesets/main.json` matches the live ruleset). The merge queue is gated on five **required status checks** — `pr-status-check`, `schema-check`, `agent-critic`, `cycle-doc-validation`, `branch-protection-audit` — plus required review-thread resolution and `copilot_code_review`. The hosted `dark-factory/critic` check is **not** required, so its failures do not block the queue. A required check that fails OR cancels (e.g. an `agent-critic` hang past the job timeout — issue #167) blocks the queue until it is re-run. Changing the live ruleset is a PJ-only org-write action.

## Iteration-trap — N=2 ceiling

The Dark Factory ratchet pattern: critics iterate, but bounded. **If you've made 2 rounds of fixes and a third round of findings on the same finding-class is appearing, STOP iterating and surface to PJ.** This is a structural anti-pattern (`iteration-trap-large-doc` / `iteration-trap-large-code` per cycle 333's pattern catalog), not a "keep trying" signal.

**Same finding-class** does NOT require literally the same finding text. *Any* new critic finding introduced by a fix is a thrash signal, **regardless of**:

- **Severity drop** (`[high]` → `[medium]` is *not* convergence — the underlying drift class is still firing).
- **Location change** (a finding in a different file or section is *not* progress — your patch surfaced a new location of the same structural problem).
- **Vendor agreement** (cross-vendor consensus on a thrash-triggered finding is *real signal*, but the right response is **restructure**, not **patch**).

Common triggers:

- Each round of fixes introduces new findings (`critic-finding-regression-on-rebase`).
- Findings flagged `requiresHumanJudgment: true` — genuinely subjective; don't iterate.
- You're touching files that aren't in your PR's original scope.
- A fix you made introduced a NEW critic finding — that's cascading scope creep.

**Mandatory response at the 2nd consecutive round of fix-introduced findings:** call `advisor` + identify the structural cause + apply DRY / restructure to the doctrine or content being iterated on, **before** any further FIX attempt. The advisor tool takes no parameters — it auto-forwards full context — so the only cost is wall-clock.

**Mandatory advisor cadence:** at 2+ critic-iteration rounds with zero advisor calls, the advisor call becomes mandatory by round 3 (the advisor sees the full iteration arc and identifies structural causes that per-round triage cannot).

Motivating evidence: `momentiq-ai/dark-factory-platform#218` took 14 critic-iteration rounds because the agent rationalized past the prior (looser) "same critic finding" framing — each round's finding was technically *different* (different file, different severity, different section), but they were all the same finding-class: doctrine drift caused by restating the same complex contract in too many places.

When you hit the N=2 ceiling, file a tracking issue, surface the situation, and stop. Do not bypass; do not amend.

## Pre-existing main-branch blockers

When a gate fails and the failure is **not** caused by your PR's diff (an issue inherited from `origin/main` that happens to route through your PR via path filters), do NOT chase the fix down a rabbit hole.

**Triage (mandatory):** before declaring a failure "pre-existing", verify it in a **disposable worktree** so you don't disturb your active branch state.

```bash
git worktree add /tmp/main-pristine origin/main
( cd /tmp/main-pristine && <failing-gate> )   # subshell so you stay in your branch
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

## Cycle Lifecycle — pointer to sage3c during W1

During W1 extraction, this repo follows sage3c's Cycle Lifecycle documented in [`momentiq-ai/sage3c:CLAUDE.md`](https://github.com/momentiq-ai/sage3c/blob/main/CLAUDE.md) (Three Work-Shape Tiers, Plan PR → Code PR shape, auto-merge default, post-closure follow-up PRs).

Code PRs in this repo cite the sage3c cycle they're driven by (`Cycle: 331.1`) until W2 onset, when this repo gets its own cycle-doc validator (Phase B extraction) and stands alone. Until then, the cycle-doc validation gate runs against sage3c's cycle directory references.

## Reusable workflow conventions (consumer contract)

This is the **author** side of the reusable workflows; treat the consumer contract as load-bearing.

- **Exact-semver tags only** (`@v0.1.0`, never `@v0`). Floating major tags let upstream silently alter consumer CI. Phase E ships an exact-tag-only release-CI guard.
- **Workflow-controlled install path**. The reusable workflow downloads the CLI tarball directly via `npm pack @momentiq/dark-factory-cli@$EXPECTED_CLI_VERSION`, verifies the workflow-baked `EXPECTED_INTEGRITY`, and extracts to `$RUNNER_TEMP/df-trusted-*`. Gate steps invoke `$DF_BINARY` (NOT `./node_modules/.bin/dark-factory`, which would expose the lockfile-substitution attack). See cycle 331.1 § Reusable workflow shapes for the full security model.
- **Secrets passed by the consumer, NOT inherited.** Each reusable workflow declares its `secrets:` block explicitly. Consumers pass via `secrets: inherit` or per-secret mapping. Missing secrets fail closed with a structured remediation hint.
- **Two paths converge on the same version pin.** Local Husky (consumer's project-local `./node_modules/.bin/dark-factory` from the committed lockfile) and CI workflows (workflow-baked `EXPECTED_CLI_VERSION` + integrity) MUST resolve to the same CLI version. The `dark-factory doctor` subcommand surfaces drift between them.

## Pre-commit / pre-push expectations

Once Phase B ships the CLI:

- `npm test` at the workspace root must pass for every commit (per-package tests + bundle-shape assertion + cross-package contract tests).
- `npm run build --workspaces` must produce the fully-bundled `dist/index.js` artifact with zero runtime `dependencies` declared (Phase B build contract).
- Local critic hooks (`.husky/post-commit` + `.husky/pre-push`) run the same critic fleet sage3c uses — this repo dogfoods its own product.

Until Phase B lands, this repo has no test corpus. Phase A commits go in directly; subsequent phases bring their own validation gates.

## Important conventions

### Documentation

- **No human review required** does NOT mean "no human reads the docs." Architecture changes, new cycle phases, breaking changes — all surface to PJ via concise summary before commit.
- **Pseudocode must be 100% accurate.** Code examples in cycle docs, ADRs, READMEs, comments: all must be correct, compilable, follow real API signatures. Bad pseudocode gets copy-pasted into real implementations.
- **No backward-compatibility shortcuts** unless explicitly requested. Push forward to SOTA; rename/replace legacy paths; remove dead code immediately. (The exception is the consumer-contract surface — see Consumer-vs-author posture above.)

### Git workflow

- Worktree-first (above) — non-negotiable.
- Auto-merge default (above) — every non-draft PR gets `gh pr merge --auto --squash` immediately after `gh pr create`.
- Cite cycle: `Cycle: 331.1` (or sub-cycle as W1 progresses).
- Post-closure follow-up PRs: NO `Cycle:` trailer pointing at a terminal-status cycle. Use `Issue: #<N>` or `Closes #<N>`.

### Secrets

- This repo's CI consumes `MOMENTIQ_NPM_READ_TOKEN` to publish to the private `@momentiq` npm scope (until 331.3 public-flip).
- No Doppler bootstrap in this repo until Phase B brings the test/eval CLI subcommands that need vendor critic keys.
- Never commit secrets. The `.gitignore` excludes `.env*` and `.doppler*`; the trusted-surface rebind in Phase B will add `package.json` + `package-lock.json` to the rebind allowlist so a PR cannot self-modify which package gets installed.

## Repo structure (target — populated through Phase F)

```
momentiq-ai/dark-factory/
├── packages/
│   ├── cli/          # @momentiq/dark-factory-cli (Phase B)
│   └── schemas/      # @momentiq/dark-factory-schemas (Phase C)
├── scripts/          # Python scripts moved from sage3c/scripts/ci/ (Phase C)
├── .github/
│   ├── workflows/    # Reusable workflows (Phase E)
│   ├── rulesets/     # Branch ruleset mirror (Phase A — this commit)
│   └── CODEOWNERS    # Phase A — this commit
├── tests/            # Cross-package contract tests (Phase B onward)
├── docs/
│   ├── architecture.md       # Service boundaries (Phase B)
│   ├── consumer-guide.md     # How sage3c / cerebe-platform / sage-blueprint consume (Phase G prep)
│   └── adapter-development.md  # How to add a new critic adapter (Phase B)
├── package.json      # workspaces root (Phase A — this commit)
└── README.md         # Phase A — this commit
```

## When in doubt

- Read the parent cycle doc on sage3c (`docs/roadmap/cycles/cycle331.1-extract-from-sage3c.md`). It's the spec.
- If the spec doesn't cover the situation, surface to PJ with a concise design question (2-3 sentences + trade-offs). Don't guess.
- N=2 iteration ceiling applies here as much as anywhere — if your second attempt is producing the same shape of finding the first did, stop and ask.
