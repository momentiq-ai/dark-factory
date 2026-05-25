# Phase F Dogfood Evidence — 2026-05-24

This document records the empirical outcome of cycle 331.1 Phase F:
dark-factory eating its own dog food. The 5 reusable workflows
shipped in Phase E (`.github/workflows/*.yml`) ran for the first time
against a real, non-stub critic implementation on the Phase F
dogfood PR itself.

## Substrate under test

- CLI: `@momentiq/dark-factory-cli@0.1.0-alpha.4` (this PR bumps
  from `0.1.0-alpha.3`)
- Config: `.agent-review/config.json` (new in this PR — dark-factory
  did not have one before)
- 4 vendor adapters wired: Cursor (Composer 2.5), Codex (GPT-5.5),
  Gemini (3.5 Flash), Grok (4.3)
- Aggregation policy: `min-complete-quorum` with `quorum: 2`,
  blocking severities `[blocker, high]`
- All 4 critics `required: false` (matches sage3c steady state).
  Errored critics contribute to `quorum_unmet` (non-blocking).

## Local dry-run (smoke evidence)

Run from `/Users/pj/projects/dark-factory` against HEAD of the
Phase F branch, with dummy vendor keys to exercise the full pipeline
without spending real tokens:

```bash
CURSOR_API_KEY=dummy CODEX_API_KEY=dummy \
GEMINI_API_KEY=dummy XAI_API_KEY=dummy \
  node ./packages/cli/dist/cli.js critic
```

Observed output (truncated):

```
df critic: review complete for 26a0a4fe405b20dc951b42539f420669387b2b72
  verdict: CHANGES_REQUESTED
  total findings: 0
  per-critic:
    cursor-local-chief-engineer: error — findings=0
    codex-local-chief-engineer:  error — findings=0
    gemini-local-chief-engineer: error — findings=0
    grok-local-chief-engineer:   error — findings=0
  artifact: /Users/pj/projects/dark-factory/.git/agent-reviews/<sha>.json
```

The artifact was written to `.git/agent-reviews/<sha>.json` and an
audit-trail entry landed in `.git/agent-reviews/_runs.ndjson`. The
follow-on `df audit stats` invocation read 3 runs back successfully
(prior local smoke iterations + this one).

This confirms:

1. The Phase B Critic Orchestrator extraction works end-to-end:
   load config → build packet (TS) → instantiate registry → call all
   4 adapters concurrently → aggregate → write artifact + telemetry.
2. The min-complete-quorum aggregation correctly returns
   `CHANGES_REQUESTED` when zero critics complete (quorum unmet).
3. The audit-trail sink correctly persists per-event NDJSON.
4. The degraded-and-passes contract in `cmdCritic` keeps exit code
   at 0 even when every vendor errors — required for Phase F's
   dogfood loop to not deadlock.

## CI workflow outcomes — PR #5 (initial dogfood)

The 5 reusable workflows ran on PR #5 (the Phase F dogfood PR that
introduced the real critic wiring). All 5 turned green and the PR
auto-merged via the merge queue.

| Workflow | Outcome | Duration (s) | Notes |
|---|---|---|---|
| `agent-critic` | SUCCESS | ~30 | Real Critic Orchestrator ran. All 4 vendor adapters errored because the workflow YAML didn't yet export vendor API keys to the CLI subprocess (fixed in PR #6 follow-up). Aggregate verdict: `CHANGES_REQUESTED` (quorum_unmet); exit-0 degrade-and-pass kept the gate green. |
| `pr-status-check` | SUCCESS | ~30 | Sentinel passed as expected. |
| `schema-check` | SUCCESS | ~30 | Schemas package built cleanly. No drift detector wired yet. |
| `cycle-doc-validation` | SUCCESS | ~35 | No-op on dark-factory (no cycle docs of its own — by design). |
| `branch-protection-audit` | SUCCESS | ~33 | First run with `CI_BOT_APP_ID` + `CI_BOT_PRIVATE_KEY` secrets provisioned. |

Total wall-clock: ~35 seconds (all workflows ran concurrently). PR
auto-merge fired ~5 seconds after the last check landed.

## CI workflow outcomes — PR #6 (vendor-keys follow-up)

PR #6 wired the four vendor API keys (`CURSOR_API_KEY` /
`CODEX_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY`) to the
`agent-critic` step's env. This PR's CI run is the FIRST live
exercise of the real Critic Orchestrator with REAL vendor keys
against a real diff.

Outcomes recorded below (filled in once CI completes):

| Workflow | Outcome | Duration | Notes |
|---|---|---|---|
| `agent-critic` | TBD | TBD | First real critic run with REAL vendor keys |
| `pr-status-check` | TBD | TBD | Sentinel, expected pass |
| `schema-check` | TBD | TBD | No schemas changed, expected pass |
| `cycle-doc-validation` | TBD | TBD | No-op pass (dark-factory has no cycle docs) |
| `branch-protection-audit` | TBD | TBD | No spec change, expected pass |

The expected per-critic behavior on PR #6:

- Each vendor adapter calls its SDK with real credentials.
- Aggregate verdict depends on what the critics find in the
  workflow YAML diff.
- Quorum aggregation: at least 2 critics must complete (status =
  `complete`, not `error`) for a non-`quorum_unmet` verdict.

## Risks validated by this dogfood

- **R1.1 — Refactor smearing**: NOT triggered. The Phase B
  extraction kept service boundaries clean; the Phase F wire-up
  was 1 import block + 1 new `cmdCritic` body. No cross-service
  refactor needed.
- **R1.3 — Reusable workflow secrets passing**: To be validated by
  the live workflow run. The workflows declare every secret the
  Phase F adapters can possibly read; if any vendor adapter fails
  with "missing secret" on CI, that's a Phase F-FOLLOWUP issue.
- **R1.4 — Snapshot regression test cost**: NOT exercised in Phase
  F. The 10-PR snapshot regression lands in Phase G (sage3c
  migration); this dogfood validates correctness on dark-factory
  alone.

## Known limitations / deferred to Phase F-FOLLOWUP

- The dogfood PR uses dummy/no vendor keys, so the FIRST production-
  validated critic run with real keys will happen when the live PR
  runs against the freshly-mirrored CI secrets. The structured
  output makes it possible to diagnose any vendor SDK init failure
  without blocking the merge.
- `status-check` is a sentinel — a true cross-workflow aggregator
  would query the GitHub Actions API and synthesize a verdict from
  sibling check results. The merge queue's `ALLGREEN` rule
  already provides that semantics with stronger guarantees, so
  Phase F deliberately defers a richer aggregator.
- Stripped findings (`enforceFindingRubric`) and per-PR finding-cache
  paths are exercised by the runner code but not asserted by Phase
  F evidence. Sage3c migration (Phase G) provides the canonical
  exercise.
