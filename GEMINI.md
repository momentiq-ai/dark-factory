# GEMINI.md

Project context for Google Gemini CLI when working in the `momentiq-ai/dark-factory` repository.

## Source of Truth

For complete agent guidance, see [`AGENTS.md`](AGENTS.md). For Claude Code-specific overrides, see [`CLAUDE.md`](CLAUDE.md). This file provides Gemini CLI with essential project context; the operational rules in `AGENTS.md` are authoritative.

## Project Overview

**Dark Factory is pillar #1 of the momentiq.ai platform: the autonomous AI-native software development lifecycle.** This repo is the AUTHOR side — it publishes:

- `@momentiq/dark-factory-cli` — OSS CLI binary (Cursor / Codex / Gemini / Grok adapters, min-complete-quorum aggregation)
- `@momentiq/dark-factory-schemas` — JSON Schemas for `darkfactory.yaml` + per-SHA evidence + cycle-doc trailer formats
- `@momentiq/sage-cli` — Sage scaffolder CLI
- Reusable GitHub Actions workflows referenced via `uses: momentiq-ai/dark-factory/.github/workflows/<name>.yml@v0.1.0`

Downstream consumers (`sage3c`, `cerebe-platform`, `dark-factory-dashboard`, `sage-blueprint`, `taxpilot2a`, `lyra`, and future external repos) pin to versioned npm devDeps + exact-tag reusable workflow references.

## Architecture

- **TypeScript monorepo** managed via npm workspaces (Node ≥20).
- **Packages**: `packages/cli`, `packages/schemas`, `packages/sage-cli`.
- **Build order**: schemas → cli → sage-cli (the cli depends on built schemas).
- **No containers, no Docker, no Doppler**: pure host-side Node tooling. CI uses GitHub Actions.
- **License**: Apache-2.0 for everything that ships in the npm tarball. Calibrated prompts/classifiers live in a separate private repo and never enter this git history.

## Key Directories

```
dark-factory/
├── packages/
│   ├── cli/          # @momentiq/dark-factory-cli
│   ├── schemas/      # @momentiq/dark-factory-schemas
│   └── sage-cli/     # @momentiq/sage-cli
├── .github/
│   ├── workflows/    # Reusable workflows (consumed by external repos)
│   ├── rulesets/     # Branch ruleset mirror
│   └── CODEOWNERS
├── docs/             # Architecture, consumer adoption, ADRs
├── package.json      # Workspaces root
├── AGENTS.md         # Universal agent guidance (authoritative)
├── CLAUDE.md         # Claude Code overrides
└── GEMINI.md         # This file
```

## Development Commands

```bash
npm ci --include=dev   # First-time setup or after pulling dep changes
npm run build          # Build all workspaces (schemas → cli → sage-cli)
npm test               # Run all tests (build first from a fresh install)
npm run type-check     # Type-check all workspaces
```

Run `npm run build` BEFORE `npm test` from a fresh install — the cli test suite consumes built schemas.

## Non-negotiable Rules (Summary)

See [`AGENTS.md`](AGENTS.md) for full detail. Highlights:

- **Worktree-first** for any branch work. Never switch branches in the main checkout.
- **Auto-merge** is the default for non-draft PRs (`gh pr merge --auto --squash` immediately after `gh pr create`).
- **Cite the cycle** (`Cycle: 331.1`) in every code PR until W2 onset. Post-closure follow-up PRs use `Issue: #<N>` / `Closes #<N>` instead.
- **Quality gates** before completion: `npm run build && npm test && npm run type-check` all green.
- **Public API is load-bearing.** Every downstream consumer pins to exact versions; breaking changes require a semver bump and a coordinated migration.
- **Exact-semver workflow tags only** (`@v0.1.0`, never `@v0`).
- **Calibrated prompt sentinel** (`<!-- DF-PROFILE: calibrated -->`) must never be committed here.
- **N=2 iteration ceiling** on critic findings — surface to PJ rather than chasing a third round.

## Pre-existing Main-branch Blockers

If a gate fails in CI and you can reproduce the same failure on a pristine `origin/main` worktree, it is pre-existing and not your responsibility to fix. Follow the protocol in [`AGENTS.md`](AGENTS.md) § Pre-existing main-branch blockers: file an issue, link it in your PR description, and bypass with `AGENT_REVIEW_BYPASS="<reason>; tracked at #<issue>" git push`. Time budget: 30 minutes max before issue-and-bypass.

## When in Doubt

Read [`AGENTS.md`](AGENTS.md) for the full operational ruleset and the cycle doc cited in your task brief. If the spec doesn't cover the situation, surface a concise design question (2-3 sentences + trade-offs) rather than guessing.
