import { defineConfig } from "vitest/config";

// Scope vitest to our own tests/ dir. The `template/` directory contains
// the scaffolded sage-blueprint source (which itself has React component
// tests using @testing-library/react etc.); those are tests for the
// SCAFFOLDED PRODUCT, not for this CLI wrapper, so vitest must NOT
// discover them here.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", "template"],
  },
});
