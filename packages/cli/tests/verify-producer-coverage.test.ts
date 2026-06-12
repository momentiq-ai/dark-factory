// Cycle 22 (momentiq-ai/dark-factory#193) — the reusable playwright (UI) route
// producer ships as consumer COPY-ONCE reference files under
// `skills/verify/producer/`, so they are NOT compiled by the CLI's `src/`
// tsconfig and NOT runtime-testable here (no browser). The ONE piece that is
// pure, importable, and load-bearing — the fail-closed coverage logic (a
// changed UI path with no capture surface BLOCKS the route) — is unit-tested
// here so the generalized port cannot silently regress the bypass-prevention
// it exists to provide.
import { describe, expect, it } from "vitest";

import {
  globToRegExp,
  matchesAny,
  partitionChangedPaths,
  type UiSurface,
} from "../skills/verify/producer/coverage.js";

const HOME: UiSurface = {
  path: "/",
  slug: "home",
  requiredHeading: /.+/,
  covers: ["web/app/**", "web/app/page.tsx"],
};
const SETTINGS: UiSurface = {
  path: "/settings",
  slug: "settings",
  requiredHeading: /Settings/i,
  covers: ["web/app/settings/**"],
};
const NON_SURFACE = [
  "web/tests/**",
  "web/**/coverage.ts",
  "web/**/*.css",
  "web/**/*.test.tsx",
];

describe("globToRegExp", () => {
  it("`**` matches across path separators, `*` does not", () => {
    expect(globToRegExp("web/**").test("web/app/settings/page.tsx")).toBe(true);
    expect(globToRegExp("web/*").test("web/app/page.tsx")).toBe(false);
    expect(globToRegExp("web/*").test("web/page.tsx")).toBe(true);
  });

  it("anchors the whole path (no partial match)", () => {
    expect(globToRegExp("web/app/**").test("other/web/app/x")).toBe(false);
  });

  it("treats route-group parentheses as literals", () => {
    expect(globToRegExp("web/app/(public)/**").test("web/app/(public)/page.tsx")).toBe(
      true,
    );
    expect(globToRegExp("web/app/(public)/**").test("web/app/xpublicx/page.tsx")).toBe(
      false,
    );
  });
});

describe("matchesAny", () => {
  it("is true when any glob matches", () => {
    expect(matchesAny("web/app/page.tsx", ["never/**", "web/app/**"])).toBe(true);
    expect(matchesAny("web/app/page.tsx", ["never/**"])).toBe(false);
  });
});

describe("partitionChangedPaths — fail-closed coverage (#193)", () => {
  it("arms the surface whose `covers` matches a changed path", () => {
    const r = partitionChangedPaths(["web/app/page.tsx"], [HOME, SETTINGS], NON_SURFACE);
    expect(r.armed.map((s) => s.slug)).toEqual(["home"]);
    expect(r.uncovered).toEqual([]);
    expect(r.smokeAllSurfaces).toBe(false);
  });

  it("BLOCKS (uncovered) a changed product-UI path with NO mapped surface", () => {
    // A *.tsx under web/components/ matches no surface's `covers` and is not a
    // non-surface harness file → it must fail closed.
    const r = partitionChangedPaths(
      ["web/components/Widget.tsx"],
      [HOME, SETTINGS],
      NON_SURFACE,
    );
    expect(r.uncovered).toEqual(["web/components/Widget.tsx"]);
    expect(r.smokeAllSurfaces).toBe(false);
  });

  it("exempts harness/non-UI files from the coverage requirement", () => {
    const r = partitionChangedPaths(
      ["web/tests/e2e/x.ts", "web/app/styles.css"],
      [HOME, SETTINGS],
      NON_SURFACE,
    );
    expect(r.uncovered).toEqual([]);
    // All changed paths were non-surface → harness-only → smoke ALL surfaces.
    expect(r.smokeAllSurfaces).toBe(true);
    expect(r.armed.map((s) => s.slug).sort()).toEqual(["home", "settings"]);
  });

  it("harness-only change smoke-captures all surfaces (never passes with zero evidence)", () => {
    const r = partitionChangedPaths(
      ["web/tests/e2e/ui-route.producer.spec.ts"],
      [HOME, SETTINGS],
      NON_SURFACE,
    );
    expect(r.smokeAllSurfaces).toBe(true);
    expect(r.armed).toHaveLength(2);
  });

  it("empty changed set arms all surfaces (manual run; not a smoke)", () => {
    const r = partitionChangedPaths([], [HOME, SETTINGS], NON_SURFACE);
    expect(r.armed).toHaveLength(2);
    expect(r.smokeAllSurfaces).toBe(false);
    expect(r.uncovered).toEqual([]);
  });

  it("a mix of covered + uncovered reports the uncovered path (fail closed wins)", () => {
    const r = partitionChangedPaths(
      ["web/app/page.tsx", "web/components/Orphan.tsx"],
      [HOME, SETTINGS],
      NON_SURFACE,
    );
    expect(r.armed.map((s) => s.slug)).toEqual(["home"]);
    expect(r.uncovered).toEqual(["web/components/Orphan.tsx"]);
  });

  it("STARTER-CONFIG HAZARD: a broad `covers` swallows a sibling sub-page (must stay scoped)", () => {
    // The shipped starter surface (ui-route.producer.spec.ts) MUST scope its
    // `covers` to what it actually renders. A broad glob like `web/app/**` on
    // the home surface would wrongly "cover" a sibling sub-page, so the route
    // passes WITHOUT rendering it — the exact false-positive this gate prevents.
    const change = ["web/app/settings/page.tsx"];
    const scopedHome: UiSurface = {
      path: "/",
      slug: "home",
      requiredHeading: /Welcome/i,
      covers: ["web/app/page.tsx"], // what the shipped starter uses
    };
    const broadHome: UiSurface = { ...scopedHome, covers: ["web/app/**"] };

    // Scoped (correct): the sibling has no surface → fail closed (uncovered).
    expect(
      partitionChangedPaths(change, [scopedHome], NON_SURFACE).uncovered,
    ).toEqual(change);
    // Broad (the anti-pattern): the sibling is wrongly "covered" by `/`.
    expect(
      partitionChangedPaths(change, [broadHome], NON_SURFACE).uncovered,
    ).toEqual([]);
  });
});
