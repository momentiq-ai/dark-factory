import { describe, it, expect } from "vitest";
import {
  assigneesStatus,
  assigneesOtherCsv,
  MeLoginCache,
  type ClaimStatus,
} from "../../src/handoff/assignees.js";
import type { GhClient } from "../../src/handoff/ports.js";

describe("assigneesStatus", () => {
  it("empty array → 'empty'", () => {
    expect(assigneesStatus([], "alien8d")).toBe<ClaimStatus>("empty");
  });
  it("[@me] → 'me'", () => {
    expect(assigneesStatus([{ login: "alien8d" }], "alien8d")).toBe<ClaimStatus>("me");
  });
  it("[@other] → 'other'", () => {
    expect(assigneesStatus([{ login: "other" }], "alien8d")).toBe<ClaimStatus>("other");
  });
  it("[@me, @other] (multi-assignee abort path) → 'other'", () => {
    expect(
      assigneesStatus([{ login: "alien8d" }, { login: "other" }], "alien8d"),
    ).toBe<ClaimStatus>("other");
  });
  it("[@me] duplicated → 'other' (cardinality must be 1 for 'me')", () => {
    // Defensive: if GitHub ever returned a dup, multi-assignee path applies.
    expect(
      assigneesStatus([{ login: "alien8d" }, { login: "alien8d" }], "alien8d"),
    ).toBe<ClaimStatus>("other");
  });
});

describe("assigneesOtherCsv", () => {
  it("filters @me, joins others by comma", () => {
    expect(
      assigneesOtherCsv([{ login: "alien8d" }, { login: "x" }, { login: "y" }], "alien8d"),
    ).toBe("x,y");
  });
  it("empty list → empty string", () => {
    expect(assigneesOtherCsv([], "alien8d")).toBe("");
  });
  it("only @me → empty string", () => {
    expect(assigneesOtherCsv([{ login: "alien8d" }], "alien8d")).toBe("");
  });
  it("preserves order of others (no sort)", () => {
    expect(
      assigneesOtherCsv([{ login: "z" }, { login: "alien8d" }, { login: "a" }], "alien8d"),
    ).toBe("z,a");
  });
});

describe("MeLoginCache", () => {
  it("caches result of first call", async () => {
    let calls = 0;
    const gh: Partial<GhClient> = {
      apiUserLogin: async () => {
        calls++;
        return "alien8d";
      },
    };
    const cache = new MeLoginCache();
    expect(await cache.resolve(gh as GhClient)).toBe("alien8d");
    expect(await cache.resolve(gh as GhClient)).toBe("alien8d");
    expect(calls).toBe(1);
  });
  it("propagates errors from gh", async () => {
    const gh: Partial<GhClient> = {
      apiUserLogin: async () => {
        throw new Error("gh api user failed");
      },
    };
    const cache = new MeLoginCache();
    await expect(cache.resolve(gh as GhClient)).rejects.toThrow(/gh api user failed/);
  });
});
