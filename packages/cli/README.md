# @momentiq/dark-factory-cli

Dark Factory OSS CLI — multi-vendor adversarial critic orchestration.

## What this package gives you

Nine Dark Factory services, consumable as a TypeScript library and (where
relevant) as `df` subcommands:

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
   plan-vs-code PR classifier + the typed ruleset shape
   (`defaultMainRulesetShape`, `defaultCeReviewRulesetShape`,
   `defaultMergeQueueRule`) that consumers declare so the branch-protection
   auditor can detect drift against it.
7. **Branch-Protection Drift Detector** (`./branch-protection/*` + `df audit-branch-protection`)
   — compares a declarative `spec.yaml` against the live GitHub ruleset.
8. **Audit / Compliance Trail** (`./evidence/audit-trail.ts` + `df audit stats`) —
   the `_runs.ndjson` NDJSON sink + read/summarize/agreement-rate/quorum-stats
   helpers behind `make agent-review-stats`. Every critic run, every gate
   verdict, every bypass invocation appends here.
9. **Cycle Tracker Sync + PR Attribution** (`./cycle-tracker-sync/*` + `df sync-trackers` + `df attribute-pr`)
   — reconciles GitHub tracker issues with cycle docs + writes the
   `Cycle Ref` custom field on PR project items.

The package also ships five reusable GitHub Actions workflows
(`.github/workflows/*.yml`) that consumers wire up via `uses:`. See the
[root README](../../README.md#reusable-workflows) for the consumer wiring
pattern.

## Status

`1.0.0` — shipped on npm. Library API + the hook-facing binary surface
(`review`, `gate-push`, `doctor`, `gates`, `stats`) are stable. The
`df critic` subcommand is the CI cold-path (API-key) counterpart to the
subscription-auth local hooks.

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

# Python-backed subcommands — each forwards remaining argv to the bundled
# Python script verbatim, so `df <sub> --help` returns the Python argparse
# banner.
df validate-cycle-doc --help
df audit-branch-protection --use-bundled-default-spec --repo owner/repo
df sync-trackers --dry-run
df attribute-pr  # env-driven; needs PR_NUMBER, PR_NODE_ID, PR_BODY_FILE, PROJECT_TOKEN

# Pure-TS subcommands.
df audit stats --path .git/agent-reviews/_runs.ndjson
df admit-pr --files-stdin   # newline-separated file paths on stdin
df admit-pr --files docs/roadmap/cycles/cycle1.md,packages/cli/src/cli.ts

# Hook-facing subcommands (subscription cost model).
df review --commit HEAD --profile local --foreground
df gate-push                          # local pre-push, reads stdin
df gate-push --commit HEAD --ci       # CI replay
df doctor --profile local             # env + per-adapter auth check
df gates                              # static gates, no LLM
df stats                              # alias for `df audit stats`

# Stdio Model Context Protocol server — exposes the CLI surface to any
# MCP-speaking agent.
df mcp                                # start the stdio MCP server
df mcp --help                         # config snippets for Claude Code, Cursor, Codex
```

> **Note on `--use-bundled-default-spec`**: the bundled `spec-default.yaml`
> asserts the standard Dark Factory required-status-check contexts (e.g.
> `agent-critic`, `cycle-doc-validation`). It exists as a working starting
> point for first-run audits. Consumers SHOULD author their own `spec.yaml`
> matching their repo's actual posture — running the bundled default
> against an arbitrary repo will surface drift against contexts that
> don't exist there.

## For consumer repos — hook wiring + subscription cost model

The hook-facing subcommands (`review`, `gate-push`, `doctor`, `gates`,
`stats`) are designed to power consumer repos' `.husky/post-commit` and
`.husky/pre-push` hooks. The **cost model** is critical: per-commit critic
invocations from API tokens cost $1000s/week on a busy repo, while
subscription-auth invocations (using the developer's existing Cursor /
Codex / Claude CLI logins) are flat-rate.

### Subscription auth — what runs on each git push

| Subcommand | Hook | Cost model |
| --- | --- | --- |
| `df review` | `.husky/post-commit` (background) | **Subscription** — consumes Cursor / Codex / Claude CLI logins via the active profile's `auth` pins. No API spend by default. |
| `df gate-push` | `.husky/pre-push` | Free — reads pre-existing artifacts, no LLM calls. |
| `df doctor` | None (operator-run) | Free. Validates that per-adapter auth source is reachable. |
| `df gates` | None (operator-run) | Free. Runs static quality gates per `validation.requiredQualityGates`. |
| `df stats` | None (operator-run) | Free. Reads `.git/agent-reviews/_runs.ndjson`. |

CI cold-path (the 4 vendor API keys: `CURSOR_API_KEY`, `CODEX_API_KEY`,
`GEMINI_API_KEY`, `XAI_API_KEY`) is intentionally the fallback only —
used when:

- The first PR on a fresh repo runs critic before any developer has run
  hooks locally.
- A hook bypass landed and the CI gate needs to re-evaluate.
- The developer hasn't logged in to a vendor CLI yet
  (`cursor login` / `codex login` / Claude desktop OAuth).

### `.agent-review/config.json` — the profile that pins subscription auth

```json
{
  "version": 2,
  "critics": [
    { "id": "cursor-local-chief-engineer", "adapter": "cursor-sdk", ... },
    { "id": "codex-local-chief-engineer", "adapter": "codex-sdk", ... }
  ],
  "profiles": {
    "local": {
      "criticIds": ["cursor-local-chief-engineer", "codex-local-chief-engineer"],
      "quorum": 1,
      "auth": {
        "codex-local-chief-engineer": "chatgpt"
      }
    },
    "cloud": {
      "criticIds": ["cursor-local-chief-engineer", "codex-local-chief-engineer"],
      "quorum": 2,
      "auth": {
        "codex-local-chief-engineer": "api"
      }
    }
  }
}
```

The `local` profile pins `codex` to `"chatgpt"` — the Codex SDK will use
`~/.codex/auth.json` (from `codex login`) and **NOT** fall back to
`CODEX_API_KEY` even if it's set in env. This is the firewall against
accidental API-token billing.

`df doctor --profile local` validates the configured subscription source
is reachable. Run it after first-time setup.

### Sample `.husky/post-commit`

```bash
#!/usr/bin/env bash
set -euo pipefail
if [[ "${AGENT_REVIEW_SKIP:-}" == "1" ]]; then
  echo "df: skipped by AGENT_REVIEW_SKIP=1"
  exit 0
fi
SHA="$(git rev-parse HEAD)"
COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)"
mkdir -p "${COMMON_DIR}/agent-reviews"
LOG_FILE="${COMMON_DIR}/agent-reviews/post-commit.log"
# Detached background invocation — does not block the commit.
AGENT_REVIEW_PROFILE=local nohup npx df review --commit "${SHA}" \
  >"${LOG_FILE}" 2>&1 </dev/null &
