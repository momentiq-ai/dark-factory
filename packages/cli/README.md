# @momentiq/dark-factory-cli

Dark Factory OSS CLI — multi-vendor adversarial critic orchestration.

## What this package gives you

Three services, today consumable as a TypeScript library:

1. **Critic Orchestrator** (`./adapters/*`) — vendor-neutral adapter contract (`CriticAdapter`) with concrete adapters for Cursor SDK, OpenAI Codex SDK, Google Gemini, and Grok (xAI via OpenAI-compatible API).
2. **Policy Engine** (`./policy/*`) — gate evaluation, min-complete-quorum aggregation, TDD classifier, finding-rubric strip, verification routes, profile resolution, and config loading.
3. **Trusted-Surface Rebind** (`./trusted-surface/*`) — when a commit modifies the trusted policy surface (config + guidance files + prompt fragments), the rebind reads those inputs from the parent ref so the commit is reviewed against the prior baseline (self-modification guard).

## Status

`0.1.0-alpha.0` — extracted from `momentiq-ai/sage3c:tools/agent-review/` per cycle 331.1 Phase B. Library API is stable; CLI subcommand surface is a stub (Phase E).

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
} from "@momentiq/dark-factory-cli";

const loaded = await loadAgentReviewConfig(repoRoot);
const outcome = await runReview({ loaded, /* ... */ });
```

## CLI

```bash
df --help
df --version
```

Subcommand implementation lands in cycle 331.1 Phase E. Today the binary exists and prints help; subcommand calls exit with status 2 and a "not implemented" message pointing at the library API.

## System requirements

- Node.js >=20
- `git` available on `PATH` (the rebind + config-from-ref code paths shell out to git)

## License

Apache-2.0. The OSS critic surface is a public artifact. Calibrated prompts and the App's calibrated bypass-classifier are out-of-scope here and live in private repos.
