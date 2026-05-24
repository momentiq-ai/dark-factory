# Dark Factory

> Pillar #1 of the momentiq.ai platform: **the autonomous AI-native software development lifecycle**. Agents author, critic, validate, and ship. Every gate is deterministic and auditable.

## Status

Pre-launch. Active extraction from `momentiq-ai/sage3c` via [cycle 331](https://github.com/momentiq-ai/sage3c/blob/main/docs/roadmap/cycles/cycle331-dark-factory-platformization.md). Public OSS release ships in cycle 331.3. **Until then, source-of-truth for design + status is the sage3c roadmap** (see [`docs/roadmap/dark-factory-roadmap.md`](docs/roadmap/dark-factory-roadmap.md) pointer).

## What's here (post-extraction target state)

- `@momentiq/dark-factory-cli` — OSS CLI (Cursor / Codex / Gemini / Grok adapters, min-complete-quorum aggregation)
- `@momentiq/dark-factory-schemas` — JSON Schemas for `darkfactory.yaml` + per-SHA evidence + cycle-doc trailer formats
- `.github/workflows/*.yml` — reusable GitHub Actions consumers reference via `uses: momentiq-ai/dark-factory/.github/workflows/<name>.yml@v0.1.0`

## What's where (during extraction)

The substrate is currently being extracted from sage3c. Phases:

- **331.1 Phase A** (this commit): repo bootstrap — LICENSE, CODEOWNERS, README, .gitignore, workspaces package.json, CLAUDE.md, ruleset mirror
- **331.1 Phase B–F**: service-by-service extraction
- **331.1 Phase F.5a + F.5b**: first-client validation on `momentiq-ai/taxpilot2a` + `alien8d/lyra`
- **331.1 Phase G + H**: sage3c + cerebe-platform migrate to consume the extracted dep
- **331.1 Phase I**: sage-blueprint updated

## License

Apache-2.0. See [LICENSE](LICENSE).