disown || true
echo "df: review started for ${SHA:0:12} (log: ${LOG_FILE})"
```

### Sample `.husky/pre-push`

```bash
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${AGENT_REVIEW_BYPASS:-}" ]]; then
  echo "df: pre-push gate BYPASSED — reason: ${AGENT_REVIEW_BYPASS}" >&2
  exit 0
fi
npx df gate-push --profile local
```

### Doppler bootstrap (optional)

For repos that use Doppler to manage `DOPPLER_TOKEN`, place it in
`<main-checkout>/.env` and the bootstrap loader will hoist it from any
worktree:

```bash
echo 'DOPPLER_TOKEN=dp.st.dev.…' > <main-checkout>/.env
chmod 600 <main-checkout>/.env
```

The default allowlist is **just `DOPPLER_TOKEN`**. Consumers that use
project-scoped service-token vars (e.g. `DOPPLER_SERVICE_TOKEN_ACME`) can
pass a custom allowlist to `loadDopplerBootstrapEnv()` via the library
API — see `packages/cli/src/doppler-bootstrap.ts` for the
`serviceTokenAlias` parameter that bridges to `DOPPLER_TOKEN`.

### First-time setup checklist

1. `npm install --ignore-scripts @momentiq/dark-factory-cli`
2. Add `.agent-review/config.json` with the `local` profile (above).
3. Add `.husky/post-commit` + `.husky/pre-push` (samples above).
4. `git config --local core.hooksPath .husky`
5. `cursor login` / `codex login` (or Claude desktop OAuth) on the workstation.
6. Run `df doctor --profile local` — should report all OK.
7. Commit something — observe `.git/agent-reviews/<sha>.json` arrives.
8. (Optional) Set up CI with `CURSOR_API_KEY` / `CODEX_API_KEY` /
   `GEMINI_API_KEY` / `XAI_API_KEY` as repo secrets for the cold path.

## System requirements

- **Node.js >=20**
- **Python 3.11+** — required for services #5, #7, #9. The package bundles
  the source Python scripts (`validate_cycle_doc.py`,
  `audit_branch_protection.py`, `sync_cycle_trackers.py`,
  `attribute_pr_cycle_ref.py`) and wraps each in a TypeScript subprocess
  spawn. A pure-TS rewrite is on the roadmap and will eliminate this
  dependency in a future release.
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

Apache-2.0. The OSS critic surface is a public artifact. The hosted Dark
Factory runtime layers proprietary calibrated prompts and a calibrated
bypass-classifier on top of this CLI; those are out-of-scope here.
