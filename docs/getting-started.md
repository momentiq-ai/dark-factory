# Get started — build a production agentic AI product in an afternoon

> **Scaffold with Sage → implement on Cerebe → ship through Dark Factory.**
> Competitors sell pieces. Momentiq sells the closed loop, pre-wired on day one.

This walkthrough takes you from zero to a scaffolded, running, gate-protected agentic AI product. About **25 minutes of wall-clock time**, most of it Docker pulling images.

## What you'll build

By the end of this guide you have:

- A real product repository — FastAPI backend, Next.js 14 frontend, LangGraph agent runtime, Helm charts, the works
- A local Kubernetes cluster running it (k3d) with a dashboard at `http://<your-slug>.localhost:8082`
- A first agent chat turn answered by [Cerebe](https://cerebe.ai), Momentiq's cognitive engine
- A first commit reviewed by the Dark Factory critic quorum and gated by an evidence-bound artifact at `.git/agent-reviews/<sha>.md`
- A first push that fires the hosted W3 critic and posts a Check Run on your pull request

No vendor stitching. No "we'll add the gate later." The composition is the product.

## Drive this with an AI agent (recommended)

Paste this prompt into [Claude Code](https://claude.com/claude-code), Cursor, the Codex command-line interface (CLI), or [claude.ai](https://claude.ai) — whichever agentic surface you're already using — and the agent will run the whole walkthrough interactively. Asks before destructive actions, diagnoses failures with `make df-doctor`, surfaces URLs.

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

The agent drives steps 1–6; you confirm and answer the four scaffold prompts.

## …or follow the steps manually

The rest of this page is the same walkthrough as text, in case you'd rather drive it yourself.

## Prereqs (one screen)

| Tool | Version | Why | macOS one-liner |
|---|---|---|---|
| [Node.js](https://nodejs.org) | ≥ 20 | Runs the Sage CLI, the Dark Factory CLI, and the scaffolded frontend | `brew install node` |
| [Python](https://www.python.org) | ≥ 3.11 | Runs `copier` (the templating engine the Sage CLI wraps) | `brew install python@3.11` |
| [pipx](https://pipx.pypa.io) | latest | Installs `copier` in an isolated env | `brew install pipx && pipx ensurepath` |
| [Copier](https://copier.readthedocs.io) | latest | Renders the bundled Sage template | `pipx install copier` |
| [Docker Desktop](https://www.docker.com/products/docker-desktop) | latest | Hosts the local k3d cluster (allocate ≥ 8GB RAM) | `brew install --cask docker` |
| [k3d](https://k3d.io) | latest | Lightweight Kubernetes for the local loop | `brew install k3d` |
| [Doppler CLI](https://docs.doppler.com/docs/cli) | latest | Secrets injection at runtime | `brew install dopplerhq/cli/doppler` |
| [gh CLI](https://cli.github.com) | latest | Talks to GitHub for the hosted gate's pull request and Check Run surfaces | `brew install gh && gh auth login` |
| Git | ≥ 2.40 | Source control + pre-push hook surface | (preinstalled) |

You also need:
- A **Doppler account** (free) — sign up at [dashboard.doppler.com](https://dashboard.doppler.com)
- A **Cerebe API key** — sign up at [cerebe.ai](https://cerebe.ai); free trial tier works
- A **GitHub account** with permission to push to a fresh repository under your user or organization

Total install time on a fresh macOS workstation: 10–20 minutes.

## Step 1 — Scaffold with Sage (~5 min)

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

Everything else (Doppler project, Google Cloud Platform (GCP) project, Temporal namespace, ArgoCD domain, k3d ports, etc.) is pre-filled from sensible defaults derived from your slug. The CLI hands those off to Copier with `--defaults`, so you do **not** see the other ~15 advanced prompts unless you opt in.

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

Confirm by checking the CLI's banner:

```bash
sage --version
# @momentiq/sage-cli 0.1.0 (bundled sage-blueprint@<commit> via ref <tag>)
```

Now cd into the product:

```bash
cd my-product
```

## Step 2 — Start the local cluster (~2 min)

Two parts: Doppler secrets bootstrap, then k3d cluster up + deploy.

### Doppler

```bash
doppler login                            # browser login if not already
doppler setup --project my-product       # bind this directory to your Doppler project
```

The scaffolded `Makefile` will seed Doppler with the in-cluster service DNS names so the backend can find its dependencies:

```bash
make doppler-seed-defaults
```

This populates `DATABASE_URL`, `REDIS_URL`, `CEREBE_API_URL`, `CEREBE_BASE_URL` for the `dev` config. You'll add the Cerebe API key itself in Step 3.

### k3d cluster + deploy

```bash
make k8s-up                              # creates the k3d cluster (~30s)
make k8s-build-deploy-smart              # builds images + helms in (~90s on first run)
```

Once both finish, your dashboard is live:

```bash
open http://my-product.localhost:8082
```

(Substitute your slug for `my-product` if you picked a different one. The k3d port routing is configured at scaffold time.)

You should see the Next.js shell with the persona-aware navigation and the `assistant-ui` chat surface. The chat will say something like "Cerebe API key not configured" — that's Step 3.

## Step 3 — Wire Cerebe + first agent call (~5 min)

The Cerebe SDK is already in `pyproject.toml` (Python) and `package.json` (TypeScript). The agent runtime imports it. All that's missing is the key.

### Grab a key

If you don't already have one, open [cerebe.ai](https://cerebe.ai) → sign up → grab a development key from the dashboard. Free tier is fine for the walkthrough.

### Put it in Doppler

```bash
doppler secrets set CEREBE_API_KEY=ck_xxxxxxxxxxxxxxxxxxxx \
  --project my-product --config dev
```

### Restart so pods pick up the new secret

```bash
make k8s-build-deploy-smart
```

(Doppler injects secrets at runtime, but k3d pods need to restart to re-read them. The `smart` target only rebuilds what changed; this run is fast.)

### Send the first chat message

In the dashboard at `http://my-product.localhost:8082`, click into the chat surface and send a message:

> Tell me one fact about the Pacific Ocean.

You should see the agent respond. Inspect the trace (the deep-link icon next to the message in the dashboard) and you'll see a `cerebe.chat.completion` span — that's your scaffolded product calling Cerebe end to end.

If the response says "Cerebe API key not configured" or similar:

```bash
make df-doctor                            # walks the configuration
doppler secrets get CEREBE_API_KEY --plain --project my-product --config dev
kubectl logs -n my-product deployment/my-product-backend --tail=50
```

`df doctor` covers the common Doppler + k3d misconfigurations and surfaces the exact fix.

## Step 4 — First commit hits the local Dark Factory gate (~5 min)

The repository is already a git repository (Sage initializes it at scaffold time). The Husky hooks are installed. The `.agent-review/config.json` is in place. All you need is a change.

### Make a trivial change

Open `README.md`, edit the product description (whatever you want), save.

### Commit

```bash
git add README.md
git commit -m "feat(readme): tighten the product description"
```

The pre-commit hook flips `gc.auto=0` on the shared `.git/config` (the parallel-prune race fix) and runs the per-service type-check if you touched any service code. Then the commit lands and the post-commit hook fires `df review` in the background.

### Wait for the verdict

`df review` runs your local critic quorum — two critics, Cursor and Codex, both authenticated through your subscription sessions. About 30–90 seconds depending on the diff.

When it finishes, the artifact lands at `.git/agent-reviews/<sha>.md` (and a structured `.json` sibling). Read it:

```bash
make df-show COMMIT=HEAD
# or, if you prefer the structured artifact:
cat .git/agent-reviews/$(git rev-parse HEAD).md
```

The verdict will be `APPROVED` (a trivial doc change), `CHANGES_REQUESTED` (the critics flagged something), or `BLOCKED` (a structural issue with the diff). The artifact lists each critic's findings inline.

### If APPROVED

You're ready to push.

### If CHANGES_REQUESTED

Read the findings. Address them in a **new commit** — never amend, because the artifact is bound to the original commit hash and the diff hash. When you address the finding and commit, the post-commit hook reruns `df review` against the new commit; if the critics agree the finding is closed, the new artifact lands `APPROVED`.

### If you're blocked by a vendor outage or an unverifiable check

Dark Factory has two structured carve-outs documented in [`CONSUMER-ADOPTION.md`](CONSUMER-ADOPTION.md#cloud-env-exception): the cloud-environment bypass (for devcontainer / sandbox flows where the subscription critics cannot reach a browser) and the critic-unverifiable-check bypass (for findings the critic itself flags as outside its sandbox). Both are loud and audited — the bypass record lands in `.git/agent-reviews/_runs.ndjson` and surfaces in `make df-stats`. Every other bypass is an escalation.

## Step 5 — Push → hosted Dark Factory gate posts a Check Run (~3 min)

### Create a GitHub repository for your scaffold

Easiest path:

```bash
gh repo create my-product --private --source=. --remote=origin --push
```

That creates the GitHub repository, adds it as `origin`, and pushes `main`. The pre-push hook runs `df gate-push` against your local artifact; if the local verdict is APPROVED, the push goes through.

### Install the Dark Factory GitHub App

Visit [github.com/apps/momentiq-dark-factory](https://github.com/apps/momentiq-dark-factory) → install on the new repository.

### Open a pull request to fire the hosted critic

Make another small change on a feature branch and open a pull request:

```bash
git checkout -b feat/another-tweak
# edit something
git add -A && git commit -m "feat: another tweak"
git push -u origin feat/another-tweak
gh pr create --fill
```

When the pull request opens, the webhook fires the hosted W3 critic. About 1–3 minutes later the Check Run posts on the pull request:

- **`dark-factory/critic`** — the aggregated verdict, listing per-critic outcomes (Cursor, Codex, Gemini, Grok in the cloud profile)
- **Inline annotations** — each critic posts its findings as pull-request review comments at the exact line

Both gates agree on the diff because they consume the same binary (`@momentiq/dark-factory-cli`) pinned to the same version. The local profile is two critics with subscription auth (cheap, fast); the cloud profile is four critics with vendor application programming interface (API) keys (slower, more authoritative). The verdict shape is identical.

## What you have now

In roughly twenty-five minutes, with zero vendor stitching:

- A **scaffolded product** with backend, frontend, agent runtime, telemetry, authentication, and secrets all wired
- A **running local cluster** at `http://my-product.localhost:8082`
- A **first agent call** end-to-end through Cerebe
- A **first commit gated** by the local critic quorum, with an evidence-bound artifact on disk
- A **first push gated** by the hosted critic quorum, with a Check Run on your pull request
- An **audit trail** at `.git/agent-reviews/_runs.ndjson` (local) and in the Dark Factory hosted runtime (cloud) of every verdict and every bypass
- A **forward-compatibility path** via `sage update` — when the Sage template advances, pull the change into this product with one command

The composition is the moat. You're not stitching three vendors together; you're shipping a product on a platform that pre-wired the integrations on day one.

## Where to go next

### Day-2 operations

- [`CONSUMER-ADOPTION.md`](CONSUMER-ADOPTION.md) — retrofitting Dark Factory into an existing repository (use this if you have one already)
- The scaffold's own `docs/runbooks/` — operational runbooks land at scaffold time for the local critic, the deploy loop, and the cloud-env cooperation pattern

### Deep dives

- [Sage CLI reference](https://github.com/momentiq-ai/dark-factory/blob/main/packages/sage-cli/README.md) — full flag surface, `sage update`, template variable list
- [Dark Factory CLI reference](https://github.com/momentiq-ai/dark-factory/blob/main/packages/cli/README.md) — `df review`, `df doctor`, `df mcp`, structured bypass
- [Cerebe SDK documentation](https://cerebe.ai/docs) — memory primitives, LLM routing, knowledge graphs, PLRE meta-learning

### Hosted Dark Factory runtime

Momentiq operates the hosted Dark Factory runtime — the W3 GitHub App `momentiq-dark-factory`, the aggregation read-model, and the BYOK key vault. [Get in touch](https://momentiq.ai/contact?topic=enterprise) to onboard your repos.

### Filing issues + asking questions

- [`momentiq-ai/dark-factory`](https://github.com/momentiq-ai/dark-factory/issues) — Dark Factory CLI, Sage CLI, reusable workflows, hosted critic
- Cerebe — file via the dashboard at [cerebe.ai](https://cerebe.ai), or contact [support@momentiq.ai](mailto:support@momentiq.ai)
- Sage template — surface bugs via the [`momentiq-ai/dark-factory` issues](https://github.com/momentiq-ai/dark-factory/issues) and we'll route
