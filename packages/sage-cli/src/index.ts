/**
 * Library entry point — minimal surface intended for programmatic use
 * (e.g. wrapping `sage create` from another tool). The supported public
 * API is the `sage` bin; this module is a stable side door for narrow
 * automation cases.
 */

export { runInit } from "./commands/init.js";
export type { InitOptions } from "./commands/init.js";
export { runUpdate } from "./commands/update.js";
export type { UpdateOptions } from "./commands/update.js";
export { getBundledTemplatePath, getBundleInfo } from "./template-resolver.js";
export type { BundleInfo } from "./template-resolver.js";
export { renderVersionBanner } from "./version.js";
export { slugify, isValidSlug } from "./slug.js";
