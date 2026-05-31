import { describe, it, expect } from "vitest";
import { normalizeIso, isoToEpoch, formatAge } from "../../src/handoff/iso.js";

describe("normalizeIso", () => {
  it("canonical Z is unchanged", () => {
    expect(normalizeIso("2026-05-30T00:00:00Z")).toBe("2026-05-30T00:00:00Z");
  });
  it("fractional seconds stripped, Z preserved", () => {
    expect(normalizeIso("2026-05-30T00:00:00.500Z")).toBe("2026-05-30T00:00:00Z");
    expect(normalizeIso("2026-05-30T00:00:00.123Z")).toBe("2026-05-30T00:00:00Z");
  });
  it("numeric offset replaced with Z", () => {
    expect(normalizeIso("2026-05-30T00:00:00+00:00")).toBe("2026-05-30T00:00:00Z");
    expect(normalizeIso("2026-05-30T00:00:00-05:00")).toBe("2026-05-30T00:00:00Z");
  });
  it("fractional + numeric offset both stripped", () => {
    expect(normalizeIso("2026-05-30T00:00:00.123-05:00")).toBe("2026-05-30T00:00:00Z");
  });
  it("empty input returns empty", () => {
    expect(normalizeIso("")).toBe("");
  });
});

describe("isoToEpoch", () => {
  it("canonical Z parses correctly", () => {
    expect(isoToEpoch("1970-01-01T00:00:00Z")).toBe(0);
    expect(isoToEpoch("2026-05-30T00:00:00Z")).toBe(1780099200);
  });
  it("fractional seconds parse (normalized first)", () => {
    expect(isoToEpoch("2026-05-30T00:00:00.500Z")).toBe(1780099200);
  });
  it("numeric offset parses (treated as UTC)", () => {
    expect(isoToEpoch("2026-05-30T00:00:00+00:00")).toBe(1780099200);
  });
  it("malformed input returns undefined", () => {
    expect(isoToEpoch("not a date")).toBeUndefined();
    expect(isoToEpoch("2026-99-99")).toBeUndefined();
  });
  it("empty input returns undefined", () => {
    expect(isoToEpoch("")).toBeUndefined();
  });
});

describe("formatAge", () => {
  const NOW = 1780099200;
  it("< 60s → 'just now'", () => {
    expect(formatAge(NOW - 0, NOW)).toBe("just now");
    expect(formatAge(NOW - 59, NOW)).toBe("just now");
  });
  it("< 1h → 'Nm ago'", () => {
    expect(formatAge(NOW - 60, NOW)).toBe("1m ago");
    expect(formatAge(NOW - 3599, NOW)).toBe("59m ago");
  });
  it("< 1d → 'Nh ago'", () => {
    expect(formatAge(NOW - 3600, NOW)).toBe("1h ago");
    expect(formatAge(NOW - 86399, NOW)).toBe("23h ago");
  });
  it(">= 1d → 'Nd ago'", () => {
    expect(formatAge(NOW - 86400, NOW)).toBe("1d ago");
    expect(formatAge(NOW - 7 * 86400, NOW)).toBe("7d ago");
  });
});
