import { describe, expect, it } from "vitest";

import { isValidSlug, slugify } from "../src/slug.js";

describe("slugify", () => {
  it("lowercases and collapses non-alphanumeric runs", () => {
    expect(slugify("HireFlow")).toBe("hireflow");
    expect(slugify("My Product 2")).toBe("my-product-2");
    expect(slugify("Foo --- Bar")).toBe("foo-bar");
    expect(slugify("hireflow")).toBe("hireflow");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("---foo---")).toBe("foo");
    expect(slugify("  spaces  ")).toBe("spaces");
  });

  it("is idempotent (slugify(slugify(x)) === slugify(x))", () => {
    for (const input of ["HireFlow", "My Product", "Foo Bar Baz"]) {
      expect(slugify(slugify(input))).toBe(slugify(input));
    }
  });
});

describe("isValidSlug", () => {
  it("accepts kebab-case starting with a letter and ending alphanumeric", () => {
    expect(isValidSlug("hireflow")).toBe(true);
    expect(isValidSlug("my-product-2")).toBe(true);
    expect(isValidSlug("ab")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
  });

  it("rejects slugs starting with a digit or hyphen", () => {
    expect(isValidSlug("2product")).toBe(false);
    expect(isValidSlug("-product")).toBe(false);
  });

  it("rejects slugs ending with a hyphen", () => {
    expect(isValidSlug("product-")).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(isValidSlug("")).toBe(false);
  });

  it("rejects slugs with uppercase or underscores", () => {
    expect(isValidSlug("Product")).toBe(false);
    expect(isValidSlug("my_product")).toBe(false);
  });

  it("rejects slugs longer than 40 chars", () => {
    expect(isValidSlug("a".repeat(40))).toBe(true);
    expect(isValidSlug("a".repeat(41))).toBe(false);
  });
});
