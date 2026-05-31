/**
 * Derive a kebab-case slug from a product name, matching the convention
 * used in `momentiq-ai/sage-blueprint`'s copier.yaml `product_slug`
 * derivation. Lowercases, replaces non-alphanumeric runs with a single
 * hyphen, trims leading/trailing hyphens. Idempotent.
 *
 *   slugify("HireFlow")     === "hireflow"
 *   slugify("My Product 2") === "my-product-2"
 *   slugify("Foo --- Bar")  === "foo-bar"
 *   slugify("hireflow")     === "hireflow"
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Validate a slug looks like a valid GCP project / Doppler project /
 * Temporal namespace identifier — kebab-case, 1-40 chars, starts with
 * a letter, ends alphanumeric.
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(slug) || /^[a-z]$/.test(slug);
}
