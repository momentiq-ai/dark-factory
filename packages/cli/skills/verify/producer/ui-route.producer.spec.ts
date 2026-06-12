/**
 * Reusable **playwright (UI) verification-route producer** (momentiq-ai/
 * dark-factory#193).
 *
 * Generalized from the dark-factory-dashboard dogfood (Cycle 21 EC2/EC8, ADR
 * 2026-06). This is the `playwright` route's producer: for every UI surface
 * armed by the change under review it captures the required floor of the SOTA
 * UI-grounding triad:
 *
 *   (1) an **ARIA snapshot** (Playwright `ariaSnapshot()` — the accessibility
 *       tree, a structural, tamper-resistant assertion that the surface renders
 *       its expected landmark/heading/role structure) — ALWAYS produced, and
 *   (2) an **after screenshot** at the SHA under review — ALWAYS produced; plus
 *       an optional **before screenshot** baseline (completing the before/after
 *       pair) ONLY when `DF_UI_ROUTE_BEFORE_BASE_URL` is set. A missing baseline
 *       never fails the route.
 *
 * The **optional independent VLM check** (the triad's third leg) is DEFERRED in
 * v1: the ARIA + after capture is the required floor; the VLM leg is additive
 * corroboration gated behind a provider/cost decision. The hook is
 * `runOptionalVlmCheck()` below — a no-op unless `DF_UI_ROUTE_VLM=1` AND a
 * provider is wired, and it can only ADD a finding, never relax the floor.
 *
 * ## Fail-closed coverage
 *
 * A `web/**`/`*.tsx` change ARMS the route, but the producer maps each *changed*
 * UI path to a capture surface; a changed product-UI path with NO mapped surface
 * BLOCKS the route (the `ui-route-coverage` test below). This is the difference
 * between an evidence gate and a false-positive generator — a `*.tsx` change
 * cannot be satisfied by rendering only an unaffected surface. The mapping logic
 * lives in the unit-tested `coverage.ts`.
 *
 * ## Auth (consumer-supplied storage-state — NOT vendor-coupled)
 *
 * Public surfaces need no auth. For PROTECTED surfaces, supply an authenticated
 * Playwright `storageState` JSON and point `DF_UI_ROUTE_STORAGE_STATE` at it
 * (see `playwright.ui-route.config.ts`). How you mint that session (Clerk, Auth0,
 * a bot login, a long-lived test cookie) is YOUR repo's concern — the producer
 * only consumes the storage-state. v1 ships a single public surface so it works
 * zero-auth out of the box; add protected surfaces + storage-state as needed.
 *
 * ## Evidence shape
 *
 * Artifacts land under `DF_UI_ROUTE_OUT` (default
 * `agent-reviews/quality-gates/ui/<sha>/`), one subdir per surface:
 *   <surface-slug>/aria.snapshot.txt  — the ARIA tree (floor)
 *   <surface-slug>/after.png          — screenshot at the gated SHA (floor)
 *   <surface-slug>/before.png         — baseline (only when BEFORE_BASE_URL set)
 *   <surface-slug>/meta.json          — capture provenance
 *
 * The spec FAILS (→ route blocks) if a routed UI surface does not render its
 * required structure — the point: an over-claimed "the UI works" cannot pass the
 * gate without a real, passing capture bound to the SHA.
 *
 * ── CONSUMER REFERENCE FILE — copy into your repo and OWN it. The one block you
 *    MUST edit is `SURFACES[]` below (your routes + their required headings +
 *    the source globs each one covers). `df skills install verify` does NOT
 *    overwrite this file; it is yours to maintain.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { partitionChangedPaths, type UiSurface } from "./coverage";

const SHA = process.env.DF_UI_ROUTE_SHA ?? "unknown";
const OUT_DIR =
  process.env.DF_UI_ROUTE_OUT ?? `agent-reviews/quality-gates/ui/${SHA}`;
// Optional baseline origin for the "before" screenshot (e.g. the deployed
// tip-of-main app). When unset, only the "after" capture is taken — the ARIA
// snapshot + after screenshot are the required floor regardless.
const BEFORE_BASE_URL = process.env.DF_UI_ROUTE_BEFORE_BASE_URL?.replace(
  /\/$/,
  "",
);

/**
 * ▼▼▼ EDIT ME ▼▼▼ — the UI surfaces this producer asserts.
 *
 * Each entry pairs a route `path` with a stable, STRUCTURAL expectation
 * (`requiredHeading` — an accessible-name regex for a landmark heading) so the
 * capture also VERIFIES the surface (not just photographs it), AND a `covers`
 * glob list declaring which changed source paths it is the evidence for (the
 * fail-closed coverage map). Prefer role-based, copy-stable assertions.
 *
 * v1 ships ONE public surface (the home page) so the route works zero-auth out
 * of the box. Replace it with your app's surfaces; add protected routes (they
 * render under the storage-state session from the config) as your auth harness
 * hardens.
 */
