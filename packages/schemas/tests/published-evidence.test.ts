import { describe, expect, it } from "vitest";

import {
  SHA256_HEX_RE,
  SchemaError,
  parsePublishedEvidence,
  type PublishedEvidence,
} from "../src/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const DIFF = "deadbeef".repeat(8);

const complete: unknown = {
  schemaVersion: 1,
  commit: "abc123def456",
  provenance: "consumer-attested",
  status: "complete",
  diffHash: DIFF,
  gateEvidence: {
    path: ".git/agent-reviews/quality-gates/abc123def456.json",
    uploadId: "up_gate_1",
    sha256: HASH_A,
    contentType: "application/json",
    sizeBytes: 2048,
  },
  routes: {
    playwright: {
      routeId: "playwright",
      exitCode: 0,
      artifacts: [
        {
          path: "agent-reviews/quality-gates/ui/abc123def456/home/before.png",
          uploadId: "up_png_1",
          sha256: HASH_B,
          contentType: "image/png",
          sizeBytes: 51234,
        },
      ],
    },
  },
};

describe("parsePublishedEvidence", () => {
  it("accepts a well-formed complete manifest", () => {
    const m: PublishedEvidence = parsePublishedEvidence(complete);
    expect(m.schemaVersion).toBe(1);
    expect(m.provenance).toBe("consumer-attested");
    expect(m.status).toBe("complete");
    expect(m.diffHash).toBe(DIFF);
    expect(m.gateEvidence?.uploadId).toBe("up_gate_1");
    expect(m.routes["playwright"].artifacts[0].uploadId).toBe("up_png_1");
    expect(m.routes["playwright"].exitCode).toBe(0);
  });

  it("accepts a degraded manifest with no uploads", () => {
    const m = parsePublishedEvidence({
      schemaVersion: 1,
      commit: "abc123def456",
      provenance: "consumer-attested",
      status: "degraded",
      degradedReason: "CEREBE_API_URL unset — air-gapped run",
      routes: {},
    });
    expect(m.status).toBe("degraded");
    expect(m.degradedReason).toMatch(/CEREBE_API_URL/);
    expect(m.gateEvidence).toBeUndefined();
    expect(Object.keys(m.routes)).toHaveLength(0);
  });

  it("rejects a route whose embedded routeId disagrees with its map key", () => {
    const bad = {
      ...(complete as any),
      routes: { playwright: { ...(complete as any).routes.playwright, routeId: "other" } },
    };
    expect(() => parsePublishedEvidence(bad)).toThrow(/must match its map key/);
  });

  it("rejects degradedReason on a complete manifest", () => {
    expect(() =>
      parsePublishedEvidence({ ...(complete as object), degradedReason: "should not be here" }),
    ).toThrow(/must be omitted when status is "complete"/);
  });

  it("requires degradedReason when status is degraded", () => {
    expect(() =>
      parsePublishedEvidence({
        schemaVersion: 1,
        commit: "abc",
        provenance: "consumer-attested",
        status: "degraded",
        routes: {},
      }),
    ).toThrow(/degradedReason/);
  });

  it("rejects an unknown provenance", () => {
    expect(() =>
      parsePublishedEvidence({ ...(complete as object), provenance: "vibes" }),
    ).toThrow(SchemaError);
  });

  it("rejects an unknown status", () => {
    expect(() =>
      parsePublishedEvidence({ ...(complete as object), status: "maybe" }),
    ).toThrow(SchemaError);
  });

  it("rejects schemaVersion other than 1", () => {
    expect(() =>
      parsePublishedEvidence({ ...(complete as object), schemaVersion: 2 }),
    ).toThrow(SchemaError);
  });

  it("rejects a non-hex sha256 on an artifact", () => {
    const bad = {
      ...(complete as any),
      gateEvidence: { ...(complete as any).gateEvidence, sha256: "not-a-hash" },
    };
    expect(() => parsePublishedEvidence(bad)).toThrow(/sha256/);
  });

  it("rejects a negative sizeBytes", () => {
    const bad = {
      ...(complete as any),
      gateEvidence: { ...(complete as any).gateEvidence, sizeBytes: -1 },
    };
    expect(() => parsePublishedEvidence(bad)).toThrow(SchemaError);
  });

  it("exposes the sha256 hex pattern", () => {
    expect(SHA256_HEX_RE.test(HASH_A)).toBe(true);
    expect(SHA256_HEX_RE.test("ABC")).toBe(false);
    expect(SHA256_HEX_RE.test("g".repeat(64))).toBe(false);
  });
});
