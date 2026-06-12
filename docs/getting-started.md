# Get started — build a gated agentic product in minutes

> **Scaffold a product, wire Cerebe, gate it with Dark Factory — from commit one.**
> Two paths, one gate. Pick the one that fits your stack.

## Which path is for me?

| | **TypeScript quickstart** (recommended) | **Sage full platform** |
|---|---|---|
| Scaffolder | GitHub template repo + `bun run init` (no Python) | Copier template via `@momentiq/sage-cli` (needs Python) |
| Stack | Hono + Vite/Svelte + LangGraph.js (one language: TypeScript) | FastAPI + Next.js + LangGraph (Python) |
| Cognitive engine | Cerebe — chat via its OpenAI-compatible endpoint (deeper SDK features opt-in) | Cerebe — deep SDK integration (memory, KG, RAG) |
| Local dev | native `bun run dev` — **no Docker/k8s** | k3d Kubernetes cluster |
| Deploy | one container to a PaaS, or the bundled kustomize k8s base — opt-in | Helm + GKE, ArgoCD GitOps |
| Dark Factory gate | commit + push | commit + push (identical CLI + contract) |
| Best when | you want a small internal app/dashboard up in minutes, one mental model | you want the full platform, Python ecosystem, scale-out infra |

The Dark Factory layer is **identical** on both paths — same
`@momentiq/dark-factory-cli`, same `.agent-review/config.json`, same per-SHA
evidence artifacts. You're choosing a scaffold, not a different gate.

---

## TypeScript quickstart (Cerebe template)

A lean TypeScript product — Hono + LangGraph.js backend, Vite + Svelte frontend —
running natively at `http://localhost:5173` with no containers.