const SURFACES: readonly UiSurface[] = [
  {
    path: "/",
    slug: "home",
    // EDIT: a heading name (role=heading, accessible name) YOUR home page must
    // expose. Keep it a REAL assertion — a vacuous `/.+/` ("some heading
    // exists") neither verifies the surface nor reliably renders.
    requiredHeading: /Welcome/i,
    // EDIT: the source globs THIS surface (the home page) ACTUALLY renders.
    // Keep them SCOPED. A broad glob like `web/app/**` or `web/**/*.tsx` would
    // claim the home surface is the evidence for your WHOLE app, so a change to
    // any OTHER page (e.g. web/app/settings/page.tsx) would be wrongly "covered"
    // by `/` and the route would PASS without ever rendering it — defeating the
    // fail-closed coverage below. Add one SURFACES[] entry per real surface; let
    // anything you have not scoped fall into `uncovered` and fail closed.
    covers: ["web/app/page.tsx"],
  },
];

/**
 * Changed UI paths that are NOT a renderable surface and so do not require a
 * capture — the route's own producer harness/coverage lib, test scaffolding,
 * type decls, styles, config. Excluding these keeps the fail-closed check
 * honest: it fires for genuinely-uncovered *product* UI, not for the harness
 * that implements the route. Anything NOT excluded and NOT covered by a surface
 * blocks (fail closed) until a surface is added for it.
 */
const NON_SURFACE_GLOBS: readonly string[] = [
  "web/tests/**",
  "web/playwright.ui-route.config.ts",
  "web/playwright.config.ts",
  "web/**/coverage.ts",
  "web/**/ui-route.producer.spec.ts",
  "web/**/*.test.ts",
  "web/**/*.test.tsx",
  "web/**/*.spec.ts",
  "web/**/*.d.ts",
  "web/**/*.css",
  "web/**/*.json",
  "web/**/*.md",
];

const CHANGED_UI_PATHS = (process.env.DF_UI_ROUTE_CHANGED_PATHS ?? "")
  .split(/\r?\n/)
  .map((p) => p.trim())
  .filter(Boolean);

const {
  armed: ARMED_SURFACES,
  uncovered: UNCOVERED_PATHS,
  smokeAllSurfaces: SMOKE_ALL_SURFACES,
} = partitionChangedPaths(CHANGED_UI_PATHS, SURFACES, NON_SURFACE_GLOBS);

function routeOutDir(slug: string): string {
  return join(OUT_DIR, slug);
}

/**
 * Optional independent VLM check (DEFERRED in v1).
 *
 * Additive-only: it may push a soft finding but can NEVER turn a failed floor
 * into a pass, nor is it required for the route to pass. Wired off by default;
 * enable with DF_UI_ROUTE_VLM=1 once you wire a provider + cost ceiling.
 * Intentionally surfaces its intent loudly rather than faking a check (which
 * would be the exact reward-hack this feature prevents).
 */
async function runOptionalVlmCheck(
  _afterScreenshotPath: string,
  _surface: UiSurface,
): Promise<void> {
  if (process.env.DF_UI_ROUTE_VLM !== "1") return;
  test.info().annotations.push({
    type: "vlm-check",
    description:
      "DF_UI_ROUTE_VLM=1 set but no VLM provider wired in this producer " +
      "(v1 deferred). The ARIA + after floor is the gate; the VLM leg is " +
      "additive corroboration only. No check performed.",
  });
}

