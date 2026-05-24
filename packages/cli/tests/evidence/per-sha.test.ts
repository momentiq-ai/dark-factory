// Service #4 boundary smoke test — verifies that the per-SHA evidence
// path helpers, runner, and trailer parser remain importable via the
// `evidence/` boundary after the Phase C refactor.

import { describe, expect, it } from "vitest";

import {
  parseCommitTrailers,
  getTrailer,
  perShaQualityGatePath,
  collectChangedPaths,
  QUALITY_GATES_SUBDIR,
} from "../../src/evidence/index.js";

describe("evidence boundary — Phase C refactor", () => {
  it("re-exports perShaQualityGatePath that resolves the canonical layout", () => {
    const p = perShaQualityGatePath("/tmp/root", ".df", "abc123");
    expect(p).toBe(`/tmp/root/.df/${QUALITY_GATES_SUBDIR}/abc123.json`);
  });

  it("re-exports parseCommitTrailers + getTrailer", () => {
    const msg = "Implement feature\n\nIssue: 42\nCycle: 331.1\n";
    const trailers = parseCommitTrailers(msg);
    expect(trailers.hasTrailerBlock).toBe(true);
    expect(getTrailer(trailers, "Cycle")).toBe("331.1");
    expect(getTrailer(trailers, "cycle")).toBe("331.1");
    expect(getTrailer(trailers, "Issue")).toBe("42");
  });

  it("re-exports collectChangedPaths", () => {
    const out = collectChangedPaths([
      { path: "a.ts" },
      { path: "new/b.ts", oldPath: "old/b.ts" },
    ]);
    expect(out).toEqual(["a.ts", "new/b.ts", "old/b.ts"]);
  });

  it("exposes QUALITY_GATES_SUBDIR constant unchanged from Phase B", () => {
    expect(QUALITY_GATES_SUBDIR).toBe("quality-gates");
  });
});
