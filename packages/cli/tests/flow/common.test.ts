import { describe, expect, it } from "vitest";
import {
  DEFAULT_TENANT,
  dateInRange,
  formatYmd,
  parseDateRange,
  parseYmd,
  resolveTenant,
  tenantBasePath,
  weekStartMondayUtc,
} from "../../src/commands/flow/common.js";

describe("flow/common — resolveTenant", () => {
  it("returns the default when flag undefined", () => {
    expect(resolveTenant(undefined)).toBe(DEFAULT_TENANT);
  });
  it("returns the default when flag is boolean true (bare --tenant)", () => {
    expect(resolveTenant(true)).toBe(DEFAULT_TENANT);
  });
  it("accepts a valid slug", () => {
    expect(resolveTenant("sage3c")).toBe("sage3c");
    expect(resolveTenant("acme-co-1")).toBe("acme-co-1");
  });
  it("rejects empty string", () => {
    expect(() => resolveTenant("")).toThrow(/non-empty/);
  });
  it("rejects path-traversal shapes", () => {
    expect(() => resolveTenant("../foo")).toThrow(/not a valid slug/);
    expect(() => resolveTenant("foo/bar")).toThrow(/not a valid slug/);
    expect(() => resolveTenant(".hidden")).toThrow(/not a valid slug/);
  });
  it("rejects uppercase and special chars", () => {
    expect(() => resolveTenant("SAGE")).toThrow(/not a valid slug/);
    expect(() => resolveTenant("sage_3c")).toThrow(/not a valid slug/);
  });
  it("rejects slugs over 63 chars", () => {
    expect(() => resolveTenant("a".repeat(64))).toThrow(/not a valid slug/);
  });
});

describe("flow/common — tenantBasePath", () => {
  it("interpolates the slug", () => {
    expect(tenantBasePath("sage3c")).toBe("store/tenant/sage3c");
  });
});

describe("flow/common — parseYmd", () => {
  it("parses a valid YMD to UTC midnight", () => {
    const d = parseYmd("2026-05-01");
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
  it("rejects malformed strings", () => {
    expect(parseYmd("2026-5-1")).toBeNull();
    expect(parseYmd("not-a-date")).toBeNull();
    expect(parseYmd("2026/05/01")).toBeNull();
  });
  it("rejects calendar-invalid dates (Feb 30, month 13)", () => {
    expect(parseYmd("2026-02-30")).toBeNull();
    expect(parseYmd("2026-13-01")).toBeNull();
  });
});

describe("flow/common — parseDateRange", () => {
  it("returns empty range when no flags", () => {
    const r = parseDateRange({});
    expect(r.error).toBeUndefined();
    expect(r.range.from).toBeNull();
    expect(r.range.to).toBeNull();
  });
  it("parses --from + --to", () => {
    const r = parseDateRange({ from: "2026-05-01", to: "2026-05-31" });
    expect(r.error).toBeUndefined();
    expect(r.range.from?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(r.range.to?.toISOString()).toBe("2026-05-31T00:00:00.000Z");
  });
  it("surfaces malformed --from", () => {
    const r = parseDateRange({ from: "garbage" });
    expect(r.error).toMatch(/--from "garbage" is not a YYYY-MM-DD/);
  });
  it("rejects from > to", () => {
    const r = parseDateRange({ from: "2026-06-01", to: "2026-05-01" });
    expect(r.error).toMatch(/--from must be on or before --to/);
  });
  it("rejects a bare --from (boolean true, no value)", () => {
    // parseFlags surfaces a bare `--from` as `true`. Silently dropping
    // it would mask operator intent; this test pins the attributable error.
    const r = parseDateRange({ from: true });
    expect(r.error).toMatch(/--from requires a YYYY-MM-DD value/);
  });
  it("rejects a bare --to (boolean true, no value)", () => {
    const r = parseDateRange({ to: true });
    expect(r.error).toMatch(/--to requires a YYYY-MM-DD value/);
  });
});

describe("flow/common — dateInRange", () => {
  const range = parseDateRange({ from: "2026-05-01", to: "2026-05-31" }).range;
  it("includes the first second of from", () => {
    expect(dateInRange("2026-05-01T00:00:00Z", range)).toBe(true);
  });
  it("includes the last second of to", () => {
    expect(dateInRange("2026-05-31T23:59:59Z", range)).toBe(true);
  });
  it("excludes one second past to", () => {
    expect(dateInRange("2026-06-01T00:00:00Z", range)).toBe(false);
  });
  it("treats malformed iso as out of range", () => {
    expect(dateInRange("not-an-iso", range)).toBe(false);
  });
  it("open-ended range includes everything", () => {
    const open = parseDateRange({}).range;
    expect(dateInRange("1999-01-01T00:00:00Z", open)).toBe(true);
    expect(dateInRange("2099-12-31T23:59:59Z", open)).toBe(true);
  });
});

describe("flow/common — weekStartMondayUtc", () => {
  it("a Monday returns itself", () => {
    expect(weekStartMondayUtc("2026-05-04T12:00:00Z")).toBe("2026-05-04");
  });
  it("a Tuesday rolls back one day", () => {
    expect(weekStartMondayUtc("2026-05-05T12:00:00Z")).toBe("2026-05-04");
  });
  it("a Sunday rolls back six days", () => {
    expect(weekStartMondayUtc("2026-05-10T12:00:00Z")).toBe("2026-05-04");
  });
  it("malformed iso returns null", () => {
    expect(weekStartMondayUtc("garbage")).toBeNull();
  });
});

describe("flow/common — formatYmd", () => {
  it("pads single-digit months and days", () => {
    expect(formatYmd(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-01-05");
  });
});
