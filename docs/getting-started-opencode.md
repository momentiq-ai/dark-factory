# Getting Started: authoring with OpenCode + Dark Factory

This guide stands up **[OpenCode](https://opencode.ai)** — a model-agnostic,
MCP-native terminal agent — as a first-class authoring harness for Dark Factory,
using an **outside-family creator model** (reference: **Kimi K2.7-Code via
OpenRouter**) as the author.

It exercises the **creator-model-autonomy** principle: **the gate judges the
output, not the author.** A commit authored by OpenCode + Kimi is reviewed by the
identical critic fleet, on the identical diff, as a commit authored by Claude
Code — because the gate fires from your `.husky` git hooks, which are
harness-agnostic and need nothing on the agent side.

> **Audience.** Any Dark Factory consumer (or this repo, dogfooding). You need
> the `@momentiq/dark-factory-cli` already wired per
> [`CONSUMER-ADOPTION.md`](CONSUMER-ADOPTION.md) (the `.husky` hooks,
> `.agent-review/config.json`, and `df` on `npx`). This guide adds **only** the
> OpenCode-side wiring; it changes nothing about the gate.

## Why OpenCode needs its own config

OpenCode configures its **MCP servers** in its own `opencode.json` (global
`~/.config/opencode/` + per-project `./opencode.json`, merged) — it does **not**
auto-read Claude Code's `.mcp.json`. So to expose the `df_*` MCP tools
(`df_handoff`, `df_accept`, `df_rehydrate`, `df_handoffs`, `df_review`,
`df_gate_push`, `df_findings`, …) to an OpenCode agent, you declare the
`dark-factory` MCP server in `opencode.json`.

Repo **guidance**, by contrast, needs no per-client carve-out: OpenCode reads
`AGENTS.md` natively, so the repo's universal guidance reaches it with no extra
wiring. The one nuance is handoff note-writing — see
[Handoffs](#handoffs-via-mcp) below.

## 1. Install OpenCode

```bash
npm i -g opencode-ai      # or: brew install opencode
opencode --version        # verify it's on your PATH
```

## 2. Choose + authenticate a model (secrets never touch the repo)

Reference arm: **Kimi K2.7-Code** via OpenRouter (`openrouter/moonshotai/kimi-k2.7-code`).
It leads MCP tool-use benchmarks — the axis the handoff protocol exercises — so
it is the strongest outside-family reference for this flow. `kimi-k2.6` (agent
swarm generalist) is a fine alternative; it's a one-line model-string change.

The OpenRouter key is referenced from the environment — **never** written into
`opencode.json`, a `.env`, or the repo (`.gitignore` already excludes `.env*` /
`.doppler*`).

**momentiq-internal (Doppler — the standard posture here):** the key lives in
Doppler; launch OpenCode under `doppler run` so it's injected as
`OPENROUTER_API_KEY`:

```bash
doppler run -p dark-factory -c dev -- opencode
```

**Generic (any team):** authenticate once with OpenCode's credential store
(written to `~/.local/share/opencode/auth.json`, outside the repo):

```bash
opencode auth login        # choose OpenRouter, paste the key
```

…or export `OPENROUTER_API_KEY` in your shell from your own secret manager.

## 3. Wire the `dark-factory` MCP server (`opencode.json`)

Drop this in your repo root (identical to this repo's committed
[`opencode.json`](../opencode.json)):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dark-factory": {
      "type": "local",
      "command": ["npx", "df", "mcp"],
      "enabled": true,
      "environment": { "AGENT_REVIEW_PROFILE": "local" }
    }
  }
}
```

> **Model is per-author, not baked into the project config.** The snippet carries
> **only** the `dark-factory` MCP wiring — it omits `"model"` so a checked-in
> project config can't override a contributor's own OpenCode model preference
> (project config outranks global). The reference arm is **Kimi K2.7-Code**
> (`openrouter/moonshotai/kimi-k2.7-code`, see §2); set it in *your* own
> `opencode.json`'s `"model"` key, your global `~/.config/opencode/`, or
> interactively in a session.

Note the OpenCode schema specifics: the top-level key is **`mcp`** (not
`mcpServers`), a local stdio server uses **`"type": "local"`**, `command` is an
**array**, and env vars go under **`environment`**. (This differs from the
Claude Code / Cursor / Codex / Gemini shapes — see
[`CONSUMER-ADOPTION.md` §13](CONSUMER-ADOPTION.md#13-wire-the-mcp-server-into-your-agent).)

### Smoke-test the wiring

```bash
opencode mcp list      # → dark-factory ✓ connected
```

Then, in a session (or headless), ask the agent to call a read-only tool:

```bash
doppler run -p dark-factory -c dev -- \
  opencode run "Use the dark-factory MCP server: call df_doctor and summarize."
