# Adopting Dark Factory in your repo

Audience: maintainers of a repo that wants to consume `@momentiq/dark-factory-cli` + the reusable GitHub Actions workflows published from `momentiq-ai/dark-factory`. After adoption your repo gets:

- **Local subscription-backed critic** on every commit (`.husky/post-commit`) and a pre-push gate (`.husky/pre-push`) — uses your existing Cursor / Codex / Claude / Grok logins (flat-rate) instead of per-token API keys.
- **CI critic** that runs the same multi-vendor adversarial-critic fleet against every PR HEAD.
- **Cycle-doc validation** so PRs cite a `Cycle:` or `Issue:` trailer and the validator enforces Spec-Driven Traceability.
- **Optional branch-protection drift detector** if your repo has a ruleset.

This document is the canonical adoption guide. Concrete worked examples:

- **taxpilot2a F.5a** ([PR #45](https://github.com/momentiq-ai/taxpilot2a/pull/45)) — first external consumer; full CI wiring, `.agent-review/config.json`, `.npmrc` + root `package.json`.
- **taxpilot2a F.5a follow-up** ([PR #46](https://github.com/momentiq-ai/taxpilot2a/pull/46)) — documents the prerequisite `actions/permissions/access` flip on `momentiq-ai/dark-factory` so cross-repo `uses:` works.
- **lyra F.5b** (planned) — second external consumer (under `alien8d/`, fully outside momentiq-ai org).

## 1. Prerequisites

| Item | Where | Notes |
|---|---|---|
| GitHub org membership for `momentiq-ai` | Org admin | Required to read the private `@momentiq/dark-factory-cli` npm package. External consumers must fork the repo and self-host the CLI until the 331.3 OSS-flip. |
| npm read token for the `@momentiq` scope | npmjs.com → account → access tokens | Save as `MOMENTIQ_NPM_READ_TOKEN` in your repo's GH Actions secrets and as `$NPM_TOKEN` in your local shell rc (for `npm install`). |
| Node.js >= 20 | `node --version` | The CLI's `engines.node` is `>=20`. |
| `momentiq-ai/dark-factory` Actions access set to `organization` | `gh api -X PUT repos/momentiq-ai/dark-factory/actions/permissions/access -f access_level=organization` (org admin only) | Without this, your `uses: momentiq-ai/dark-factory/.github/workflows/<name>.yml@<sha>` calls fail at startup with "workflow file issue". See [taxpilot2a PR #46](https://github.com/momentiq-ai/taxpilot2a/pull/46) — this trap was discovered the hard way. |

## 2. Install the CLI

Until the 331.3 OSS-flip, the CLI is published to the private `@momentiq` npm scope. Pin to an exact alpha version — floating ranges are not supported (per [`CLAUDE.md` § Consumer-vs-author posture](../CLAUDE.md)).

**a. Root `package.json`** — exact pin in `devDependencies`:

```json
{
  "name": "<your-repo>-host",
  "version": "0.0.0",
  "private": true,
  "description": "Root manifest hosting @momentiq/dark-factory-cli for the consumer install pattern.",
  "devDependencies": {
    "@momentiq/dark-factory-cli": "0.1.0-alpha.6"
  },
  "engines": { "node": ">=20" }
}
```

Substitute `0.1.0-alpha.6` for the actual latest published alpha. Verify with `npm view @momentiq/dark-factory-cli versions --json` (requires `MOMENTIQ_NPM_READ_TOKEN` exported as `NPM_TOKEN`). If you already have a `package.json` (e.g. a workspaces monorepo), add the devDep to your root manifest — the CLI does not need to live inside any workspace.

**b. `.npmrc`** — interpolated token, never hardcoded:

```ini
@momentiq:registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

**c. Install:**

```bash
NPM_TOKEN="<your-token>" npm install
# Binary is now at ./node_modules/.bin/df
./node_modules/.bin/df --help
```

The lockfile (`package-lock.json`) must be committed so CI installs the same version (see `CLAUDE.md` § Reusable workflow conventions — "two paths converge on the same version pin").

## 3. Husky hooks — local critic with subscription auth (the load-bearing piece)

The local critic uses your existing **Cursor / Codex / Claude / Grok SUBSCRIPTIONS** (flat monthly fee, ~$20-200/seat depending on vendor) rather than per-token API keys. This is cost-load-bearing: per-commit critic invocations against pay-per-token APIs cost $1000s/week on busy repos; subscription auth is flat-rate.

Install husky if you don't have it: `npm install --save-dev husky && npx husky init`.

**`.husky/post-commit`** — background critic review for HEAD:

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ "${AGENT_REVIEW_SKIP:-}" == "1" ]]; then
  echo "df review: skipped by AGENT_REVIEW_SKIP=1"
  exit 0
fi

CLI="./node_modules/.bin/df"
if [[ ! -x "${CLI}" ]]; then
  echo "df review: CLI not installed at ${CLI}; run 'npm install' first" >&2
  exit 0   # don't block commits; just warn
fi

COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)"
mkdir -p "${COMMON_DIR}/agent-reviews"
LOG_FILE="${COMMON_DIR}/agent-reviews/post-commit.log"

# Capture SHA at hook time, NOT in the background process. If two
# commits land before the background process starts, the literal
# "HEAD" would resolve to the SECOND commit and the first one would
# never get an artifact — pre-push then blocks on missing-review.
SHA="$(git rev-parse HEAD)"

# Pin the `local` profile so we use Cursor/Codex/Claude subscriptions
# (per `.agent-review/config.json` § profiles.local.auth), not API keys.
AGENT_REVIEW_PROFILE=local nohup "${CLI}" review --commit "${SHA}" \
  >"${LOG_FILE}" 2>&1 \
  </dev/null &
disown || true

echo "df review: critic started for ${SHA:0:12} (log: ${LOG_FILE})"
```

**`.husky/pre-push`** — block push if any pushed commit has unresolved blockers:

```bash
#!/usr/bin/env bash
set -euo pipefail

CLI="./node_modules/.bin/df"

# Capture pre-push stdin once so we can feed it to the CLI.
STDIN_BUF="$(cat)"

# Emergency bypass — logged to .git/agent-reviews/_runs.ndjson.
if [[ -n "${AGENT_REVIEW_BYPASS:-}" ]]; then
  echo "df gate-push: BYPASSED — reason: ${AGENT_REVIEW_BYPASS}" >&2
  COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)"
  TELEMETRY_FILE="${COMMON_DIR}/agent-reviews/_runs.ndjson"
  mkdir -p "$(dirname "${TELEMETRY_FILE}")"
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ESC_REASON=$(printf '%s' "${AGENT_REVIEW_BYPASS}" | tr -d '[:cntrl:]' | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"ts":"%s","event":"gate_bypassed","source":"pre-push-hook","reason":"%s"}\n' \
    "${TS}" "${ESC_REASON}" >> "${TELEMETRY_FILE}"
  exit 0
fi

if [[ ! -f "${CLI}" ]]; then
  echo "df gate-push: BLOCKED — CLI not installed at ${CLI}; run 'npm install'." >&2
  echo "df gate-push: push with AGENT_REVIEW_BYPASS=\"reason\" only in genuine emergencies." >&2
  exit 1
fi

# `df gate-push` reads git's pre-push protocol on stdin and gates each
# commit in the pushed range against its per-SHA artifact.
printf '%s' "${STDIN_BUF}" | "${CLI}" gate-push
```

Make both executable:

```bash
chmod +x .husky/post-commit .husky/pre-push
```

**Cost model.** Two-path:

- **Local (default)** — `.agent-review/config.json:profiles.local.auth` pins each vendor to subscription auth (`codex-local-chief-engineer: chatgpt`, etc.). Each commit invokes the critic via the existing CLI login (`cursor-agent`, `codex login`, etc.). Cost = flat monthly subscription.
- **CI (fallback)** — `agent-critic` reusable workflow uses pay-per-token API keys (`CURSOR_API_KEY` / `CODEX_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY`). Per-PR cost varies with diff size but is bounded by the PR cadence, not commit cadence. The intent is that local catches blockers BEFORE the PR exists.

If a developer doesn't have subscriptions configured for any vendor, the local critic degrades to "0 critics ran" and pre-push gate fails closed with a missing-review error. Solve by configuring at least one subscription login, or by running `AGENT_REVIEW_SKIP=1 git commit` for trivial commits (logged to `_runs.ndjson` for audit).

## 4. `.agent-review/config.json` — scope to your repo's source layout

Copy the [dark-factory canonical config](../.agent-review/config.json) into your repo and adjust three things:

- **`tdd.classifier.productionGlobs` / `testGlobs`** — point at your repo's actual source/test layout.
- **`profiles.local.criticIds`** — the minimum quorum-2 envelope is `["cursor-local-chief-engineer", "codex-local-chief-engineer"]` per the canonical config's `aggregation.quorum: 2`. Add more critics if you want stricter consensus.
- **`context.guidanceFiles`** — list your repo's CLAUDE.md / ENGINEERING.md / equivalent files. The critic loads these into its prompt envelope.

`min-complete-quorum: 2` is the recommended aggregation policy: a verdict is binding only when at least 2 critics complete; per-critic errors (rate limits, expired subs) don't block the gate. See `CLAUDE.md` § Iteration-trap for the N=2 ceiling — same policy applies to consumer repos.

Also drop a critic-prompt fragment at `.agent-review/prompts/local-critic.md` with your repo-specific quality bar. See [dark-factory's own](../.agent-review/prompts/local-critic.md) as a starting template.

## 5. `docs/roadmap/cycles/` — Spec-Driven Traceability (MANDATORY)

Per the AI-Native Manifesto §10 (`sage3c:docs/engineering/ai-native-manifesto.md`), Dark Factory consumer repos MUST carry a `docs/roadmap/cycles/` directory containing cycle docs. The `cycle-doc-validation` reusable workflow (extracted from `sage3c/scripts/ci/validate_cycle_doc.py`) enforces:

- Every code PR cites either a `Cycle: <N>` or `Issue: #<N>` trailer (or GitHub auto-close keyword).
- The cited cycle doc exists at `docs/roadmap/cycles/cycle<N>-*.md` with valid frontmatter (`status: draft | in-progress | completed | superseded | abandoned | absorbed`).
- A PR cannot cite a terminal-status cycle (`completed` / `complete` / `superseded` / `abandoned` / `absorbed`).
- Plan PRs change exactly one cycle doc; code PRs reference the corresponding plan.

**Bootstrap seed:** create `docs/roadmap/cycles/cycle1-dark-factory-adoption.md` as your first plan PR, with frontmatter:

```yaml
---
cycle: 1
title: "Cycle 1 — Adopt Dark Factory"
status: in-progress
priority: high
created: "YYYY-MM-DD"
updated: "YYYY-MM-DD"
started: "YYYY-MM-DD"
completed: null
owner: "@<your-handle>"
tags:
  - dark-factory
  - adoption
---
```

Subsequent PRs in your repo cite `Cycle: 1` or, for tactical follow-ups after closure, `Issue: #<N>`. See [sage3c's cycle directory](https://github.com/momentiq-ai/sage3c/tree/main/docs/roadmap/cycles) for the corpus this validator was designed against.

## 6. `.github/workflows/dark-factory-pr.yml` — invoke the reusable workflows

Pin each reusable workflow to an exact **commit SHA** (NOT a `@v0` tag — per `CLAUDE.md` § Reusable workflow conventions, only `@vX.Y.Z` semver tags and commit SHAs are supported; floating `@v0`/`@v0.1` tags don't exist).

```yaml
# .github/workflows/dark-factory-pr.yml
# Prereq: momentiq-ai/dark-factory actions/permissions/access must be
# set to 'organization' (org admin only). See taxpilot2a#46.

name: Dark Factory PR Gates

on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]
  merge_group:

jobs:
  # Minimum: 3 jobs (pr-status-check + agent-critic + cycle-doc-validation)
  pr-status-check:
    uses: momentiq-ai/dark-factory/.github/workflows/pr-status-check.yml@<exact-commit-sha>
    with:
      cli-version: '0.1.0-alpha.6'
    secrets:
      MOMENTIQ_NPM_READ_TOKEN: ${{ secrets.MOMENTIQ_NPM_READ_TOKEN }}

  agent-critic:
    uses: momentiq-ai/dark-factory/.github/workflows/agent-critic.yml@<exact-commit-sha>
    with:
      cli-version: '0.1.0-alpha.6'
      darkfactory_config_path: '.agent-review/config.json'
    secrets:
      MOMENTIQ_NPM_READ_TOKEN: ${{ secrets.MOMENTIQ_NPM_READ_TOKEN }}
      CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
      CODEX_API_KEY: ${{ secrets.CODEX_API_KEY }}
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
      XAI_API_KEY: ${{ secrets.XAI_API_KEY }}

  cycle-doc-validation:
    uses: momentiq-ai/dark-factory/.github/workflows/cycle-doc-validation.yml@<exact-commit-sha>
    with:
      cli-version: '0.1.0-alpha.6'
    secrets:
      MOMENTIQ_NPM_READ_TOKEN: ${{ secrets.MOMENTIQ_NPM_READ_TOKEN }}

  # Optional: schema-check — only if your repo has OpenAPI / JSON Schema
  # surfaces you want drift-detected. The dark-factory schema-check is
  # for @momentiq/dark-factory-schemas specifically; for consumer OpenAPI
  # drift you typically want your own schema-check workflow.

  # Optional: branch-protection-audit — only if your repo has a ruleset.
  # Pass gate-enabled: 'false' if no ruleset yet (documented no-op pass).
  branch-protection-audit:
    uses: momentiq-ai/dark-factory/.github/workflows/branch-protection-audit.yml@<exact-commit-sha>
    with:
      cli-version: '0.1.0-alpha.6'
      gate-enabled: 'false'   # flip to 'true' once you adopt a ruleset
    secrets:
      MOMENTIQ_NPM_READ_TOKEN: ${{ secrets.MOMENTIQ_NPM_READ_TOKEN }}
      # When gate-enabled: 'true', also pass:
      # CI_BOT_APP_ID: ${{ secrets.CI_BOT_APP_ID }}
      # CI_BOT_PRIVATE_KEY: ${{ secrets.CI_BOT_PRIVATE_KEY }}
```

**Caller job-id naming.** Each caller job MUST be named so the resulting status-check context matches your ruleset rule. The job-id is the FIRST segment of the context (e.g., `agent-critic / agent-critic`). If your ruleset names a context `agent-critic`, the caller job-id must be `agent-critic:`. See `README.md` § Consumer-side wiring for the contract.

See [taxpilot2a's dark-factory-pr.yml](https://github.com/momentiq-ai/taxpilot2a/blob/main/.github/workflows/dark-factory-pr.yml) for a working production example pinned to a real commit SHA.

## 7. Provision secrets on your repo's GH Actions

| Secret | When | Why |
|---|---|---|
| `MOMENTIQ_NPM_READ_TOKEN` | Always | Consumer install path resolves `@momentiq/dark-factory-cli@<pinned>` from the private npm scope. |
| `CURSOR_API_KEY` | Optional but recommended | CI critic fallback when subscription auth isn't available in the runner (it isn't). |
| `CODEX_API_KEY` | Optional but recommended | Same. |
| `GEMINI_API_KEY` | Optional | Wires the Gemini critic in CI. Missing keys produce `status=error` for that critic; min-complete-quorum handles gracefully. |
| `XAI_API_KEY` | Optional | Same for Grok. |
| `CI_BOT_APP_ID` + `CI_BOT_PRIVATE_KEY` | Only if using `branch-protection-audit` with `gate-enabled: 'true'` | Mints an installation token via `actions/create-github-app-token@v1` for the drift audit. |

Set with:

```bash
gh secret set MOMENTIQ_NPM_READ_TOKEN --repo <your-org>/<your-repo>
gh secret set CURSOR_API_KEY --repo <your-org>/<your-repo>
# ... etc
```

## 8. Validation

**a. Local — `df doctor`:**

```bash
./node_modules/.bin/df doctor
```

This verifies:
- Node version meets `engines.node`.
- Husky hooks directory exists, hook scripts are executable.
- `core.hooksPath` points at `.husky`.
- Artifact dir is writable.
- Doppler bootstrap (if configured).
- Per-adapter `doctor()` — i.e., each vendor's subscription login works.

Fix every red row before opening your first PR.

**b. First PR.** Open a no-op PR that touches `docs/CONSUMER-ADOPTION.md` or similar low-risk file. Expect:

- `pr-status-check` → PASS (sentinel).
- `cycle-doc-validation` → PASS (with a valid `Cycle: 1` or `Issue: #<N>` trailer).
- `agent-critic` → PASS or advisory findings (degrade-and-pass under min-complete-quorum).
- `branch-protection-audit` → PASS with `gate-enabled: 'false'`.

First-time critic runs are advisory (the policy is `aggregation.blockOnReviewError: false` per the canonical config). Treat the first 1-2 PRs as calibration: tighten `.agent-review/prompts/local-critic.md` and the config until critic findings are signal, not noise.

## 9. Update cadence

- Pin to a specific alpha/beta version (`0.1.0-alpha.N`) — never floating ranges.
- Bump CLI deliberately when dark-factory releases a new version. Check the [changelog](https://github.com/momentiq-ai/dark-factory/blob/main/CHANGELOG.md) (when it lands in Phase F+) or the [release tags](https://github.com/momentiq-ai/dark-factory/tags).
- When bumping, update both `package.json` (`devDependencies."@momentiq/dark-factory-cli"`) AND `.github/workflows/dark-factory-pr.yml` (`with: cli-version:`). The `df doctor` subcommand surfaces drift between them.
- Reusable workflow SHA bumps are decoupled: you can bump the CLI without bumping the workflow SHA and vice versa. Test in a draft PR before landing in main.

## 10. References

- **Source-of-truth cycle:** [sage3c:cycle331.1-extract-from-sage3c.md](https://github.com/momentiq-ai/sage3c/blob/main/docs/roadmap/cycles/cycle331.1-extract-from-sage3c.md) — the cycle this extraction was driven by.
- **Parent platform cycle:** [sage3c:cycle331-dark-factory-platformization.md](https://github.com/momentiq-ai/sage3c/blob/main/docs/roadmap/cycles/cycle331-dark-factory-platformization.md).
- **AI-Native Manifesto:** [sage3c:docs/engineering/ai-native-manifesto.md](https://github.com/momentiq-ai/sage3c/blob/main/docs/engineering/ai-native-manifesto.md) — foundational principles, especially §10 Spec-Driven Traceability.
- **Cross-repo subagent isolation:** when dispatching Claude Code subagents across multiple consumer repos in one session, each subagent MUST clone to a unique path (`/Users/<you>/projects/<repo>-wt-<task>`). Otherwise concurrent subagents trample each other's git state. This is documented in the `feedback_cross_repo_subagent_isolation` memory pattern (private to PJ's Claude Code memory).
- **A2 follow-up — CLI adapter dynamic loading:** the CLI dynamically imports vendor adapters inside `buildDefaultAdapterRegistry()` (`packages/cli/src/cli.ts` lines ~70-80) so the binary loads under `--ignore-scripts` for non-`df critic` subcommands. Don't trip over this when debugging install issues.
- **Reusable workflow security model:** `CLAUDE.md` § Reusable workflow conventions explains the trusted-surface rebind (workflow-baked `EXPECTED_INTEGRITY` + `$RUNNER_TEMP/df-trusted-*` extraction) for paranoid consumers.
- **Worked external example:** [taxpilot2a PR #45](https://github.com/momentiq-ai/taxpilot2a/pull/45) (F.5a integration) + [PR #46](https://github.com/momentiq-ai/taxpilot2a/pull/46) (access-permission follow-up).
