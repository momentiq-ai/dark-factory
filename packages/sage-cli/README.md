# @momentiq/sage-cli

Sage CLI — scaffold a production-ready agentic AI product in one command. Pre-wired to [Cerebe](https://cerebe.ai) (the cognitive engine) and the [Dark Factory](https://github.com/momentiq-ai/dark-factory) gate (the autonomous SDLC) on commit one.

> Sage is Pillar #2 of the Momentiq platform: **Scaffold with Sage → implement on Cerebe → ship through Dark Factory.**

## Quick start

```bash
npm install -g @momentiq/sage-cli
sage init hireflow --primary-persona employer --domain hireflow.ai
cd hireflow
make k8s-up
make k8s-build-deploy-smart
```

Or one-shot:

```bash
npx @momentiq/sage-cli init hireflow
# interactive prompts will fill in the required values
```

## What you get

A scaffolded product with, on commit one:

- **FastAPI backend** with async PostgreSQL, Redis caching, Poetry-managed dependencies
- **Next.js 14 frontend** with App Router, TypeScript, Tailwind CSS, `assistant-ui` chat surface
- **LangGraph agent runtime** with ReAct architecture and dynamic skill selection
- **Clerk authentication** with persona-based access control
- **Doppler secrets** wired per-environment
- **Helm charts** for local (k3d) and production (GKE) clusters
- **Highlight.io + OpenTelemetry** session replay, traces, logging, dashboards
- **Cerebe SDK** pre-installed and pointed at the cognitive engine
- **Dark Factory gate** installed (Husky hooks, `.agent-review/config.json`, the `dark-factory-pr` workflow, MCP wiring)
- **Handoff protocol** pre-wired (the four-verb session-continuity protocol)
- **Multi-IDE context-docs** for Claude Code, Cursor, Codex, Gemini, and Copilot
- **Optional Temporal workflows** behind a single flag

## Prerequisites

- **Node 20+** (for this CLI)
- **Python 3.11+** with `copier` installed:
  ```bash
  pipx install copier   # recommended
  pip install copier    # alternative
  ```
- **Docker Desktop** with k3d (for the local Kubernetes cluster the scaffolded product runs in)
- **Doppler CLI** for secrets management (optional — prompt at scaffold time)

## Commands

### `sage init [slug]`

Scaffold a new product from the bundled Sage template.

```bash
sage init hireflow \
  --product-name HireFlow \
  --primary-persona employer \
  --secondary-persona candidate \
  --domain hireflow.ai
```

Any required value not passed on the command line is prompted interactively.

| Flag | Purpose | Default |
|---|---|---|
| `[slug]` (positional) | Directory and product slug | derived from `--product-name` |
| `-n, --product-name <name>` | Display name (e.g. `HireFlow`) | prompted |
| `-p, --primary-persona <persona>` | Primary user role | prompted |
| `-s, --secondary-persona <persona>` | Optional secondary role (`''` to skip) | prompted |
| `-d, --domain <domain>` | Production domain (e.g. `hireflow.ai`) | prompted |
| `--github-org <org>` | GitHub organization | `momentiq-ai` |
| `--skip-df-gate` | Skip Dark Factory gate wiring | off |
| `--skip-cerebe` | Skip Cerebe SDK wiring | off |
| `--no-post-install` | Suppress the post-scaffold next-steps printout | off |
| `--accept-defaults` | Pass `--defaults` to Copier (skip advanced prompts) | on |

### `sage update [destination]`

Pull the latest bundled template into an existing scaffolded product. Defaults to the current working directory.

```bash
cd hireflow
sage update                # interactive merge of any conflicts
sage update --dry-run      # show what would change without writing
```

The CLI reports template drift before running `copier update`, so you can see your product's anchored commit versus the bundled commit.

### `sage --version`

Reports both the CLI version and the bundled sage-blueprint commit hash. Include this in bug reports.

```bash
$ sage --version
@momentiq/sage-cli 0.1.0 (bundled sage-blueprint@9a3f4c2b7e1d via ref main)
```

## How it works

This CLI is a thin wrapper around [Copier](https://copier.readthedocs.io/). The Sage template (Apache-2.0) is bundled inside the npm package at build time, so:

- You install **one npm package**; no GitHub authentication needed
- The wrapper resolves the bundled template path; no separate template fetch
- Pre-filled defaults collapse the template's ~19 prompts down to 4 (product name, personas, domain); pass `--accept-defaults` (the default) to skip advanced prompts
- `sage update` runs `copier update` against the bundled template hash, so you can stay current as the template advances

## License

Apache-2.0. The bundled Sage template is also Apache-2.0; see `template/LICENSE` in any scaffolded product.

## Issues + roadmap

- File issues at [`momentiq-ai/dark-factory`](https://github.com/momentiq-ai/dark-factory/issues)
