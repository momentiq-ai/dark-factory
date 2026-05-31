import { describe, it, expect } from "vitest";
import { requireIssueNumber, requireSafeArgs } from "../../src/handoff/args.js";

describe("args — requireIssueNumber", () => {
  it("returns the number for valid positive integer string", () => {
    expect(requireIssueNumber("42")).toBe(42);
    expect(requireIssueNumber("1")).toBe(1);
    expect(requireIssueNumber("999999")).toBe(999999);
  });
  it("returns undefined for undefined (allowed — empty arg path)", () => {
    expect(requireIssueNumber(undefined)).toBeUndefined();
    expect(requireIssueNumber("")).toBeUndefined();
  });
  it("throws on 0 (rejected per bash require_issue_number)", () => {
    expect(() => requireIssueNumber("0")).toThrow(/positive integer/);
  });
  it("throws on leading-zero", () => {
    expect(() => requireIssueNumber("042")).toThrow(/positive integer/);
  });
  it("throws on non-numeric", () => {
    expect(() => requireIssueNumber("42abc")).toThrow(/positive integer/);
    expect(() => requireIssueNumber("abc")).toThrow(/positive integer/);
    expect(() => requireIssueNumber("42; rm -rf")).toThrow(/positive integer/);
  });
  it("throws on negative", () => {
    expect(() => requireIssueNumber("-42")).toThrow(/positive integer/);
  });
  it("throws on whitespace-padded numerics (strict — bash regex requires bare digits)", () => {
    expect(() => requireIssueNumber(" 42")).toThrow(/positive integer/);
    expect(() => requireIssueNumber("42 ")).toThrow(/positive integer/);
  });
});

describe("args — requireSafeArgs (defense-in-depth allow-list)", () => {
  it("accepts numbers and refs", () => {
    expect(() => requireSafeArgs(["42"])).not.toThrow();
    expect(() => requireSafeArgs(["momentiq-ai/dark-factory#59"])).not.toThrow();
    expect(() => requireSafeArgs(["--link", "103"])).not.toThrow();
  });
  it("accepts URL refs with query strings (?, =, %, +, ~)", () => {
    expect(() =>
      requireSafeArgs(["--link", "https://github.com/m/r/pull/103?tab=files"]),
    ).not.toThrow();
  });
  it("accepts empty arg list (no-op)", () => {
    expect(() => requireSafeArgs([])).not.toThrow();
  });
  it("accepts space-containing args (whitespace is in the allow-list)", () => {
    // Bash impl includes space in the allow-list — used after .md ARGUMENTS
    // tokenization, but TS may pass already-split argv with spaces.
    expect(() => requireSafeArgs(["42 --link 103"])).not.toThrow();
  });
  it("refuses semicolons", () => {
    expect(() => requireSafeArgs(["42; echo PWNED"])).toThrow(/disallowed characters/);
  });
  it("refuses $() / backticks", () => {
    expect(() => requireSafeArgs(["$(echo PWNED)"])).toThrow(/disallowed characters/);
    expect(() => requireSafeArgs(["`echo PWNED`"])).toThrow(/disallowed characters/);
  });
  it("refuses redirects", () => {
    expect(() => requireSafeArgs(["42 > /tmp/pwn"])).toThrow(/disallowed characters/);
    expect(() => requireSafeArgs(["42 < /tmp/pwn"])).toThrow(/disallowed characters/);
  });
  it("refuses pipes", () => {
    expect(() => requireSafeArgs(["42 | rm -rf"])).toThrow(/disallowed characters/);
  });
  it("refuses single quotes (not in bash allow-list)", () => {
    expect(() => requireSafeArgs(["it's"])).toThrow(/disallowed characters/);
  });
  it("refuses brackets (not in bash allow-list)", () => {
    expect(() => requireSafeArgs(["[42]"])).toThrow(/disallowed characters/);
  });
  it("refuses bang (history expansion in bash)", () => {
    expect(() => requireSafeArgs(["!42"])).toThrow(/disallowed characters/);
  });
});

// Structural edges
describe("args — structural edges", () => {
  it("requireIssueNumber on string '00' rejects (leading zero)", () => {
    expect(() => requireIssueNumber("00")).toThrow(/positive integer/);
  });
  it("requireIssueNumber on very large number works", () => {
    expect(requireIssueNumber("9999999999")).toBe(9999999999);
  });
  it("requireSafeArgs error message matches bash wording", () => {
    try {
      requireSafeArgs(["42; rm"]);
      throw new Error("should have thrown");
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(msg).toContain("disallowed characters");
      expect(msg).toContain("refusing for safety");
      expect(msg).toContain("alphanumeric");
    }
  });
});
