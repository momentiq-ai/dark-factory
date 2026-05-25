# Dark Factory

> Pillar #1 of the momentiq.ai platform: **the autonomous AI-native software development lifecycle**. Agents author, critic, validate, and ship. Every gate is deterministic and auditable.

## For consumer repos

Adopting dark-factory in your own repo: see [docs/CONSUMER-ADOPTION.md](docs/CONSUMER-ADOPTION.md).

Architectural expectations:
- `docs/roadmap/cycles/` carries your repo's cycle docs (Spec-Driven Traceability — manifesto §10)
- `.husky/` hooks invoke local critic via subscriptions (cost-controlled); CI is fallback
- Pin `@momentiq/dark-factory-cli@<exact-version>` (no floating ranges); reusable workflows pin to commit SHA
- **Require the `agent-critic` status check in a branch ruleset** ([CONSUMER-ADOPTION.md §8](docs/CONSUMER-ADOPTION.md)) — without this the gates are advisory-only and don't block merges. This is a required onboarding step, not an optional one.

Concrete prior art: [taxpilot2a PR #45](https://github.com/momentiq-ai/taxpilot2a/pull/45) (F.5a, first external consumer) + [PR #46](https://github.com/momentiq-ai/taxpilot2a/pull/46) (access-permission follow-up).

## Status

Pre-launch. Active extraction from `momentiq-ai/sage3c` via [cycle 331](https://github.com/momentiq-ai/sage3c/blob/main/docs/roadmap/cycles/cycle331-dark-factory-platformization.md). Public OSS release ships in cycle 331.3. **Until then, source-of-truth for design + status is the sage3c roadmap** (see [`docs/roadmap/dark-factory-roadmap.md`](docs/roadmap/dark-factory-roadmap.md) pointer).

## What's here (post-extraction target state)

- `@momentiq/dark-factory-cli` — OSS CLI (Cursor / Codex / Gemini / Grok adapters, min-complete-quorum aggregation)
- `@momentiq/dark-factory-schemas` — JSON Schemas for `darkfactory.yaml` + per-SHA evidence + cycle-doc trailer formats
- `.github/workflows/*.yml` — reusable GitHub Actions consumers reference via `uses: momentiq-ai/dark-factory/.github/workflows/<name>.yml@v0.1.0`

## Reusable workflow shapes (Phase E)

Cycle 331.1 Phase E ships five reusable GitHub Actions workflows that satisfy
both (a) dark-factory's own `main1` ruleset and (b) the consumer-side ruleset
in sage3c / cerebe-platform / external repos in Phases G/H.

| File                                            | Required-check context     | Phase E behavior                                                                                |
|-------------------------------------------------|----------------------------|-------------------------------------------------------------------------------------------------|
| `.github/workflows/pr-status-check.yml`         | `PR Status Check`          | No-op aggregator stub (`df status-check` exits 0).                                              |
| `.github/workflows/schema-check.yml`            | `schema-check`             | Builds `@momentiq/dark-factory-schemas`; no drift detector wired yet.                           |
| `.github/workflows/agent-critic.yml`            | `agent-critic`             | Invokes `df critic` stub (exit 0); real Critic Orchestrator lands in Phase F.                   |
| `.github/workflows/cycle-doc-validation.yml`    | `cycle-doc-validation`     | No-op on dark-factory's own PRs; real validator runs on consumer / `enforce-on-dark-factory`.   |
| `.github/workflows/branch-protection-audit.yml` | `branch-protection-audit`  | No-op on dark-factory until `BRANCH_PROTECTION_AUDIT_TOKEN` provisioned; fail-closed elsewhere. |

### Consumer-side wiring (Phase G/H)

Consumers `uses:` each workflow from their own CI:

```yaml
# consumer-repo/.github/workflows/agent-critic.yml
name: Agent Critic
on:
  pull_request:
    branches: [main]
  merge_group:
jobs:
  # IMPORTANT: a reusable workflow invoked via `uses:` produces a
  # status-check context of the form `<caller-job-id> / <callee-job-name>`,
  # NOT the bare callee name. The caller job-id below is `agent-critic` and
  # the callee's internal job is also named `agent-critic`, so the emitted
  # context is exactly `agent-critic / agent-critic` — that is the literal
  # string your enforcement ruleset must require (see
  # docs/CONSUMER-ADOPTION.md §8). Requiring the bare `agent-critic` would
  # never match and would block every PR forever.
  agent-critic:
    uses: momentiq-ai/dark-factory/.github/workflows/agent-critic.yml@v0.1.0
    secrets:
      DOPPLER_SERVICE_TOKEN_SAGE: ${{ secrets.DOPPLER_SERVICE_TOKEN_SAGE }}
      # OR (for external consumers without Doppler):
      # CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
      # ...
```

### Versioning

Per cycle 331.1 § Versioning policy, only exact `@vX.Y.Z` tags are supported.
Consumers MUST pin to a specific version — floating `@v0` / `@v0.1` tags are
NOT created so the same consumer commit always resolves to a single workflow
definition + CLI version.

### Phase E posture: stubs, by design

The Phase E workflows ship as STUB SHAPES, not real gates. Several knock-on
consequences:

- `agent-critic` provides no actual adversarial-critic gating yet. Real
  Critic Orchestrator wiring lands in Phase F.
- `cycle-doc-validation` no-ops on dark-factory's own PRs (dark-factory has
  no cycle docs of its own).
- `branch-protection-audit` no-ops until `BRANCH_PROTECTION_AUDIT_TOKEN`
  is provisioned; fails closed elsewhere when the gate is enabled.

The purpose of Phase E is to END THE DOGFOOD CHICKEN-AND-EGG: dark-factory's
own ruleset requires five status checks that didn't exist on dark-factory's
own PRs (every Phase A/B/C/D PR had to be admin-merged). After Phase E lands,
the same checks exist as actual workflows, the ruleset is satisfied by their
green outcomes, and the normal merge queue takes over.

## What's where (during extraction)

The substrate is currently being extracted from sage3c. Phases:

- **331.1 Phase A** (this commit): repo bootstrap — LICENSE, CODEOWNERS, README, .gitignore, workspaces package.json, CLAUDE.md, ruleset mirror
- **331.1 Phase B–F**: service-by-service extraction
- **331.1 Phase F.5a + F.5b**: first-client validation on `momentiq-ai/taxpilot2a` + `alien8d/lyra`
- **331.1 Phase G + H**: sage3c + cerebe-platform migrate to consume the extracted dep
- **331.1 Phase I**: sage-blueprint updated

## License

Apache-2.0. See [LICENSE](LICENSE).
