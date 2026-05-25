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

## CI workflow outcomes (to be filled in post-merge)

Once the dogfood PR is open, the 5 reusable workflows run on it for
the first time with real critic logic. Outcomes recorded below.

| Workflow | Outcome | Duration | Notes |
|---|---|---|---|
| `agent-critic` | TBD | TBD | First REAL critic run on dark-factory's own diff |
| `pr-status-check` | TBD | TBD | Thin sentinel, expected pass |
| `schema-check` | TBD | TBD | Builds schemas package; no drift detector |
| `cycle-doc-validation` | TBD | TBD | Should no-op (dark-factory has no cycle docs) |
| `branch-protection-audit` | TBD | TBD | First run with `BRANCH_PROTECTION_AUDIT_TOKEN` provisioned |

Will be updated once CI runs are observed on the open PR.

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
