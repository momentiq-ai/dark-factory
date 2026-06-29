# GEMINI.md

Pointer file for the Google Gemini CLI in `momentiq-ai/dark-factory`.

[`AGENTS.md`](AGENTS.md) is the **canonical, universal contract** — every
operational rule, the architecture, the build/test commands, the merge posture,
the N=2 iteration ceiling, verifiable objectives, and the consumer contract live
there and apply to Gemini CLI in full. **Read it first, before acting.**

Gemini CLI has no file-import mechanism (unlike Claude Code's `@AGENTS.md`), so
this file cannot transclude `AGENTS.md` — treat the pointer as mandatory: load
`AGENTS.md` into context at the start of every session. This file deliberately
carries **no standalone doctrine**; anything restated here would drift from
`AGENTS.md`, which is the single source of truth.

There is no Gemini-specific configuration for this repo at present. For Claude
Code-specific overrides, see [`CLAUDE.md`](CLAUDE.md).
