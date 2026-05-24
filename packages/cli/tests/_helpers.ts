import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_DIRNAME = dirname(fileURLToPath(import.meta.url));

// Fixtures live in `packages/cli/tests/fixtures/<name>`. The sage3c source
// used a `../../tests/fixtures/<name>` path because the tests directory was
// part of a polyglot worktree; here the path is simpler.
export function fixturePath(name: string): string {
  return resolve(TEST_DIRNAME, "fixtures", name);
}