async function captureBefore(
  page: Page,
  surface: UiSurface,
  dir: string,
): Promise<void> {
  if (!BEFORE_BASE_URL) return;
  const beforeUrl = `${BEFORE_BASE_URL}${surface.path}`;
  try {
    await page.goto(beforeUrl, { waitUntil: "networkidle", timeout: 30_000 });
    await page.screenshot({ path: join(dir, "before.png"), fullPage: true });
  } catch (err) {
    // The baseline is best-effort; a missing/unreachable baseline must not fail
    // the route (the ARIA + after capture is the floor). Record why.
    test.info().annotations.push({
      type: "before-capture-skipped",
      description: `baseline ${beforeUrl} unreachable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

// FAIL-CLOSED coverage gate: if the change touched a UI path that maps to NO
// capture surface, the route MUST block — it cannot be satisfied by rendering
// only an unaffected surface. This is the difference between an evidence gate
// and a false-positive generator. The fix is to ADD a surface (path +
// requiredHeading + covers glob) for the changed area, not to widen
// NON_SURFACE_GLOBS to hide it.
test("ui-route-coverage — every changed UI path maps to a capture surface", async () => {
  if (UNCOVERED_PATHS.length > 0) {
    throw new Error(
      "Evidence-Gated Validation playwright route: the following changed UI " +
        "path(s) have NO mapped capture surface, so this route cannot produce " +
        "real evidence for them and FAILS CLOSED:\n" +
        UNCOVERED_PATHS.map((p) => `  - ${p}`).join("\n") +
        "\n\nAdd a surface for the affected area to SURFACES[] in " +
        "ui-route.producer.spec.ts. Do NOT widen NON_SURFACE_GLOBS to suppress " +
        "a real UI change — that re-opens the false-positive hole this gate closes.",
    );
  }
  expect(UNCOVERED_PATHS).toEqual([]);
  // Harness-only change → smoke-capture ALL surfaces (the route still produces
  // real evidence; it is never passable with zero captures). Surfaced so the
  // evidence log shows why every surface was captured.
  if (SMOKE_ALL_SURFACES) {
    test.info().annotations.push({
      type: "ui-route-smoke",
      description:
        "Harness/non-UI-only change: capturing ALL surfaces as a regression " +
        "smoke (no product-UI surface was directly armed). The route still " +
        "produces ARIA + after evidence — it cannot pass with zero captures.",
    });
  }
});

for (const surface of ARMED_SURFACES) {
  test(`UI route evidence — ${surface.slug} (${surface.path})`, async ({
    page,
  }) => {
    const dir = routeOutDir(surface.slug);
    mkdirSync(dir, { recursive: true });

    // --- (optional) BEFORE: baseline screenshot from the configured origin ---
    await captureBefore(page, surface, dir);

    // --- AFTER: the SHA under review (the locally-served / configured app) ---
    await page.goto(surface.path, { waitUntil: "networkidle", timeout: 30_000 });

    // Floor assertion — the surface renders its required structure. A REAL gate:
    // an over-claimed render that doesn't expose the heading FAILS here, blocking
    // the route. (Role-based → robust to copy churn.)
    await expect(
      page.getByRole("heading", { name: surface.requiredHeading }),
    ).toBeVisible({ timeout: 15_000 });

    // Floor evidence #1 — ARIA snapshot (the accessibility tree). Structural,
    // diff-able, hard to stage. Assert it is non-trivial, then persist it.
    const ariaSnapshot = await page.locator("body").ariaSnapshot();
    expect(ariaSnapshot.trim().length).toBeGreaterThan(0);
    writeFileSync(join(dir, "aria.snapshot.txt"), `${ariaSnapshot}\n`, "utf8");

    // Floor evidence #2 — the "after" screenshot bound to the gated SHA.
    const afterPath = join(dir, "after.png");
    await page.screenshot({ path: afterPath, fullPage: true });

    // Per-surface metadata (the human-reviewable provenance of this capture).
    writeFileSync(
      join(dir, "meta.json"),
      `${JSON.stringify(
        {
          surface: surface.slug,
          path: surface.path,
          sha: SHA,
          capturedAt: new Date().toISOString(),
          baseURL: test.info().project.use.baseURL ?? null,
          beforeBaseURL: BEFORE_BASE_URL ?? null,
          ariaSnapshotBytes: Buffer.byteLength(ariaSnapshot, "utf8"),
          evidenceKind: "playwright",
          floor: ["aria-snapshot", "after-screenshot"],
          beforeScreenshot: BEFORE_BASE_URL ? "before.png" : null,
          vlm: "deferred-v1",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // --- optional, additive-only VLM corroboration (deferred in v1) ---
    await runOptionalVlmCheck(afterPath, surface);
  });
}