```

The agent connects, enumerates the `df_*` catalog, calls `df_doctor`, and renders
the structured `{ ok, checks }` result.

## 4. The author → gate → handoff flow

### Worktree + gate

Follow the repo's worktree-first rule (see [`AGENTS.md`](../AGENTS.md)). Author
your change in OpenCode, commit, and let the **local critic gate** fire from
`.husky` — `post-commit` runs `df review`, `pre-push` runs
`df gate-push --profile local`. The gate is harness-agnostic: it does not know or
care that OpenCode authored the diff. **Never bypass a real finding.**

### Handoffs via MCP

The agent handoff protocol (session continuity, anchored on a dedicated GitHub
Issue) is driven entirely through MCP tools — no Claude-Code-specific slash
commands required:

| Verb | MCP tool | When |
|---|---|---|
| Hand off | `df_handoff` | Pause / end / switch a work-stream — put it on the stack |
| List stack | `df_handoffs` | Fresh start — what's available to pick up? |
| Accept | `df_accept` | Take the baton: claim + rehydrate + close (atomic) |
| Rehydrate | `df_rehydrate` | Resume your own work, or read a closed handoff forensically |

**Note-writing judgment travels in the tool schema.** Claude Code receives the
handoff note format + security rule via the `df.handoff` / `df.rehydrate` MCP
*prompts*. OpenCode (like Codex and Cursor) surfaces MCP **tools** but not MCP
**prompts** — so the `df_handoff` tool's `note` input-schema description carries
the two things a tool-only agent can't otherwise get: the marker-bounded
**format** (the `agent-context:v1` skeleton) and the **hard secrets rule** (the
note becomes a public Issue body — write setup steps, never tokens/keys/paths).
That is deliberately the *minimum* — enough to compose a valid, safe note from
tool metadata alone. (Single source:
[`packages/cli/src/handoff/note-contract.ts`](../packages/cli/src/handoff/note-contract.ts),
consumed by both the prompt and the tool — they cannot drift.)

**The full authoring doctrine** (what Claude Code gets from the `df.handoff`
prompt) is here for OpenCode authors:

- **Omit what's already tracked.** The note is *transient reasoning*, not a status
  mirror. Live state — what's merged, what's open, who's assigned — is recoverable
  from `gh` / the linked PRs, so don't restate it; it only goes stale.
- **Link, don't copy.** Reference the Issue and linked work items; don't paste
  their contents into the note.
- **The derive-state line stays generic.** The skeleton's closing block points the
  next session at `df_rehydrate` (and, generically, `gh issue view <N>`). Leave
  `<N>` as the literal placeholder — do **not** bake the real Issue number into a
  runnable command (the only placeholders you fill are the `_Updated:_` date, your
  model/session identity, and the prose bullets).
- **Set the date.** `_Updated:_` must be today's date; an unparseable date silently
  disables the staleness guard.

## What to expect — smoke-test the harness yourself

Run these against your repo to confirm the flow end-to-end:

- **Tool discovery (key-free).** `opencode mcp list` → `dark-factory ✓ connected`;
  an agent turn enumerates the full `df_*` tool catalog.
- **Tool round-trip.** Ask the agent to call `df_doctor` via MCP and summarize the
  structured `{ ok, checks }` result.
- **Handoff round-trip.** Have the agent drive `df_handoff` (create) → `df_accept`
  → close on a throwaway handoff issue. It ends `state: CLOSED`,
  `labels: [handoff]` (the `handoff` label survives the close, per the protocol's
  lifetime contract — verify with `gh issue view <N>`).
- **The tool-schema judgment.** A tool-only client (no MCP prompt) should compose
  a *fully-structured* note from the `df_handoff` schema alone — the `> 🤖`
  header, the `_Updated:_` line, and the Why-rejected / Traps / Mid-thought /
  Derive-state sections — not a hollow, markers-only note. That structuring,
  driven by tool metadata, is the point of [`note-contract.ts`](../packages/cli/src/handoff/note-contract.ts).

### Known wrinkles (expected, not bugs)

- **`df_handoffs` lag.** Immediately after `df_handoff` creates an issue, a
  back-to-back `df_handoffs` may not list it yet — `gh issue list` is
  search-indexed and eventually consistent. The issue still exists; `df_accept` /
  `df_rehydrate` on its number work immediately.
- **`df_accept` return payload.** `df_accept` returns the *rehydration snapshot*
  (which reflects pre-close state), then performs the close. The agent may report
  the issue as still open; verify with `gh issue view <N>` — it will be `CLOSED`.
- **Parallel tool calls.** Kimi may fire tools in parallel and a redundant call
  can be cancelled ("tool execution aborted"); it recovers and completes. Harmless.

## Onboarding one command at a time

This guide is the contract; for the full consumer surface (hooks, config,
enforcement) see [`CONSUMER-ADOPTION.md`](CONSUMER-ADOPTION.md). A `df`-side
scaffolder that emits this `opencode.json` (e.g. `df mcp config --client opencode`)
is a natural follow-up once the template has soaked — tracked with this work.
