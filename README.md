# Dark Factory

> The autonomous AI-native software development lifecycle. A quorum of independent
> AI critics (Cursor, Codex, Gemini, Grok) reviews every commit. Gates are
> deterministic, evidence-bound, and auditable. Auto-merge is the default.

Dark Factory is one of three composable pillars in the Momentiq platform:

**Scaffold with Sage → implement on [Cerebe](https://cerebe.ai) → ship through Dark Factory.**

Every git push runs the diff through the critic quorum. The verdict + per-critic
evidence is bound to the commit SHA, persisted at `.git/agent-reviews/<sha>.md`,
and surfaces as a Check Run on the pull request. Same diff, same verdict —
this is a gate, not a vibe.

## Quick start

| Starting from | Time | Walkthrough |
|---|---|---|
| **A blank slate** | ~25 min | [`docs/getting-started.md`](docs/getting-started.md) — scaffold with `npx @momentiq/sage-cli` → first agent call → first commit reviewed → first push gated |
| **An existing repo** | ~30 min | [`docs/CONSUMER-ADOPTION.md`](docs/CONSUMER-ADOPTION.md) — retrofit Dark Factory into a repo you already have |

## What's in this repo

| Package / Surface | Purpose |
|---|---|
| [`@momentiq/dark-factory-cli`](packages/cli) | Multi-vendor critic CLI + local stdio MCP server (`df mcp`) |
| [`@momentiq/sage-cli`](packages/sage-cli) | One-command scaffold for a production-ready agentic AI product |
| [`@momentiq/dark-factory-schemas`](packages/schemas) | JSON Schemas for `darkfactory.yaml`, per-SHA evidence, and cycle-doc trailers |
| [`.github/workflows/*.yml`](.github/workflows) | Reusable GitHub Actions workflows consumers `uses:` from their own CI |

## Sage — scaffold a product in one command

```bash
npx @momentiq/sage-cli@alpha init my-product \
  --product-name "My Product" \
  --primary-persona employer \
  --domain my-product.example
```

The CLI bundles the Sage template — FastAPI backend, Next.js 14 frontend,
LangGraph agent runtime, Cerebe SDK pre-installed, Doppler secrets per-environment,
Helm charts for k3d + GKE, Highlight.io + OpenTelemetry, Husky hooks wired to
the Dark Factory critic, MCP context for Claude Code / Cursor / Codex / Gemini —
and renders a full product tree on commit one. Four interactive prompts and the
rest is sensible defaults.

Full reference: [`packages/sage-cli/README.md`](packages/sage-cli/README.md).

## Dark Factory CLI — `df`

```bash
npm install @momentiq/dark-factory-cli

df review --commit HEAD --profile local   # run the critic quorum on a commit
df doctor                                  # check vendor auth + per-adapter config
df gate-push                               # pre-push gate (reads pre-existing artifacts)
df mcp                                     # start the stdio MCP server
```

The hook-facing subcommands (`review`, `gate-push`, `doctor`, `gates`, `stats`)
are designed to run from `.husky/post-commit` + `.husky/pre-push`. The cost
model favors subscription auth (Cursor / Codex / Claude CLI logins) over
per-call API tokens — see
[`packages/cli/README.md`](packages/cli/README.md#for-consumer-repos--hook-wiring--subscription-cost-model).

## Agentic surface — `df mcp`

The CLI ships a [Model Context Protocol](https://modelcontextprotocol.io) server
as `df mcp`. Connect any MCP-speaking agent (Claude Code, Cursor, Codex, Gemini)
over stdio:

- **21 tools** — `df_doctor`, `df_findings`, `df_show_run`, `df_cycle_list`,
  `df_cycle_read`, `df_adr_list`, `df_adr_read`, `df_critics_config`, `df_stats`,
  `df_gate_push`, `df_review` (async) + `df_review_status`, `df_bypass` (with
  elicitation for missing issue URLs), `df_cycle_doc_generate` +
  `df_adr_generate` (via MCP sampling — the server asks the **client's** LLM to
  populate skeletons), the **agent handoff** verbs `df_handoff` /
  `df_handoffs` / `df_accept` / `df_rehydrate`, and the **bundled-skill
  installer** `df_skills_install` / `df_skills_list` (DFP #192 — consumer-shape
  templated skills like `chief-engineer-review` + `chief-engineer-blitz`,
  driven by `darkfactory.yaml`)
- **9 URI-addressable resources** — `df://repo/cycles`, `df://repo/cycle/{id}`,
  ADRs, findings, runs/recent, audit-log, principles. Templated `list` callbacks
  auto-enumerate known cycles + ADRs, so `resources/list` at session start gives
  the agent a complete index
- **7 prompts** — `df.write_cycle_doc`, `df.draft_adr`,
  `df.diagnose_critic_failure`, `df.summarize_recent_runs`,
  `df.onboarding_analysis`, plus `df.handoff` (note-writing judgment + the
  security rule) and `df.rehydrate` (the live-state-first ritual). Pure
  templates (no LLM call server-side); the client's LLM renders them
- **Logging notifications** — long-running tools emit `notifications/message`
  so the user sees `[df] running cursor critic...` → `[df] critic finished:
  APPROVED` inline

Pinned MCP protocol version: `2025-06-18`. See
[`CONSUMER-ADOPTION.md §11`](docs/CONSUMER-ADOPTION.md#11-wire-the-mcp-server-into-your-agent)
for wiring.

## Session continuity — the agent handoff protocol

A session restart (reboot, local-model upgrade, dev→dev, dev→cloud-agent)
destroys an agent's working context. The **state** of a work-stream (branch,
diff, CI, mergeability) is always recoverable from `gh` / the tracking issue;
the **reasoning** (why this approach, what was rejected, traps hit, where you
were mid-thought) is not — it evaporates with the session.

The handoff verbs staple that reasoning to a tracking issue as a single
marker-bounded comment and model the **baton** entirely on native GitHub
primitives — no new system:

- a **`handoff` label** = the stack
- the **assignee** = who holds the baton
- the **issue timeline** = the acceptance audit (recorded for free)

Four verbs, available as both CLI subcommands and MCP tools/prompts:

| Verb | CLI | MCP tool | When |
|---|---|---|---|
| Hand off | `df handoff <issue> < note.md` | `df_handoff` | Pausing / ending / switching away — leave a note + put the issue on the stack |
| List the stack | `df handoffs` | `df_handoffs` | Fresh start — what's available to pick up? |
| Accept | `df accept <issue>` | `df_accept` | Take over a handoff — claim it (assign you, take it off the stack), then rehydrate |
| Rehydrate | `df rehydrate <issue>` | `df_rehydrate` | Resume your *own* in-flight work — read-only catch-up, no ownership change |

The note is a single comment bounded by `<!-- agent-context:v1 -->` markers
(upserted, so re-handing-off edits in place). **Security rule (hard):** an
issue comment is repo-readable and cached/indexed even after deletion, so the
note carries *setup steps* (procedural) — **never** secret values, tokens,
credential paths, or connection strings. `df handoff` scrubs the note for
secret-shaped content and refuses on a match (reporting line numbers only,
never the value). `df rehydrate` derives **live state itself** with fixed,
script-owned `gh` commands and prints it FIRST — it never executes text
transcribed from a comment (which is an injection vector). The `df.handoff` /
`df.rehydrate` MCP prompts carry that judgment for the composing/resuming agent.

See
[`CONSUMER-ADOPTION.md § handoff`](docs/CONSUMER-ADOPTION.md#12-session-continuity--the-agent-handoff-protocol)
for the full data flows.

## Reusable workflows

Consumer repos `uses:` these from their own CI. A reusable workflow invoked via `uses:` reports the status-check context as `<caller-job-id> / <callee-job-name>`; every dark-factory callee omits a job-level `name:` override so the callee segment defaults to the job id (issue #27). The right column is the EXACT string a consumer ruleset must require — see [CONSUMER-ADOPTION.md §8](docs/CONSUMER-ADOPTION.md#8-make-dark-factory-binding-required-for-enforcement) for the naming contract.

| File | Consumer status-check context | Purpose |
|---|---|---|
| `.github/workflows/agent-critic.yml` | `agent-critic / agent-critic` | Multi-vendor critic quorum (Cursor / Codex / Gemini / Grok) |
| `.github/workflows/pr-status-check.yml` | `pr-status-check / pr-status-check` | Aggregator gate |
| `.github/workflows/schema-check.yml` | `schema-check / schema-check` | Builds `@momentiq/dark-factory-schemas` |
| `.github/workflows/cycle-doc-validation.yml` | `cycle-doc-validation / cycle-doc-validation` | Enforces `Cycle:` / `Issue:` PR trailers |
| `.github/workflows/branch-protection-audit.yml` | `branch-protection-audit / branch-protection-audit` | Drift detector for branch rulesets |

> Dark-factory's own repo invokes these workflows directly (via `pull_request:`, not `uses:`), so the context here is the bare job id (`pr-status-check`, `agent-critic`, etc.) — see `.github/rulesets/main.json`.

### Consumer wiring

```yaml
# consumer-repo/.github/workflows/agent-critic.yml
name: Agent Critic
on:
  pull_request:
    branches: [main]
  merge_group:
jobs:
  # IMPORTANT: a reusable workflow invoked via `uses:` produces a
  # status-check context of `<caller-job-id> / <callee-job-name>`,
  # NOT the bare callee name. The caller job-id below is `agent-critic`
  # and the callee's internal job is also named `agent-critic`, so the
  # emitted context is exactly `agent-critic / agent-critic` — that is
  # the literal string your enforcement ruleset must require (see
  # docs/CONSUMER-ADOPTION.md §8). Requiring the bare `agent-critic`
  # would never match and would block every PR forever.
  agent-critic:
    uses: momentiq-ai/dark-factory/.github/workflows/agent-critic.yml@v0.1.0
    secrets:
      CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
      CODEX_API_KEY:  ${{ secrets.CODEX_API_KEY }}
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
      XAI_API_KEY:    ${{ secrets.XAI_API_KEY }}
```

### Versioning

Only exact `@vX.Y.Z` tags are supported. Floating `@v0` / `@v0.1` tags are NOT
created — the same consumer commit always resolves to a single workflow
definition + CLI version.

Full consumer guide: [`docs/CONSUMER-ADOPTION.md`](docs/CONSUMER-ADOPTION.md).

## Status

`@momentiq/dark-factory-cli@1.0.0` is shipped on npm. The hosted Dark Factory
runtime is in **Limited Availability** — curated pilot customers, hands-on
onboarding. SOC2, billing automation, self-serve install wizard, fleet
dashboard, and the BYOK key vault are on the GA roadmap. If you're ready for a
serious deployment, [get in touch](https://momentiq.ai/contact?topic=enterprise).

## License

Apache-2.0. See [LICENSE](LICENSE).
