import { describe, expect, it } from "vitest";

import {
  PROOF_STATUSES,
  SchemaError,
  parseBoundProofRecord,
  type BoundProofRecord,
} from "../src/index.js";

const valid: unknown = {
  schemaVersion: 1,
  commit: "abc123def456",
  diffHash: "feed".repeat(16),
  provenance: "consumer-attested",
  generatedAt: "2026-06-20T00:00:00.000Z",
  objectives: [
    {
      id: "cycle21#ec1",
      text: "Route table populated.",
      enforced: false,
      status: "proven",
      bindings: [
        { kind: "route", ref: "targeted-test", status: "proven", detail: "exit 0, diffHash-bound", uploadId: "up_1" },
      ],
    },
    {
      id: "issue1234#ac2",
      text: "Dashboard renders the proof panel.",
      enforced: false,
      status: "pending",
      bindings: [
        { kind: "critic", ref: "codex", status: "pending", detail: "awaiting critic verdict" },
      ],
    },
  ],
  summary: { proven: 1, pending: 1, failed: 0, total: 2 },
};

describe("parseBoundProofRecord", () => {
  it("accepts a well-formed record", () => {
    const r: BoundProofRecord = parseBoundProofRecord(valid);
    expect(r.schemaVersion).toBe(1);
    expect(r.provenance).toBe("consumer-attested");
    expect(r.objectives).toHaveLength(2);
    expect(r.objectives[0].bindings[0]).toEqual({
      kind: "route",
      ref: "targeted-test",
      status: "proven",
      detail: "exit 0, diffHash-bound",
      uploadId: "up_1",
    });
    expect(r.objectives[1].bindings[0].uploadId).toBeUndefined();
    expect(r.summary).toEqual({ proven: 1, pending: 1, failed: 0, total: 2 });
  });

  it("rejects a summary inconsistent with the objectives", () => {
    const bad = { ...(valid as any), summary: { proven: 5, pending: 0, failed: 0, total: 5 } };
    expect(() => parseBoundProofRecord(bad)).toThrow(/inconsistent with objectives/);
  });

  it("rejects an unknown ProofStatus", () => {
    const bad = {
      ...(valid as any),
      objectives: [{ ...(valid as any).objectives[0], status: "maybe" }],
    };
    expect(() => parseBoundProofRecord(bad)).toThrow(SchemaError);
  });

  it("rejects an unknown binding kind", () => {
    const bad = {
      ...(valid as any),
      objectives: [
        {
          ...(valid as any).objectives[0],
          bindings: [{ kind: "vibes", ref: "x", status: "proven", detail: "" }],
        },
      ],
    };
    expect(() => parseBoundProofRecord(bad)).toThrow(SchemaError);
  });

  it("rejects schemaVersion other than 1", () => {
    expect(() => parseBoundProofRecord({ ...(valid as object), schemaVersion: 2 })).toThrow(
      SchemaError,
    );
  });

  it("rejects an unknown provenance", () => {
    expect(() => parseBoundProofRecord({ ...(valid as object), provenance: "guessed" })).toThrow(
      SchemaError,
    );
  });

  it("exposes the status set", () => {
    expect(PROOF_STATUSES).toEqual(["proven", "pending", "failed"]);
  });
});
