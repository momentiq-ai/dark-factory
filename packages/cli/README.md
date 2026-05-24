# @momentiq/dark-factory-cli

Dark Factory OSS CLI — multi-vendor adversarial critic orchestration.

## What this package gives you

All nine Dark Factory services extracted from sage3c, today consumable as a
TypeScript library and (for the Python-backed and Phase D services) as `df`
subcommands:

1. **Critic Orchestrator** (`./adapters/*`) — vendor-neutral adapter contract
   (`CriticAdapter`) with concrete adapters for Cursor SDK, OpenAI Codex SDK,
   Google Gemini, and Grok (xAI via OpenAI-compatible API).
2. **Policy Engine** (`./policy/*`) — gate evaluation, min-complete-quorum
   aggregation, TDD classifier, finding-rubric strip, verification routes,
   profile resolution, and config loading.
3. **Trusted-Surface Rebind** (`./trusted-surface/*`) — when a commit modifies
   the trusted policy surface (config + guidance files + prompt fragments),
   the rebind reads those inputs from the parent ref so the commit is reviewed
   against the prior baseline (self-modification guard).
4. **Per-SHA Evidence Store** (`./evidence/*`) — canonical per-SHA quality-gate
   evidence path layout + runner that writes/reads evidence files atomically.
5. **Cycle-Doc Trailer Validator** (`./cycle-doc-validator/*` + `df validate-cycle-doc`)
   — enforces per-PR `Cycle:` / `Issue:` / `ProjectItem:` trailer rules.
6. **Merge Queue Admission Policy** (`./policy/merge-queue.ts` + `df admit-pr`) —
   plan-vs-code PR classifier (the same heuristic sage3c's plan-PR review gate
   uses) + the typed ruleset shape (`defaultMainRulesetShape`,
   `defaultCeReviewRulesetShape`, `defaultMergeQueueRule`) that consumers
   declare so the branch-protection auditor can detect drift against it.
7. **Branch-Protection Drift Detector** (`./branch-protection/*` + `df audit-branch-protection`)
   — compares a declarative `spec.yaml` against the live GitHub ruleset.
8. **Audit / Compliance Trail** (`./evidence/audit-trail.ts` + `df audit stats`) —
   the `_runs.ndjson` NDJSON sink + read/summarize/agreement-rate/quorum-stats
   helpers behind the legacy `make agent-review-stats`. Every critic run,
   every gate verdict, every bypass invocation appends here.
9. **Cycle Tracker Sync + PR Attribution** (`./cycle-tracker-sync/*` + `df sync-trackers` + `df attribute-pr`)
   — reconciles GitHub tracker issues with cycle docs + writes the
   `Cycle Ref` custom field on PR project items.

After Phase D all nine services are present in the package. Phase E adds the
reusable GitHub workflows that consumers wire up via `uses:`.

## Status

`0.1.0-alpha.2` — extracted from `momentiq-ai/sage3c:tools/agent-review/` +
`scripts/ci/` per cycle 331.1 Phases B, C, and D. Library API is stable; the
binary's `review`/`gate`/`doctor` subcommands are still stubs (Phase E).

## Install

```bash
npm install @momentiq/dark-factory-cli
```

## Library usage

```ts
import {
  runReview,
  evaluateCommitGate,
  buildReviewPacket,
  loadAgentReviewConfig,
  runValidateCycleDoc,
  runAuditBranchProtection,
  runSyncCycleTrackers,
  runAttributePrCycleRef,
} from "@momentiq/dark-factory-cli";

const loaded = await loadAgentReviewConfig(repoRoot);
const outcome = await runReview({ loaded, /* ... */ });

// Service #5 — validate a PR's cycle/issue trailers (subprocess-wraps the
// bundled Python script). Inherits stdio by default.
await runValidateCycleDoc({
  env: { PR_NUMBER: "1234", PR_TITLE: "feat: ...", PR_BODY: "..." },
});
```

## CLI

```bash
df --help
df --version

# Phase C subcommands — each forwards remaining argv to the bundled Python
# script verbatim, so `df <sub> --help` returns the Python argparse banner.
df validate-cycle-doc --help
df audit-branch-protection --use-bundled-default-spec --repo owner/repo
df sync-trackers --dry-run
df attribute-pr  # env-driven; needs PR_NUMBER, PR_NODE_ID, PR_BODY_FILE, PROJECT_TOKEN

# Phase D subcommands — pure-TS, parse flags directly.
df audit stats --path .git/agent-reviews/_runs.ndjson
df admit-pr --files-stdin   # newline-separated file paths on stdin
df admit-pr --files docs/roadmap/cycles/cycle331.md,packages/cli/src/cli.ts
```

> **Note on `--use-bundled-default-spec`**: the bundled `spec-default.yaml`
> mirrors the sage3c-shaped branch-protection posture (e.g., asserts the
> `agent-critic` and `cycle-doc-validation` required contexts). It exists
> as a working starting point for first-run audits and the standalone
> repo's own dogfood gate. Consumers SHOULD author their own `spec.yaml`
> matching their repo's actual posture — running the bundled default
> against an arbitrary repo will surface drift against contexts that
> don't exist there.

The Phase E subcommands (`review`, `gate`, `doctor`) are stubbed and exit 2
with a "not implemented" message pointing at the library API.

## System requirements

- **Node.js >=20**
- **Python 3.11+** — required for services #5, #7, #9. The Phase C extraction
  bundles the original Python scripts (`validate_cycle_doc.py`,
  `audit_branch_protection.py`, `sync_cycle_trackers.py`,
  `attribute_pr_cycle_ref.py`) and wraps each in a TypeScript subprocess
  spawn. The pure-TS rewrite is tracked as Phase C-PORT follow-up and will
  eliminate this dependency in a future release.
- **`gh` CLI** (authenticated) — all four Python scripts shell out to `gh api`
  for GitHub queries. CI invocations provide `GH_TOKEN` / `PROJECT_TOKEN`
  via environment.
- **`git`** on `PATH` — the rebind + config-from-ref code paths shell out
  to git, and the Python scripts use `git rev-parse --show-toplevel` to
  discover the consumer repo root.

### Repo root detection for Python-backed services

The bundled Python scripts resolve the consumer repo root in this order:

1. `$DF_REPO_ROOT` environment variable (explicit override).
2. `git rev-parse --show-toplevel` from the current working directory.
3. Legacy `__file__`-relative fallback (preserved for in-tree dev-mode
   pytest runs).

The TypeScript wrappers set `DF_REPO_ROOT` automatically when a `repoRoot`
option is supplied — pass it when invoking outside a git worktree.

## License

Apache-2.0. The OSS critic surface is a public artifact. Calibrated prompts
and the App's calibrated bypass-classifier are out-of-scope here and live in
private repos (see [parent cycle 331](https://github.com/momentiq-ai/sage3c/blob/main/docs/roadmap/cycles/cycle331-dark-factory-platformization.md)).
