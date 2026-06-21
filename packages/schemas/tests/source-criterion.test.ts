import { describe, expect, it } from "vitest";

import {
  SOURCE_LOCATOR_RE,
  SchemaError,
  canonicalizeCriterion,
  parseObjectivesManifest,
  type Objective,
} from "../src/index.js";

const HASH = "a".repeat(64);

function objWith(sourceCriterion: unknown): unknown {
  return {
    schemaVersion: 1,
    objectives: [
      {
        id: "cycle21#ec1",
        source: { kind: "cycle", ref: "21" },
        text: "Route table populated.",
        attestedBy: [{ kind: "route", routeId: "targeted-test" }],
        enforced: false,
        ...(sourceCriterion !== undefined ? { sourceCriterion } : {}),
      },
    ],
  };
}

describe("canonicalizeCriterion", () => {
  it("strips a list marker + bold label", () => {
    expect(canonicalizeCriterion("- **EC1**: Route table populated.")).toBe(
      "Route table populated.",
    );
  });
  it("strips a plain label with a dash separator", () => {
    expect(canonicalizeCriterion("* ec1 - Route table populated.")).toBe(
      "Route table populated.",
    );
  });
  it("strips a numbered list marker (no label)", () => {
    expect(canonicalizeCriterion("1. Route table populated.")).toBe("Route table populated.");
  });
  it("collapses whitespace + newlines", () => {
    expect(canonicalizeCriterion("Route table   populated.\n  More.")).toBe(
      "Route table populated. More.",
    );
  });
  it("strips emphasis + code tokens", () => {
    expect(canonicalizeCriterion("`code` and **bold** text")).toBe("code and bold text");
  });
  it("is idempotent", () => {
    const once = canonicalizeCriterion("- **EC1**: Route table   populated.");
    expect(canonicalizeCriterion(once)).toBe(once);
  });
});

describe("SOURCE_LOCATOR_RE", () => {
  it("accepts <section-slug>#<criterion-id>", () => {
    expect(SOURCE_LOCATOR_RE.test("exit_criteria#ec1")).toBe(true);
    expect(SOURCE_LOCATOR_RE.test("acceptance#ac2")).toBe(true);
  });
  it("rejects malformed locators", () => {
    expect(SOURCE_LOCATOR_RE.test("exit criteria#ec1")).toBe(false); // space
    expect(SOURCE_LOCATOR_RE.test("exit_criteria")).toBe(false); // no '#'
    expect(SOURCE_LOCATOR_RE.test("a#b#c")).toBe(false); // two '#'
  });
});

describe("parseObjective sourceCriterion", () => {
  it("accepts an objective with no sourceCriterion (backward compatible)", () => {
    const m = parseObjectivesManifest(objWith(undefined));
    expect(m.objectives[0].sourceCriterion).toBeUndefined();
  });
  it("accepts a text-hash binding", () => {
    const m = parseObjectivesManifest(
      objWith({ kind: "text-hash", locator: "exit_criteria#ec1", sha256: HASH }),
    );
    expect(m.objectives[0].sourceCriterion).toEqual({
      kind: "text-hash",
      locator: "exit_criteria#ec1",
      sha256: HASH,
    });
  });
  it("accepts a human-reviewed binding (with optional by)", () => {
    const m = parseObjectivesManifest(objWith({ kind: "human-reviewed", by: "PJ" }));
    expect(m.objectives[0].sourceCriterion).toEqual({ kind: "human-reviewed", by: "PJ" });
  });
  it("rejects a text-hash with a malformed locator", () => {
    expect(() =>
      parseObjectivesManifest(objWith({ kind: "text-hash", locator: "bad locator", sha256: HASH })),
    ).toThrow(SchemaError);
  });
  it("rejects a text-hash with a non-hex sha256", () => {
    expect(() =>
      parseObjectivesManifest(
        objWith({ kind: "text-hash", locator: "exit_criteria#ec1", sha256: "nope" }),
      ),
    ).toThrow(/sha256/);
  });
  it("rejects an unknown sourceCriterion kind", () => {
    expect(() => parseObjectivesManifest(objWith({ kind: "vibes" }))).toThrow(SchemaError);
  });
});
