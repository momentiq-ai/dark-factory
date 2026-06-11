# Get started (lightweight) — scaffold a lean TypeScript product and gate it with Dark Factory

> **Prefer a small, one-language starter over the full Sage scaffold?**
> This is the lean path: clone a TypeScript template, `bun install`, and you're
> gated by Dark Factory from commit one — no Copier, no Python, and no Kubernetes
> in your dev loop. Still powered by Cerebe, Momentiq's cognitive engine.

This is an **alternate** to [`getting-started.md`](getting-started.md). That doc
scaffolds the full Momentiq product (Sage → Cerebe → Dark Factory, with k8s,
Temporal, ArgoCD, the works). This one trades that breadth for speed and a single
language. Both end at the same place: **a running product gated by Dark Factory.**

## Which path is for me?

| | **Sage** ([getting-started.md](getting-started.md)) | **Template** (this doc) |
|---|---|---|
| Scaffolder | Copier template via `@momentiq/sage-cli` (needs Python) | GitHub template repo + a `bun run init` rename (no Python) |
| Stack | FastAPI + Next.js + LangGraph (Python) | Hono + Vite/Svelte + LangGraph.js (one language: TypeScript) |
| Cognitive engine | Cerebe — deep SDK integration (memory, KG, RAG) | Cerebe — chat via its OpenAI-compatible endpoint (deeper SDK features opt-in) |
| Local dev | k3d Kubernetes cluster | native `bun run dev` — **no Docker/k8s** |
| Deploy | Helm + GKE, ArgoCD GitOps | one container to a PaaS, or the bundled kustomize k8s base — opt-in |
| Dark Factory gate | ✅ commit + push | ✅ commit + push (identical CLI + contract) |
| Best when | you want the full platform, Python ecosystem, scale-out infra | you want a small internal app/dashboard up in minutes, one mental model |

The Dark Factory layer is **identical** on both paths — same
`@momentiq/dark-factory-cli`, same `.agent-review/config.json`, same per-SHA
evidence artifacts. You're choosing a scaffold, not a different gate.

## What you'll build

- A **TypeScript product** — Hono + LangGraph.js backend, Vite + Svelte frontend,
  sharing types through one package
- Running **natively** at `http://localhost:5173` — no containers
- A **first agent turn** answered by Cerebe
- A **first commit reviewed** by the Dark Factory local critic quorum, with an
  evidence-bound artifact at `.git/agent-reviews/<sha>.md`
- *(Opt-in)* a **hosted critic** Check Run on your pull requests
- A **deploy path that exists but never touches dev** (Docker + kustomize k8s)

