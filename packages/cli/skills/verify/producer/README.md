# Reusable Playwright (UI) verification-route producer

These are **reference files** for the Dark Factory `playwright` verification
route — the UI-layer half of evidence-gated validation (`web/**` / `*.tsx`
changes). They ship inside `@momentiq/dark-factory-cli` (so `df skills install
verify` and the consumer guide can point you at them), but unlike a rendered
skill they are **copy-once-and-own**: you adapt `SURFACES[]` and your auth to
your app, and a future `df skills install verify` will **not** overwrite them.

Generalized from the proven `dark-factory-dashboard` dogfood producer (Cycle 21
EC2/EC8). The Clerk/Doppler auth coupling has been removed — auth is now an
optional, consumer-supplied Playwright **storage-state**.

## Files

| File | Role | You edit? |
|---|---|---|
| `playwright-route.sh` | Route `command`: SHA + clean-tree guards, computes changed UI paths, runs Playwright, maps the 0/1/2 exit. | Env knobs only |
| `playwright.ui-route.config.ts` | Dedicated Playwright config: one chromium project, optional storage-state, optional local-preview server. | `testDir` / dev command |
| `ui-route.producer.spec.ts` | The capture: ARIA snapshot + after (+ optional before) screenshots, fail-closed coverage, optional VLM hook. | **`SURFACES[]`** (required) |
| `coverage.ts` | Pure fail-closed coverage logic (a changed UI path with no surface blocks). Unit-tested upstream. | No |

## Setup (one-time)

1. **Copy** the four files into your repo. Convention: the script under
   `scripts/verify/`, and `playwright.ui-route.config.ts` + `tests/e2e/
   ui-route.producer.spec.ts` + `tests/e2e/coverage.ts` under your web app dir
   (`web/` by default). Adjust `DF_UI_ROUTE_WEB_DIR` / `DF_UI_ROUTE_CONFIG` (see
   the script header) if your layout differs.
2. **Edit `SURFACES[]`** in `ui-route.producer.spec.ts` — your routes, each with
   a structural `requiredHeading` (an accessible-name regex) and the `covers`
   source globs it is the evidence for. v1 ships one public `/` surface so it
   works zero-auth out of the box.
3. **(Protected surfaces only)** Mint an authenticated Playwright `storageState`
   JSON with your own auth and point `DF_UI_ROUTE_STORAGE_STATE` at it. Public
   surfaces need none. Gitignore your storage-state (`**/.auth/`).
4. **Arm the route** in `.agent-review/config.json` — override the `playwright`
   route's placeholder `command` with `bash scripts/verify/playwright-route.sh`:

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

5. **Produce evidence**: `df verify --route playwright` (or it runs automatically
   when `df verify` / `df gate-push` arm the route for a `web/**` / `*.tsx`
   change). See `docs/guides/ui-verification-route.md` for the full walkthrough.

## Environment knobs

| Var | Default | Purpose |
|---|---|---|
| `DF_UI_ROUTE_WEB_DIR` | `web` | Where your app + `@playwright/test` live. |
| `DF_UI_ROUTE_CONFIG` | `playwright.ui-route.config.ts` | Producer config, relative to the web dir. |
| `DF_UI_ROUTE_STORAGE_STATE` | _(unset)_ | Path to an authenticated storage-state (protected surfaces). |
| `PLAYWRIGHT_TEST_BASE_URL` | local preview | Point at a deployed preview of the SHA instead of serving locally. |
| `DF_UI_ROUTE_DEV_CMD` | `npm run dev` | Local-preview server command. |
| `DF_UI_ROUTE_PORT` | `3217` | Local-preview port. |
| `DF_UI_ROUTE_BEFORE_BASE_URL` | _(unset)_ | Origin for the optional before/after baseline. |
| `DF_UI_ROUTE_VLM` | _(unset)_ | `1` arms the optional VLM hook (deferred/no-op in v1). |

## What this is NOT

It does not mint your auth session and it does not guarantee that gitignored
content absent from the commit cannot influence a capture (the v1 trust-boundary
limitation — content-isolated re-execution is the v2 fix). It validates the
**HEAD** working tree; producing evidence for a non-HEAD SHA fails closed.
