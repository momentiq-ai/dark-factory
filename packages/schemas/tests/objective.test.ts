import { describe, expect, it } from "vitest";

import {
  OBJECTIVE_ID_RE,
  SchemaError,
  parseObjectivesManifest,
  type ObjectivesManifest,
} from "../src/index.js";

const valid: unknown = {
  schemaVersion: 1,
  objectives: [
    {
      id: "cycle21#ec1",
      source: { kind: "cycle", ref: "21" },
      text: "Route table populated for the common change classes.",
      attestedBy: [{ kind: "route", routeId: "targeted-test" }],
      enforced: false,
    },
    {
      id: "issue1234#ac2",
      source: { kind: "issue", ref: "#1234" },
      text: "Dashboard renders the proof panel for a UI route.",
      attestedBy: [
        { kind: "route", routeId: "playwright" },
        { kind: "critic", criticId: "codex" },
      ],
      enforced: false,
    },
  ],
};

describe("parseObjectivesManifest", () => {
  it("accepts a well-formed manifest", () => {
    const m: ObjectivesManifest = parseObjectivesManifest(valid);
    expect(m.schemaVersion).toBe(1);
    expect(m.objectives).toHaveLength(2);
    expect(m.objectives[0].attestedBy[0]).toEqual({ kind: "route", routeId: "targeted-test" });
  });

  it("rejects a malformed objective id", () => {
    const bad = { schemaVersion: 1, objectives: [{ ...((valid as any).objectives[0]), id: "EC1" }] };
    expect(() => parseObjectivesManifest(bad)).toThrow(SchemaError);
  });

  it("rejects an id inconsistent with its source", () => {
    const bad = {
      schemaVersion: 1,
      objectives: [{ ...((valid as any).objectives[0]), id: "issue21#ac1" }],
    };
    expect(() => parseObjectivesManifest(bad)).toThrow(/inconsistent with source/);
  });

  it("rejects an unknown evidence-binding kind", () => {
    const bad = {
      schemaVersion: 1,
      objectives: [{ ...((valid as any).objectives[0]), attestedBy: [{ kind: "vibes" }] }],
    };
    expect(() => parseObjectivesManifest(bad)).toThrow(SchemaError);
  });

  it("exposes the id pattern", () => {
    expect(OBJECTIVE_ID_RE.test("cycle3#ec10")).toBe(true);
    expect(OBJECTIVE_ID_RE.test("issue9#ac1")).toBe(true);
    expect(OBJECTIVE_ID_RE.test("cycle3#xx1")).toBe(false);
  });

  it("rejects cross-kind id pairings", () => {
    // cycle kind must use #ec suffix; issue kind must use #ac suffix
    expect(OBJECTIVE_ID_RE.test("cycle3#ac1")).toBe(false);
    expect(OBJECTIVE_ID_RE.test("issue3#ec1")).toBe(false);
  });

  it("accepts dotted cycle ids", () => {
    expect(OBJECTIVE_ID_RE.test("cycle318.4#ec1")).toBe(true);
    expect(OBJECTIVE_ID_RE.test("cycle331.1#ec2")).toBe(true);
    const m1 = parseObjectivesManifest({
      schemaVersion: 1,
      objectives: [
        {
          id: "cycle318.4#ec1",
          source: { kind: "cycle", ref: "318.4" },
          text: "Dotted cycle objective.",
          attestedBy: [{ kind: "critic", criticId: "codex" }],
          enforced: false,
        },
      ],
    });
    expect(m1.objectives[0].id).toBe("cycle318.4#ec1");
    const m2 = parseObjectivesManifest({
      schemaVersion: 1,
      objectives: [
        {
          id: "cycle331.1#ec2",
          source: { kind: "cycle", ref: "331.1" },
          text: "Sub-cycle objective.",
          attestedBy: [{ kind: "critic", criticId: "cursor" }],
          enforced: false,
        },
      ],
    });
    expect(m2.objectives[0].id).toBe("cycle331.1#ec2");
  });
});
