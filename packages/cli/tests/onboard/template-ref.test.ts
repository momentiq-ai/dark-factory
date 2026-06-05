import { describe, it, expect } from "vitest";
import { parseTemplateRef } from "../../src/onboard/template-ref.js";

describe("parseTemplateRef", () => {
  it("parses gh:owner/repo@latest", () => {
    expect(parseTemplateRef("gh:momentiq-ai/sage-blueprint@latest")).toEqual({
      kind: "gh", owner: "momentiq-ai", repo: "sage-blueprint", ref: "latest",
    });
  });

  it("parses file:///abs/path@<sha>", () => {
    expect(parseTemplateRef("file:///tmp/x@0000000000000000000000000000000000000000")).toEqual({
      kind: "file", path: "/tmp/x", ref: "0000000000000000000000000000000000000000",
    });
  });

  it("rejects mixed-hex short shas in gh: refs (7-39 chars + at least one a-f)", () => {
    expect(() => parseTemplateRef("gh:owner/repo@abc1234")).toThrow(/short sha/i);
    expect(() => parseTemplateRef("gh:owner/repo@deadbeef")).toThrow(/short sha/i);
    expect(() => parseTemplateRef("gh:owner/repo@" + "a".repeat(39))).toThrow(/short sha/i);
  });

  it("accepts pure-digit refs (release tags) — NOT short shas", () => {
    expect(parseTemplateRef("gh:owner/repo@123456")).toEqual({
      kind: "gh", owner: "owner", repo: "repo", ref: "123456",
    });
    expect(parseTemplateRef("gh:owner/repo@20260603")).toEqual({
      kind: "gh", owner: "owner", repo: "repo", ref: "20260603",
    });
  });

  it("accepts short refs < 7 chars (below the short-sha rule range)", () => {
    expect(parseTemplateRef("gh:owner/repo@cafe")).toEqual({
      kind: "gh", owner: "owner", repo: "repo", ref: "cafe",
    });
  });

  it("accepts a full 40-char sha", () => {
    expect(parseTemplateRef("gh:owner/repo@" + "a".repeat(40))).toEqual({
      kind: "gh", owner: "owner", repo: "repo", ref: "a".repeat(40),
    });
  });

  it("accepts named refs (branch / tag)", () => {
    expect(parseTemplateRef("gh:owner/repo@main")).toEqual({
      kind: "gh", owner: "owner", repo: "repo", ref: "main",
    });
    expect(parseTemplateRef("gh:owner/repo@v1.0.0")).toEqual({
      kind: "gh", owner: "owner", repo: "repo", ref: "v1.0.0",
    });
  });

  it("rejects malformed refs", () => {
    expect(() => parseTemplateRef("not-a-ref")).toThrow();
  });
});
