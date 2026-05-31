import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getBundleInfo, getBundledTemplatePath } from "../src/template-resolver.js";

describe("template-resolver", () => {
  it("getBundledTemplatePath returns a directory that exists", () => {
    // Skip if the template hasn't been bundled yet (no SAGE_BLUEPRINT_LOCAL_PATH
    // and no GH_TOKEN at install time). The CI workflow always bundles before
    // test, so this passes there.
    if (!existsSync(`${__dirname}/../template/copier.yaml`)) {
      return;
    }
    const p = getBundledTemplatePath();
    expect(typeof p).toBe("string");
    expect(p.endsWith("template")).toBe(true);
  });

  it("getBundleInfo returns either null or a well-shaped object", () => {
    const info = getBundleInfo();
    if (info === null) return; // unbundled — acceptable for unit-test runs without bundling
    expect(typeof info.commit).toBe("string");
    expect(info.commit.length).toBeGreaterThan(0);
    expect(typeof info.ref).toBe("string");
    expect(typeof info.fetched_at).toBe("string");
    expect(typeof info.source_repo).toBe("string");
  });
});
