import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Reusable Playwright config for the Evidence-Gated Validation **playwright
 * (UI) route producer** (momentiq-ai/dark-factory#193). Generalized from the
 * dark-factory-dashboard dogfood (Cycle 21 PR-4; ADR 2026-06).
 *
 * Kept SEPARATE from your broad e2e config so the route producer is a single,
 * fast, deterministic capture:
 *   - one chromium project, the producer spec only.
 *   - no retries (a flaky retry could mask a genuinely-failing UI surface).
 *   - an OPTIONAL authenticated storage-state (public surfaces need none).
 *   - an OPTIONAL local preview `webServer` (the SHA under review) for the
 *     no-auth dogfood path; set `PLAYWRIGHT_TEST_BASE_URL` to point at a
 *     deployed preview of the SHA instead.
 *
 * This config is invoked by `playwright-route.sh`, which is the route's
 * `command` in `.agent-review/config.json`.
 *
 * ── CONSUMER REFERENCE FILE — copy into your repo (next to the producer spec)
 *    and OWN it. Adjust `testDir`, the `webServer.command`, and the env knobs
 *    to your repo's layout. `df skills install verify` does NOT overwrite it.
 *
 * NEVER set a routine pre-push bypass to get around a failing producer — a
 * failing/absent capture MUST block the route (that is the feature).
 */

// Auth is OPTIONAL and consumer-supplied. Mint an authenticated Playwright
// storageState JSON with YOUR auth (Clerk/Auth0/bot login/etc.) and point
// DF_UI_ROUTE_STORAGE_STATE at it for protected surfaces. Public surfaces need
// none — when the file is absent we run unauthenticated rather than fail.
// Default location: <config-dir>/.auth/storage-state.json (gitignore **/.auth/).
const STORAGE_STATE_PATH =
  process.env.DF_UI_ROUTE_STORAGE_STATE ||
  resolve(__dirname, ".auth/storage-state.json");
const storageState = existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined;

// Local preview port for the SHA-under-review server. Overridable via
// DF_UI_ROUTE_PORT to avoid collisions with other local services.
const PREVIEW_PORT = process.env.DF_UI_ROUTE_PORT || "3217";
const BASE_URL =
  process.env.PLAYWRIGHT_TEST_BASE_URL?.replace(/\/$/, "") ||
  `http://localhost:${PREVIEW_PORT}`;

// Only stand up the local preview server when we are NOT pointed at a remote
// deployed surface. (A remote base URL means the SHA is already served.)
const usingLocalPreview =
  !process.env.PLAYWRIGHT_TEST_BASE_URL ||
  /^https?:\/\/localhost(:|\/|$)/.test(process.env.PLAYWRIGHT_TEST_BASE_URL);

// The command that serves the SHA under review for the local-preview path.
// Default `npm run dev`; override via DF_UI_ROUTE_DEV_CMD for your stack.
const DEV_CMD = process.env.DF_UI_ROUTE_DEV_CMD || "npm run dev";

export default defineConfig({
  testDir: "./tests/e2e",
  // Only the route producer — not your broad e2e suite.
  testMatch: /ui-route\.producer\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // The producer must be deterministic; no flaky retries that could mask a
  // genuinely-failing UI surface behind a lucky re-run.
  retries: 0,
  workers: 1,
  timeout: 90 * 1000,
  expect: { timeout: 15 * 1000 },
  reporter: [["list"]],

  use: {
    baseURL: BASE_URL,
    // Authenticate ONLY when a storage-state file is present (protected
    // surfaces). Public surfaces ignore it.
    ...(storageState ? { storageState } : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ignoreHTTPSErrors: true,
    actionTimeout: 15 * 1000,
    navigationTimeout: 30 * 1000,
  },

  projects: [
    {
      name: "ui-route-producer",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: usingLocalPreview
    ? {
        // Serve the SHA under review. Set the port via the PORT env var (the
        // common convention); adjust DEV_CMD if your dev server differs.
        command: DEV_CMD,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
        env: {
          PORT: PREVIEW_PORT,
        },
      }
    : undefined,
});
