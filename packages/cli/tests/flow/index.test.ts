import { describe, expect, it } from "vitest";
import { cmdFlow } from "../../src/commands/flow/index.js";
import { EXIT_ARG_ERROR, EXIT_OK } from "../../src/commands/flow/common.js";
import { makeIo, stubFetcher } from "./_fixtures.js";

describe("flow/index — cmdFlow dispatch", () => {
  it("no subcommand prints the namespace help", async () => {
    const ctx = makeIo();
    const code = await cmdFlow([], ctx.io);
    expect(code).toBe(EXIT_OK);
    expect(ctx.out()).toMatch(/df flow <subcommand>/);
    expect(ctx.out()).toMatch(/show\s+Render the AssessmentArtifact/);
  });
  it("--help prints the namespace help", async () => {
    const ctx = makeIo();
    expect(await cmdFlow(["--help"], ctx.io)).toBe(EXIT_OK);
    expect(ctx.out()).toMatch(/df flow <subcommand>/);
  });
  it("unknown subcommand exits 1 with attribution", async () => {
    const ctx = makeIo();
    const code = await cmdFlow(["nope"], ctx.io);
    expect(code).toBe(EXIT_ARG_ERROR);
    expect(ctx.err()).toMatch(/unknown subcommand "nope"/);
  });
  it("forwards a flag-only sub --help to the right runner", async () => {
    const ctx = makeIo();
    expect(await cmdFlow(["show", "--help"], ctx.io)).toBe(EXIT_OK);
    expect(ctx.out()).toMatch(/df flow show — render the AssessmentArtifact/);
  });
  it("routes 'patterns' to its runner end-to-end with a stub fetcher", async () => {
    // Minimal smoke — confirms the dispatcher returns the runner's exit code,
    // not the namespace's. Programming every catalog file as 404 makes
    // patterns return exit 0 with an empty-but-success summary.
    const { PATTERN_CATALOG } = await import("../../src/commands/flow/pattern-catalog.js");
    const files: Record<string, string | null> = {};
    for (const p of PATTERN_CATALOG) {
      files[`store/tenant/sage3c/recurrence/${p.id}.ndjson`] = null;
    }
    const fetcher = stubFetcher({ files });
    const ctx = makeIo({ fetcher });
    expect(await cmdFlow(["patterns", "--json"], ctx.io)).toBe(EXIT_OK);
    expect(JSON.parse(ctx.out()).length).toBe(PATTERN_CATALOG.length);
  });
});
