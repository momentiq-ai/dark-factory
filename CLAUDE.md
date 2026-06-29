@AGENTS.md

# CLAUDE.md — Claude Code overlay

[`AGENTS.md`](AGENTS.md) (imported above) is the **canonical, universal contract**
for this repo. Every non-negotiable rule, the architecture, the no-human-review /
merge posture, the N=2 iteration ceiling, verifiable objectives, the orchestrator
workflow, and the consumer contract live there and apply to Claude Code in full.

This file adds **only** Claude-Code-specific configuration. It deliberately does
**not** restate universal doctrine — duplicated doctrine drifts from `AGENTS.md`,
and anything that lives only here is invisible to non-Claude agents (which read
only `AGENTS.md`). When a rule is universal, it belongs in `AGENTS.md`.

## Model + thinking defaults

**Required for all Claude Code sessions on this repo (humans and AI agents alike):**

- **Model:** `claude-opus-4-7-1m` (1M-context Opus)
- **Thinking:** `max`

Headless invocation:

```bash
claude -p --model claude-opus-4-7-1m --thinking max --dangerously-skip-permissions "<task brief>"
```

The local critic fleet is calibrated to Opus-quality output; inconsistent model
selection produces inconsistent review signal. Deviations are allowed for genuinely
mechanical tasks (variable rename, formatting-only changes) — document the deviation
in the PR body so reviewers calibrate accordingly.

## Claude Code tooling

How Claude Code executes the universal rules in `AGENTS.md`:

- **Worktree-first** (`AGENTS.md` § Non-Negotiable Rules): use the **`EnterWorktree`**
  tool to start branch work — not manual `git worktree` — so the session switches
  into the isolated checkout under `.claude/worktrees/`.
- **N=2 iteration ceiling** (`AGENTS.md` § Non-Negotiable Rules, rule 8): when it
  triggers, call the **`advisor`** tool (no parameters — it auto-forwards full
  context) to identify the structural cause before any further fix.
- **Verifiable objectives** (`AGENTS.md` § Verifiable objectives): author at plan
  time via the **`/objectives`** Skill, which ships with this CLI.