The reference template is **[`df-cerebe-template`](https://github.com/momentiq-ai/df-cerebe-template)**.

### What you'll build

- A **TypeScript product** sharing types through one package
- Running **natively** at `http://localhost:5173` — no containers
- A **first agent turn** answered by Cerebe
- A **first commit reviewed** by the Dark Factory local critic quorum, with an
  evidence-bound artifact at `.git/agent-reviews/<sha>.md`
- *(Opt-in)* a **hosted critic** Check Run on your pull requests
- A **deploy path that exists but never touches dev** (Docker + kustomize k8s)

### Drive this with an AI agent (recommended)

Paste this into Claude Code, Cursor, or any agentic surface; it will run the
walkthrough interactively, confirm before anything destructive, and surface URLs:

````
You are helping me start a lean agentic product from the df-cerebe-template
(TypeScript: Bun + Hono + LangGraph.js backend, Vite + Svelte frontend), gated by
Dark Factory. Native dev must never require Docker or Kubernetes.

Walk me through these steps interactively — show the command, ask before anything
destructive, run it, verify the outcome, then continue. If something fails,
diagnose and propose a fix.

0. Project setup. Before anything else, ask me:
   a. Display name of the product (e.g., "Acme Dashboard").
   b. What folder to create it in (default: kebab-case slug of the display name,
      in the current directory).
   c. Do I already have a Cerebe API key? (required for chat to work — get one at
      https://cerebe.ai if not). Have me provide the key now or note that we'll
      set it during env configuration.
   d. Do I want to use Clerk for authentication? (optional — the app runs open
      without it; recommended before exposing to others). If yes, have me create
      a Clerk app at https://clerk.com and provide the two keys:
      CLERK_SECRET_KEY and VITE_CLERK_PUBLISHABLE_KEY.
   e. Do I want to use Doppler for secrets management? (optional — only relevant
      for production deploys; local dev uses .env). If yes, have me set up a
      Doppler project.
   f. Database: local SQLite file (default, zero setup) or remote Turso/libSQL
      (for horizontal scaling)? If Turso, have me create a database at
      https://turso.tech and provide the DATABASE_URL and TURSO_AUTH_TOKEN.

1. Prereqs: bun (>=1.1), git, gh. On Windows confirm I'm in WSL2 with the repo on
   the Linux filesystem. Authenticate at least one Dark Factory critic
   subscription (Cursor and/or Codex) — the gate fails closed without one.

2. Get a clean, history-free copy of the template (no .git), using the folder
   from step 0b:
     mkdir <folder> && gh api repos/momentiq-ai/df-cerebe-template/tarball/main \
       | tar -xz --strip-components=1 -C <folder>
   then cd into it.

3. Name it using the display name from step 0a:
     bun run init -- --dry-run --name "<Display Name>"  (preview), then apply.

4. Make it a git repo (the tarball has no .git): git init -b main && git add -A &&
   git commit -m "chore: init from df-cerebe-template". Then bun install. Confirm
   ./node_modules/.bin/df --help works and the husky hooks armed (git config
   core.hooksPath == .husky/_).

5. Configure environment: cp .env.example .env, then set the values based on the
   choices from step 0. For EVERY secret or key (Cerebe, Clerk, Turso token), ask
   me: "Do you want to paste the key here so I can set it, or would you prefer a
   command to run yourself in another terminal?" Then:
   - If I choose to paste it: write it into .env (or run the doppler command).
   - If I choose to set it myself: give me the exact command — which depends on
     whether I chose Doppler:
       Without Doppler:  echo 'VAR=value' >> .env  (or tell me to edit .env)
       With Doppler:     doppler secrets set VAR=value --project <slug> --config dev
   Apply this for each key:
   - CEREBE_API_KEY (required).
   - CLERK_SECRET_KEY + VITE_CLERK_PUBLISHABLE_KEY (if Clerk chosen in 0d).
   - DATABASE_URL + TURSO_AUTH_TOKEN (if Turso chosen in 0f).
   - If Doppler: also run doppler login && doppler setup, and note that
     doppler run -- bun run dev replaces bare bun run dev going forward.
   - If local SQLite (default): leave DATABASE_URL=file:./taxgen.db as-is.

6. Native dev: bun run dev. Surface http://localhost:5173 and the backend health
   check at http://localhost:8787/health. Confirm the chat works by sending a
   message — the reply should stream back from Cerebe token by token.

7. Dark Factory local gate: make a trivial change, commit, and confirm the
   post-commit critic wrote .git/agent-reviews/<sha>.md with a verdict; then push
   and confirm the pre-push gate passed.

8. (Optional) Hosted gate: walk me through installing the Dark Factory GitHub App
   and the CI workflow per CONSUMER-ADOPTION.md.

Start at step 0. Ask before each shell command.
````

**Paste it where you already work:**

- **Claude Code:** copy the block, paste into the prompt, hit Enter
- **Cursor:** copy, open Composer (⌘I), paste, send
- **Codex CLI:** `codex` → paste at the prompt → Enter
- **claude.ai:** start a new chat, paste, send

The agent drives steps 0–8; you answer the setup questions and confirm commands.

### ...or follow the steps manually

The rest of this section is the same walkthrough as text, in case you'd rather
drive it yourself.

### Prereqs

| Tool | Version | Why | macOS one-liner |
|---|---|---|---|
| [Bun](https://bun.sh) | >= 1.1 | Runtime, installer, and script runner for the entire stack | `brew install oven-sh/bun/bun` |
| Git | >= 2.40 | Source control + pre-push hook surface | (preinstalled) |
| [`gh` CLI](https://cli.github.com) | latest | Pull the template copy (Step 1) and create your repo | `brew install gh && gh auth login` |

**Windows:** use [WSL2](https://learn.microsoft.com/windows/wsl/install) — Bun
inside the distro, repo on the Linux filesystem.

**Before your first commit is gated:** at least one **Cursor and/or Codex
subscription, authenticated** (`cursor-agent` sign-in / `codex login`). With zero
critics authenticated the pre-push gate **fails closed**.

You also need:

- A **Cerebe API key** — **required** for the agent chat to function. Sign up at
  [cerebe.ai](https://cerebe.ai); free trial tier works. Keys look like `ck_live_...`
  or `ck_test_...`.
- *(Optional)* A **Clerk account** — for sign-in/auth gating. Create an app at
  [clerk.com](https://clerk.com) to get `CLERK_SECRET_KEY` and
  `VITE_CLERK_PUBLISHABLE_KEY`. Without these, the app runs open (unauthenticated)
  — fine for local dev/prototyping, but recommended before sharing the dashboard.
- *(Optional)* A **Doppler account** — for production secrets injection. Not needed
  for local dev (`.env` handles it). Sign up at
  [dashboard.doppler.com](https://dashboard.doppler.com) if you want Doppler to
  manage secrets in staging/prod.
- *(Optional)* A **Turso account** — only if you want a remote database for
  horizontal scaling. The default is a local SQLite file (zero setup). Create a
  database at [turso.tech](https://turso.tech) to get a `DATABASE_URL` and
  `TURSO_AUTH_TOKEN`.

### Step 1 — Get a clean copy of the template

Pick a **display name** for your product (e.g., "Acme Dashboard") and a **folder
name** (default: kebab-case of the display name, e.g., `acme-dashboard`).

Pull a **pure file copy** of the template — no git history, no `.git` at all —
straight from GitHub via your `gh` auth:

```bash
mkdir acme-dashboard
gh api repos/momentiq-ai/df-cerebe-template/tarball/main \
  | tar -xz --strip-components=1 -C acme-dashboard
cd acme-dashboard
```

`--strip-components=1` drops GitHub's wrapper directory. You can pin a tag or
commit SHA instead of `main`: `.../tarball/<ref>`. You'll turn this into your own
git repo during setup below (before the local gate can run).

### Step 2 — Name your product

```bash
bun run init -- --dry-run --name "Acme Dashboard"   # preview
bun run init -- --name "Acme Dashboard"             # apply (derives a slug)
```

Pure text substitution of the template's slug/display name across the tree — the
lightweight replacement for Copier's variable rendering. See the template's
[`docs/getting-started.md`](https://github.com/momentiq-ai/df-cerebe-template/blob/main/docs/getting-started.md) Step 0.

### Step 3 — Initialize git + install (this turns the gate on)

The tarball gave you a clean tree with **no `.git`**. Make it your own repo
first — Husky needs a git repo to arm the hooks — then install:

```bash
git init -b main
git add -A && git commit -m "chore: init from df-cerebe-template"
bun install
./node_modules/.bin/df --help        # confirm the Dark Factory CLI landed
```

`bun install` pulls every workspace **and** `@momentiq/dark-factory-cli` (pinned
exactly, per the consumer contract), then runs `prepare`, which arms the Husky
hooks (`core.hooksPath` -> `.husky/_`). The hooks were **dormant until now** — the
critic reviews from your **next commit onward** (so the initial commit above is
intentionally un-gated). Commit the resulting `bun.lock`.

### Step 4 — Configure your environment

```bash
cp .env.example .env
```

Open `.env` and set the values based on your needs:

**Required:**

| Variable | Value | Notes |
|---|---|---|
| `CEREBE_API_KEY` | `ck_live_...` or `ck_test_...` | Get one at [cerebe.ai](https://cerebe.ai). **Chat will not work without this.** |

**Database** (pick one):

| Setup | What to set | When to use |
|---|---|---|
| Local SQLite (default) | Leave `DATABASE_URL=file:./<slug>.db` as-is | Getting started, single-instance deploys |
| Remote Turso | `DATABASE_URL=libsql://your-db.turso.io` + `TURSO_AUTH_TOKEN=...` | Horizontal scaling, multi-replica prod |

**Auth — Clerk** (optional, graceful):

| Variable | Value | Notes |
|---|---|---|
| `CLERK_SECRET_KEY` | `sk_test_...` | Backend token verification |
| `VITE_CLERK_PUBLISHABLE_KEY` | `pk_test_...` | Frontend sign-in UI |

Leave **both** blank to run open (unauthenticated) — fine for local dev. Set
**both** (from [clerk.com](https://clerk.com) dashboard) to gate behind sign-in.
Recommended before exposing the dashboard to anyone outside your machine.

**Secrets — Doppler** (optional, prod only):

Doppler replaces `.env` in production by injecting secrets at runtime. Not needed
for local dev. If you want it:

```bash
doppler login
doppler setup --project acme-dashboard
doppler run -- bun run dev             # injects all vars, no .env needed
```

### Step 5 — Native dev (no Docker, no k8s)

```bash
bun run dev          # backend :8787 + frontend :5173, both hot-reload
```

Open <http://localhost:5173>. This is the whole inner loop — no containers, no
cluster, just native Bun.

**Dev server commands:**

| Command | What it does |
|---|---|
| `bun run dev` | Start both backend and frontend (hot-reload) |
| `bun run dev:backend` | Start only the backend on `:8787` |
| `bun run dev:frontend` | Start only the frontend on `:5173` |
| `Ctrl+C` | Stop all running servers |

Both servers hot-reload on file changes — no restart needed after editing code or
`.env`. `Ctrl+C` in the terminal where you ran `bun run dev` stops everything
cleanly (both processes are children of the Bun workspace runner).

> **Workspace `.env` wiring.** Bun loads `.env` from the CWD, and `bun run
> --filter '*' dev` runs each workspace from its own directory (`backend/`,
> `frontend/`). The template handles this: the backend's dev script passes
> `--env-file ../.env` so it inherits the root `.env`, and the Vite config sets
> `envDir: ".."` so the frontend does the same. If you add a new workspace that
> needs env vars, give it the same treatment — otherwise it won't see the root
> `.env`.

### Step 6 — First agent turn

The agent is **already implemented** — a LangGraph.js ReAct agent calling Cerebe,
streamed to the chat UI over SSE. If you set `CEREBE_API_KEY` in Step 4, **send a
message in the dashboard chat** — the reply streams in token by token. The agent
has two memory tools: `search_memories` (cross-session recall) and `share_memory`
(save facts for later). Background on the LangGraph shape is in the template's
[`docs/getting-started.md`](https://github.com/momentiq-ai/df-cerebe-template/blob/main/docs/getting-started.md) Step 3.
*(Prefer raw Anthropic instead? See the template's `docs/notes.md` §4.)*

### Step 7 — First commit hits the local Dark Factory gate

Authenticate at least one critic subscription (above), then:

```bash
# edit something
git add -A && git commit -m "feat: first change"
```

The `post-commit` hook fires `df review` in the background. After ~30-90s:

```bash
cat .git/agent-reviews/$(git rev-parse HEAD).md     # APPROVED / CHANGES_REQUESTED / BLOCKED
```

On `CHANGES_REQUESTED`, address findings in a **new commit** (never amend — the
artifact is bound to the original SHA). Then `git push`; the `pre-push` hook runs
`df gate-push` and lets an APPROVED HEAD through. This is the **same gate** the
Sage path uses — identical CLI, config shape, and evidence format.

### Step 8 — *(Opt-in)* hosted critic on pull requests

The local gate is standalone. To add a hosted **Check Run** on PRs, install the
**Dark Factory GitHub App** and the CI workflow per
[`CONSUMER-ADOPTION.md`](CONSUMER-ADOPTION.md) (§6+). This needs a reusable
workflow reference, cloud-critic API-key secrets, and a branch ruleset — so it's
opt-in, not shipped in the template. Add it before multi-author merges.

### Step 9 — *(Optional)* deploy

Everything container/k8s lives isolated in the template's `deploy/` with its own
guide — Docker images + a kustomize k8s base, reached only when you choose to
ship. Nothing there is needed for, or touched by, dev.

### What you have now

- A **lean TypeScript product** running natively, no infrastructure
- A **first agent call** through Cerebe, with cross-session memory
- A **first commit + push gated** by the Dark Factory local critic quorum, with
  evidence on disk
- An opt-in route to the **hosted critic** and to **deployment**, both isolated
  from your dev loop
- *(If configured)* **Auth** via Clerk, **secrets** via Doppler, and/or a
  **remote database** via Turso — all graceful-optional, all wired from the start

### Where to go next

- Template walkthrough + open decisions:
  [`df-cerebe-template/docs/getting-started.md`](https://github.com/momentiq-ai/df-cerebe-template/blob/main/docs/getting-started.md)
  and [`docs/notes.md`](https://github.com/momentiq-ai/df-cerebe-template/blob/main/docs/notes.md)
- Retrofit Dark Factory into an existing repo: [`CONSUMER-ADOPTION.md`](CONSUMER-ADOPTION.md)

---

## Sage full platform (Python + k8s)

> **The full Momentiq stack: Sage scaffold, Cerebe deep integration, k8s local
> cluster, Helm deploy, ArgoCD GitOps.** Use this path when you want the Python
> ecosystem, scale-out infrastructure, and the complete platform from day one.

### What you'll build

- A real product repository — FastAPI backend, Next.js 14 frontend, LangGraph agent runtime, Helm charts, the works
- A local Kubernetes cluster running it (k3d) with a dashboard at `http://<your-slug>.localhost:8082`
- A first agent chat turn answered by [Cerebe](https://cerebe.ai), Momentiq's cognitive engine
- A first commit reviewed by the Dark Factory critic quorum and gated by an evidence-bound artifact at `.git/agent-reviews/<sha>.md`
- A first push that fires the hosted W3 critic and posts a Check Run on your pull request

### Drive this with an AI agent (recommended)

Paste this into Claude Code, Cursor, or any agentic surface:

````
You are helping me start a new agentic AI product on the Momentiq platform.

The stack is three composable pieces:
  Sage   — the scaffold (a Copier template; shipped via @momentiq/sage-cli on npm)
  Cerebe — the cognitive engine (hybrid memory, knowledge graphs, LLM routing,
           PLRE meta-learning; consumed via the cerebe SDK)
  Dark Factory — the autonomous software development lifecycle (multi-vendor
           critic quorum on every commit, evidence-bound gates, hosted critic
           on every pull request)

Walk me through these steps interactively. Show the command, ask me to confirm
anything destructive or that writes outside the current directory, run it,
verify the expected outcome, then move on. If anything fails, diagnose with
`make df-doctor` or `npx df doctor` and propose a fix.

1. Prereq check. Verify on PATH: node (>=20), python (>=3.11), pipx, copier,
   docker, k3d, doppler, gh, git. For anything missing, give the install
   one-liner for my operating system (macOS via brew, Linux via apt/dnf,
   Windows via winget).

2. Scaffold with Sage. Ask me for: product name, primary persona, optional
   secondary persona, production domain. Default the slug to a kebab-case
   slugified product name. Run:
     npx @momentiq/sage-cli init <slug> \
       --product-name "<name>" \
       --primary-persona <persona> \
       --domain <domain>
   When the command finishes, cd into <slug>.

3. Local cluster up. Run:
     doppler login
     doppler setup --project <slug>
     make k8s-up
     make k8s-build-deploy-smart
   Tail the deploy until the dashboard URL is live, then surface it to me
   (default: http://<slug>.localhost:8082).

4. Cerebe + first agent call. If I do not already have a Cerebe API key,
   open https://cerebe.ai in my browser so I can grab one. Then:
     doppler secrets set CEREBE_API_KEY=<key> --project <slug> --config dev
     make k8s-build-deploy-smart  # restart pods so the key is picked up
   Open the dashboard URL and have me send a chat message. Confirm the
   agent's response includes a tool call to Cerebe (visible in the trace).

5. Dark Factory gate. Make a trivial change (e.g., update the product
   description in README.md), then:
     git add -A && git commit -m "feat: first content tweak"
   The post-commit hook will fire `df review` in the background. Wait for
   it to finish, then:
     make df-show COMMIT=HEAD
   Confirm the verdict is APPROVED. If it is CHANGES_REQUESTED, walk me
   through addressing the findings in a new commit (never amend; the
   artifact is bound to the original SHA).

6. Push. Run:
     git push
   The pre-push gate validates locally first. After push, surface the
   hosted W3 Check Run URL on the pull request (use `gh pr view` to find
   it). Confirm both gates agree.

References:
  - Walkthrough: https://github.com/momentiq-ai/dark-factory/blob/main/docs/getting-started.md
  - Existing-repo retrofit: https://github.com/momentiq-ai/dark-factory/blob/main/docs/CONSUMER-ADOPTION.md
  - Sage CLI README: https://github.com/momentiq-ai/dark-factory/blob/main/packages/sage-cli/README.md
  - Dark Factory CLI README: https://github.com/momentiq-ai/dark-factory/blob/main/packages/cli/README.md

Start at step 1. Ask for confirmation before each shell command.
````

**Paste it where you already work:**

- **Claude Code:** copy the block, paste into the prompt, hit Enter
- **Cursor:** copy, open Composer (⌘I), paste, send
- **Codex CLI:** `codex` → paste at the prompt → Enter
- **claude.ai:** start a new chat, paste, send

The agent drives steps 1-6; you confirm and answer the four scaffold prompts.

### ...or follow the steps manually

### Prereqs

| Tool | Version | Why | macOS one-liner |
|---|---|---|---|
| [Node.js](https://nodejs.org) | >= 20 | Runs the Sage CLI, the Dark Factory CLI, and the scaffolded frontend | `brew install node` |
| [Python](https://www.python.org) | >= 3.11 | Runs `copier` (the templating engine the Sage CLI wraps) | `brew install python@3.11` |
| [pipx](https://pipx.pypa.io) | latest | Installs `copier` in an isolated env | `brew install pipx && pipx ensurepath` |
| [Copier](https://copier.readthedocs.io) | latest | Renders the bundled Sage template | `pipx install copier` |
| [Docker Desktop](https://www.docker.com/products/docker-desktop) | latest | Hosts the local k3d cluster (allocate >= 8GB RAM) | `brew install --cask docker` |
| [k3d](https://k3d.io) | latest | Lightweight Kubernetes for the local loop | `brew install k3d` |
| [Doppler CLI](https://docs.doppler.com/docs/cli) | latest | Secrets injection at runtime | `brew install dopplerhq/cli/doppler` |
| [gh CLI](https://cli.github.com) | latest | Talks to GitHub for the hosted gate's pull request and Check Run surfaces | `brew install gh && gh auth login` |
| Git | >= 2.40 | Source control + pre-push hook surface | (preinstalled) |

You also need:
- A **Doppler account** (free) — sign up at [dashboard.doppler.com](https://dashboard.doppler.com)
- A **Cerebe API key** — sign up at [cerebe.ai](https://cerebe.ai); free trial tier works
- A **GitHub account** with permission to push to a fresh repository under your user or organization

Total install time on a fresh macOS workstation: 10-20 minutes.

### Step 1 — Scaffold with Sage (~5 min)

The Sage CLI is one npm command that bundles the Sage template inside the published package. No GitHub access needed.

```bash
npx @momentiq/sage-cli init my-product \
  --product-name "My Product" \
  --primary-persona employer \
  --domain my-product.example
```

Four interactive prompts will fill in what you skipped on the command line:

1. **Product name** — display name (e.g., `My Product`)
2. **Primary persona** — primary user role (e.g., `employer`)
3. **Secondary persona** — optional second role (leave blank to skip)
4. **Production domain** — production hostname (e.g., `my-product.example`)

Everything else (Doppler project, GCP project, Temporal namespace, ArgoCD domain, k3d ports, etc.) is pre-filled from sensible defaults derived from your slug.

When the scaffold finishes, you have a full product tree:

```
my-product/
├── backend/                # FastAPI + LangGraph agent runtime
├── web/                    # Next.js 14 + assistant-ui chat surface
├── deploy/                 # Helm charts for k3d + GKE
├── .agent-review/          # Dark Factory critic config
├── .husky/                 # Pre-push + post-commit hooks
├── .mcp.json               # Model Context Protocol surface for agents
├── .claude/                # Claude Code project context
├── AGENTS.md, CLAUDE.md, GEMINI.md, .cursor/rules, .copilot/  # IDE-agent context
├── docs/                   # roadmap, cycles, ADRs, runbooks scaffolded
├── package.json            # @momentiq/dark-factory-cli pinned as devDep
├── pyproject.toml          # cerebe SDK pre-installed
└── Makefile                # quality-gates, k8s targets, df-doctor, df-stats
```

Now cd into the product:

```bash
cd my-product
```

### Step 2 — Start the local cluster (~2 min)

#### Doppler

```bash
doppler login                            # browser login if not already
doppler setup --project my-product       # bind this directory to your Doppler project
make doppler-seed-defaults               # seeds DATABASE_URL, REDIS_URL, CEREBE_API_URL, etc.
```

#### k3d cluster + deploy

```bash
make k8s-up                              # creates the k3d cluster (~30s)
make k8s-build-deploy-smart              # builds images + helms in (~90s on first run)
```

Once both finish, your dashboard is live:

```bash
open http://my-product.localhost:8082
```

You should see the Next.js shell with the persona-aware navigation and the `assistant-ui` chat surface. The chat will say something like "Cerebe API key not configured" — that's Step 3.

### Step 3 — Wire Cerebe + first agent call (~5 min)

The Cerebe SDK is already in `pyproject.toml` (Python) and `package.json` (TypeScript). The agent runtime imports it. All that's missing is the key.

```bash
doppler secrets set CEREBE_API_KEY=ck_xxxxxxxxxxxxxxxxxxxx \
  --project my-product --config dev
make k8s-build-deploy-smart              # restart pods so the key is picked up
```

In the dashboard at `http://my-product.localhost:8082`, send a chat message.
You should see the agent respond; inspect the trace and you'll see a
`cerebe.chat.completion` span.

### Step 4 — First commit hits the local Dark Factory gate (~5 min)

Make a trivial change, commit:

```bash
git add README.md
git commit -m "feat(readme): tighten the product description"
```

The post-commit hook fires `df review` in the background. About 30-90 seconds
later the artifact lands:

```bash
make df-show COMMIT=HEAD
# or:
cat .git/agent-reviews/$(git rev-parse HEAD).md
```

The verdict will be `APPROVED`, `CHANGES_REQUESTED`, or `BLOCKED`. On
`CHANGES_REQUESTED`, address findings in a **new commit** — never amend, because
the artifact is bound to the original SHA.

### Step 5 — Push + hosted critic Check Run (~3 min)

```bash
gh repo create my-product --private --source=. --remote=origin --push
```

The pre-push hook runs `df gate-push` against your local artifact; if APPROVED,
the push goes through. Then open a pull request on a feature branch:

```bash
git checkout -b feat/another-tweak
# edit something
git add -A && git commit -m "feat: another tweak"
git push -u origin feat/another-tweak
gh pr create --fill
```

Install the [Dark Factory GitHub App](https://github.com/apps/momentiq-dark-factory)
on the repo. The webhook fires the hosted W3 critic; about 1-3 minutes later the
Check Run posts on the pull request with the aggregated verdict and inline
annotations.

### What you have now

- A **scaffolded product** with backend, frontend, agent runtime, telemetry, authentication, and secrets all wired
- A **running local cluster** at `http://my-product.localhost:8082`
- A **first agent call** end-to-end through Cerebe
- A **first commit gated** by the local critic quorum, with an evidence-bound artifact on disk
- A **first push gated** by the hosted critic quorum, with a Check Run on your pull request
- An **audit trail** at `.git/agent-reviews/_runs.ndjson` (local) and in the Dark Factory hosted runtime (cloud)
- A **forward-compatibility path** via `sage update`

---

## Common to both paths

### Retrofit Dark Factory into an existing repo

Already have a codebase? See [`CONSUMER-ADOPTION.md`](CONSUMER-ADOPTION.md).

### Deep dives

- [Sage CLI reference](https://github.com/momentiq-ai/dark-factory/blob/main/packages/sage-cli/README.md) — full flag surface, `sage update`, template variable list
- [Dark Factory CLI reference](https://github.com/momentiq-ai/dark-factory/blob/main/packages/cli/README.md) — `df review`, `df doctor`, `df mcp`, structured bypass
- [Cerebe SDK documentation](https://cerebe.ai/docs) — memory primitives, LLM routing, knowledge graphs, PLRE meta-learning

### Hosted Dark Factory runtime

Momentiq operates the hosted Dark Factory runtime — the W3 GitHub App `momentiq-dark-factory`, the aggregation read-model, and the BYOK key vault. [Get in touch](https://momentiq.ai/contact?topic=enterprise) to onboard your repos.

### Filing issues + asking questions

- [`momentiq-ai/dark-factory`](https://github.com/momentiq-ai/dark-factory/issues) — Dark Factory CLI, Sage CLI, reusable workflows, hosted critic
- Cerebe — file via the dashboard at [cerebe.ai](https://cerebe.ai), or contact [support@momentiq.ai](mailto:support@momentiq.ai)
