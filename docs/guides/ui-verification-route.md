# UI Verification Route (`web/**` / `*.tsx` → playwright)

The `playwright` verification route is the **UI-layer** half of Dark Factory's
evidence-gated validation. A change touching `web/**` or any `*.tsx` arms it, and
the local pre-push gate (`df gate-push`) blocks the push until the route produces
passing, SHA-bound **UI evidence**. This guide is for **consumer repos** adopting
the reusable producer that ships with `@momentiq/dark-factory-cli` (graduated
from the `dark-factory-dashboard` dogfood in `dark-factory#193`).

> Prerequisite: the `df verify` subcommand (`@momentiq/dark-factory-cli` ≥ 2.6.0)
> and an armed verification-route config. See `CONSUMER-ADOPTION.md` §5.6.

## What it produces

For every UI surface the change arms, the producer captures the required floor of
the SOTA UI-grounding triad:

1. an **ARIA snapshot** (the accessibility tree — a structural, tamper-resistant
   assertion that the surface renders its expected roles/landmarks) — **always
   produced**, and
2. an **after screenshot** at the SHA under review — **always produced**; plus an
   optional **before screenshot** baseline that completes the before/after pair
   **only when `DF_UI_ROUTE_BEFORE_BASE_URL` is set**. A missing baseline never
   fails the route.

The optional **independent VLM check** (the triad's third leg) is **deferred in
v1**: the ARIA + after capture is the required floor; the VLM leg is additive
corroboration gated behind a provider/cost decision. The hook
(`runOptionalVlmCheck` in the producer spec) is a no-op unless `DF_UI_ROUTE_VLM=1`
and a provider is wired, and it can only *add* a finding, never relax the floor.

Evidence lands under `agent-reviews/quality-gates/ui/<sha>/<surface-slug>/`
(`aria.snapshot.txt`, `after.png`, optional `before.png`, `meta.json`). The
route's PASS/FAIL — the producer's exit code captured into the per-SHA
`QualityGateEvidence` — is what `df gate-push` gates on.

## Setup

1. **Install the skill** for the orchestration doctrine:

   ```bash
   df skills install verify
   ```

2. **Copy the reusable producer** reference files out of the installed CLI
   package (`node_modules/@momentiq/dark-factory-cli/skills/verify/producer/`)
   into your repo. Convention:

   | Reference file | Copy to |
   |---|---|
   | `playwright-route.sh` | `scripts/verify/playwright-route.sh` |
   | `playwright.ui-route.config.ts` | `web/playwright.ui-route.config.ts` |
   | `ui-route.producer.spec.ts` | `web/tests/e2e/ui-route.producer.spec.ts` |
   | `coverage.ts` | `web/tests/e2e/coverage.ts` |

   These are **yours to own** — `df skills install verify` never overwrites them.
   Adjust `DF_UI_ROUTE_WEB_DIR` / `DF_UI_ROUTE_CONFIG` (see the script header) if
   your layout differs from `web/`.

3. **Edit `SURFACES[]`** in `ui-route.producer.spec.ts` — your routes, each with a
   structural `requiredHeading` (an accessible-name regex) and the `covers`
   source globs it is the evidence for. v1 ships one public `/` surface so the
   route works zero-auth out of the box.

4. **(Protected surfaces only) Wire auth as a storage-state.** Mint an
   authenticated Playwright `storageState` JSON with **your** auth (Clerk, Auth0,
   a bot login, a long-lived test cookie) and point `DF_UI_ROUTE_STORAGE_STATE`
   at it. Public surfaces need none. Gitignore your storage-state (`**/.auth/`).
   The producer is **not** coupled to any auth vendor — it only consumes the
   storage-state.

5. **Arm the route** — override the `playwright` route's placeholder `command` in
   `.agent-review/config.json`:

   ```jsonc
   {
     "id": "playwright",
     "trigger": ["web/**", "**/*.tsx"],
     "command": "bash scripts/verify/playwright-route.sh",
     "evidencePath": "agent-reviews/quality-gates/${sha}.json",
     "category": "ui",
     "evidenceKind": "playwright"
   }
   ```

6. **Produce evidence**:

   ```bash
   df verify --route playwright      # or `df verify` for every armed route
   ```

## The guards (why this is a real gate, not a screenshot toy)

- **Fail-closed coverage.** A `web/**`/`*.tsx` change arms the route, but the
  producer maps each *changed* UI path to a capture surface; a changed
  product-UI path with **no mapped surface blocks the route** — it cannot be
  satisfied by rendering an unaffected surface. Add a surface (`SURFACES[]`) for
  the changed area; do **not** widen `NON_SURFACE_GLOBS` to hide it. A change
  that touches **only** harness/non-UI files smoke-captures ALL surfaces, so the
  route can never pass with zero evidence.
- **Floor assertion.** Each surface must render its `requiredHeading` (a
  role-based, copy-stable assertion). An over-claimed "the UI works" that doesn't
  expose the heading **fails** the route.
- **SHA + clean-tree binding.** The producer screenshots the **working tree**,
  but evidence binds to the committed SHA. It validates **HEAD only** and
  **fails closed** if any guarded file is dirty/untracked — both the UI surface
  (`web/**` / `*.tsx`) and the route machinery (the producer script + the route
  config). Commit or stash before producing evidence.

## Exit-code contract

- **0** — green: evidence captured, the routed surfaces rendered + asserted.
- **1** — block: a surface failed to render/assert, or a real producer error / a
  dirty guarded file. Fail closed — **fix it, do not bypass.**
- **2** — soft-skip: the producer can't run here (Playwright not installed, or a
  configured storage-state is absent). Recorded as `requiresHumanJudgment`, NOT a
  pass. Install the tool (or provide the storage-state) and re-commit.

## Known limitations (v1)

- **HEAD-only.** The producer attests the checked-out tree; producing evidence
  for a non-HEAD SHA fails closed.
- **Trust boundary.** A producer is an arbitrary command and can read gitignored
  content absent from the commit (the v1 guard does not refuse on gitignored
  untracked files — otherwise `node_modules` would block every routed commit).
  The complete fix is **content-isolated re-execution** (running the producer
  against a materialized checkout of the gated SHA) — the v2 "grader unmounted
  from the agent" item. Until then this is an acknowledged limitation, not a
  waiver.
- **VLM check deferred** (see above).