The reference template is **[`taxgen-template`](https://github.com/SJBarras/taxgen-template)**.
Its own [`docs/getting-started.md`](https://github.com/SJBarras/taxgen-template/blob/main/docs/getting-started.md)
is the full app-level walkthrough; this page is the Dark-Factory-centric entry
point and links into it rather than duplicating it.

## Drive this with an AI agent (recommended)

Paste this into Claude Code, Cursor, or any agentic surface; it will run the
walkthrough interactively, confirm before anything destructive, and surface URLs:

```
You are helping me start a lean agentic product from the taxgen-template
(TypeScript: Bun + Hono + LangGraph.js backend, Vite + Svelte frontend), gated by
Dark Factory. Native dev must never require Docker or Kubernetes.

Walk me through these steps interactively — show the command, ask before anything
destructive, run it, verify the outcome, then continue. If something fails,
diagnose and propose a fix.

1. Prereqs: bun (>=1.1), git, gh. On Windows confirm I'm in WSL2 with the repo on
   the Linux filesystem. Authenticate at least one Dark Factory critic
   subscription (Cursor and/or Codex) — the gate fails closed without one.
2. Get a clean, history-free copy of the template (no .git):
     mkdir <my-slug> && gh api repos/SJBarras/taxgen-template/tarball/main \
       | tar -xz --strip-components=1 -C <my-slug>
   then cd into it.
3. Name it: bun run init -- --dry-run --name "<My Product>"  (preview), then apply.
4. Make it a git repo (the tarball has no .git): git init -b main && git add -A &&
   git commit -m "chore: init from taxgen-template". Then bun install. Confirm
   ./node_modules/.bin/df --help works and the husky hooks armed (git config
   core.hooksPath == .husky/_).
5. Native dev: cp .env.example .env; bun run dev. Surface http://localhost:5173
   and the backend health check at http://localhost:8787/health.
6. First agent turn: help me get a Cerebe API key, set it in .env, then send
   a chat message in the dashboard — the reply streams back from Cerebe (the
   agent is already implemented).
7. Auth — recommended, but optional for a first test. Help me set up Clerk
   sign-in: create a Clerk app, put CLERK_SECRET_KEY + VITE_CLERK_PUBLISHABLE_KEY
   in .env, and restart dev. The app is already wired for it — with keys it gates
   behind sign-in; without them it runs open (fine for testing). Recommended
   before exposing the dashboard to anyone.
8. Dark Factory local gate: make a trivial change, commit, and confirm the
   post-commit critic wrote .git/agent-reviews/<sha>.md with a verdict; then push
   and confirm the pre-push gate passed.
9. (Optional) Hosted gate: walk me through installing the Dark Factory GitHub App
   and the CI workflow per CONSUMER-ADOPTION.md.

Start at step 1. Ask before each shell command.
```

## …or follow the steps manually

### Prereqs

**Must have:** [Bun](https://bun.sh) ≥ 1.1, Git ≥ 2.40, and **macOS or Linux**
(on **Windows use [WSL2](https://learn.microsoft.com/windows/wsl/install)** — Bun
inside the distro, repo on the Linux filesystem). [`gh`](https://cli.github.com)
to pull the template copy (Step 1) and create your repo.

**Before your first commit is gated:** at least one **Cursor and/or Codex
subscription, authenticated** (`cursor-agent` sign-in / `codex login`). With zero
critics authenticated the pre-push gate **fails closed**.

**Later, per step:** a Cerebe API key (the agent), and optionally Clerk
(auth) and Doppler (prod secrets). **Node.js is not required** — Bun runs
everything, including the self-contained Dark Factory CLI bundle.

### Step 1 — Get a clean copy of the template

Pull a **pure file copy** of the template — no git history, no `.git` at all —
straight from GitHub via your `gh` auth (works on the private repo):

```bash
mkdir my-product
gh api repos/SJBarras/taxgen-template/tarball/main \
  | tar -xz --strip-components=1 -C my-product
cd my-product
```

This replaces the Sage `copier copy` step: a fresh tree, no history, no Python,
and nothing to detach later. (`--strip-components=1` drops GitHub's
`SJBarras-taxgen-template-<sha>/` wrapper directory.) You can pin a tag or commit
SHA instead of `main`: `.../tarball/<ref>`. You'll turn this into your own git
repo during setup below (before the local gate can run).

### Step 2 — Name your product

```bash
bun run init -- --dry-run --name "My Product"   # preview
bun run init -- --name "My Product"             # apply (derives a slug)
```

Pure text substitution of the template's slug/display name across the tree — the
lightweight replacement for Copier's variable rendering. See the template's
[`docs/getting-started.md`](https://github.com/SJBarras/taxgen-template/blob/main/docs/getting-started.md) Step 0.

### Step 3 — Initialize git + install (this turns the gate on)

The tarball gave you a clean tree with **no `.git`**. Make it your own repo
first — Husky needs a git repo to arm the hooks — then install:

```bash
git init -b main
git add -A && git commit -m "chore: init from taxgen-template"
bun install
./node_modules/.bin/df --help        # confirm the Dark Factory CLI landed (2.5.0)
```

`bun install` pulls every workspace **and** `@momentiq/dark-factory-cli` (pinned
exactly, per the consumer contract), then runs `prepare`, which arms the Husky
hooks (`core.hooksPath` → `.husky/_`). The hooks were **dormant until now** — the
critic reviews from your **next commit onward** (so the initial commit above is
intentionally un-gated). Commit the resulting `bun.lock`.

### Step 4 — Native dev (no Docker, no k8s)

```bash
cp .env.example .env
bun run dev          # backend :8787 + frontend :5173, both hot-reload
```

Open <http://localhost:5173>. This is the whole inner loop — exactly the
difference from the Sage path, which brings up a k3d cluster here.

### Step 5 — First agent turn

The agent is **already implemented** — a LangGraph.js `StateGraph` calling Cerebe,
streamed to the chat UI over SSE. Get a Cerebe API key, set
`CEREBE_API_KEY` in `.env`, and **send a message in the dashboard chat** — the
reply streams in token by token. (No key yet? The chat shows a clear
`authentication_error` — that's the wiring working; add the key.) Background on
the LangGraph shape is in the template's
[`docs/getting-started.md`](https://github.com/SJBarras/taxgen-template/blob/main/docs/getting-started.md) Step 3.
*(Prefer raw Anthropic instead? See the template's `docs/notes.md` §4.)*

### Step 6 — First commit hits the local Dark Factory gate

Authenticate at least one critic subscription (above), then:

```bash
# edit something
git add -A && git commit -m "feat: first change"
```

The `post-commit` hook fires `df review` in the background. After ~30–90s:

```bash
cat .git/agent-reviews/$(git rev-parse HEAD).md     # APPROVED / CHANGES_REQUESTED / BLOCKED
```

On `CHANGES_REQUESTED`, address findings in a **new commit** (never amend — the
artifact is bound to the original SHA). Then `git push`; the `pre-push` hook runs
`df gate-push` and lets an APPROVED HEAD through. This is the **same gate** the
Sage path uses — identical CLI, config shape, and evidence format.

### Step 7 — *(Opt-in)* hosted critic on pull requests

The local gate is standalone. To add a hosted **Check Run** on PRs, install the
**Dark Factory GitHub App** and the CI workflow per
[`CONSUMER-ADOPTION.md`](CONSUMER-ADOPTION.md) (§6+). This needs a reusable
workflow reference, cloud-critic API-key secrets, and a branch ruleset — so it's
opt-in, not shipped in the template. Add it before multi-author merges.

### Step 8 — *(Optional)* deploy

Everything container/k8s lives isolated in the template's `deploy/` with its own
guide — Docker images + a kustomize k8s base, reached only when you choose to
ship. Nothing there is needed for, or touched by, dev.

## What you have now

- A **lean TypeScript product** running natively, no infrastructure
- A **first agent call** through Cerebe
- A **first commit + push gated** by the Dark Factory local critic quorum, with
  evidence on disk — the **same gate** as the Sage path
- An opt-in route to the **hosted critic** and to **deployment**, both isolated
  from your dev loop

## Where to go next

- Template walkthrough + open decisions:
  [`taxgen-template/docs/getting-started.md`](https://github.com/SJBarras/taxgen-template/blob/main/docs/getting-started.md)
  and [`docs/notes.md`](https://github.com/SJBarras/taxgen-template/blob/main/docs/notes.md)
- Retrofit Dark Factory into an existing repo: [`CONSUMER-ADOPTION.md`](CONSUMER-ADOPTION.md)
- The full platform scaffold instead: [`getting-started.md`](getting-started.md)
