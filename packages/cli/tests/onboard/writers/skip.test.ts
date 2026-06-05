import { describe, it, expect } from "vitest";
import { writeSkip } from "../../../src/onboard/writers/skip.js";

describe("writeSkip", () => {
  it("returns a SkipResult describing the no-op", async () => {
    const r = await writeSkip("/tmp/x", {
      path: ".agent-review/config.json", action: "skip",
      rationale: "already configured (analysis.dfPresence.configJson === true)",
    });
    expect(r).toEqual({
      path: ".agent-review/config.json",
      action: "skip",
      rationale: "already configured (analysis.dfPresence.configJson === true)",
      wrote: false,
    });
  });
});
