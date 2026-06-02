import { describe, expect, it } from "vitest";

import { formatVersionBanner, renderVersionBanner } from "../src/version.js";
import type { BundleInfo } from "../src/template-resolver.js";

const NAME = "@momentiq/sage-cli";
const VERSION = "0.2.1";

function bundleInfo(overrides: Partial<BundleInfo> = {}): BundleInfo {
  return {
    commit: "abc123def4560000000000000000000000000000",
    ref: "main",
    fetched_at: "2026-05-30T00:00:00Z",
    source_repo: "momentiq-ai/sage-blueprint",
    ...overrides,
  };
}

describe("formatVersionBanner", () => {
  it("strips the org prefix from source_repo so the banner reads 'sage-blueprint@<sha>' (#90)", () => {
    const banner = formatVersionBanner(NAME, VERSION, bundleInfo());
    expect(banner).toContain("bundled sage-blueprint@");
    expect(banner).not.toContain("momentiq-ai/sage-blueprint@");
    expect(banner).not.toMatch(/bundled momentiq-ai\//);
  });

  it("uses the basename when source_repo has no slash (defensive)", () => {
    const banner = formatVersionBanner(
      NAME,
      VERSION,
      bundleInfo({ source_repo: "sage-blueprint" }),
    );
    expect(banner).toContain("bundled sage-blueprint@");
    expect(banner).not.toContain("momentiq-ai/");
  });

  it("includes the 12-char short commit and the ref", () => {
    const banner = formatVersionBanner(
      NAME,
      VERSION,
      bundleInfo({ commit: "0123456789abcdef0123456789abcdef01234567", ref: "v0.2.1" }),
    );
    expect(banner).toContain("sage-blueprint@0123456789ab");
    expect(banner).toContain("via ref v0.2.1");
  });

  it("renders a missing-bundle fallback when bundle is null", () => {
    const banner = formatVersionBanner(NAME, VERSION, null);
    expect(banner).toBe(`${NAME} ${VERSION} (bundled template: <bundle-info missing>)`);
    expect(banner).not.toContain("momentiq-ai/");
  });
});

describe("renderVersionBanner (integration)", () => {
  it("the actual binary banner contains no momentiq-ai/ org prefix in the bundled-line (#90)", () => {
    // This wraps the real package.json + .bundle-info.json read paths. Either:
    //  - bundle is present (CI / post-bundle): banner reads "bundled sage-blueprint@..."
    //  - bundle is missing (developer machine, fresh clone): banner reads "<bundle-info missing>"
    // Both branches MUST be free of the org prefix.
    const banner = renderVersionBanner();
    expect(banner).not.toContain("momentiq-ai/sage-blueprint");
    expect(banner).not.toMatch(/bundled momentiq-ai\//);
  });
});
