// Regression test for #392 — the content-binding diffHash MUST be invariant to
// `core.abbrev` (the repo-object-count-derived abbreviation length git embeds in
// `index <old>..<new>` patch lines). The hosted worker and the consumer CI run
// `commitDiff` from differently-shaped checkouts (full vs shallow clone), so an
// abbreviation-dependent diff made their diffHashes diverge and the
// consumer-evidence pointer never bound. `commitDiff` pins `--full-index`
// (full 40-char IDs) to make the diff — and thus diffHash — byte-identical
// across clone shapes. This test fails if `--full-index` is dropped.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { commitDiff, diffHash } from "../src/git.js";

function sh(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return String(r.stdout).trim();
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "df-diffhash-392-"));
  sh(root, ["init", "-q", "-b", "main"]);
  sh(root, ["config", "user.email", "t@t.com"]);
  sh(root, ["config", "user.name", "t"]);
  sh(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

function commit(root: string, file: string, content: string): string {
  writeFileSync(join(root, file), content);
  sh(root, ["add", "."]);
  sh(root, ["commit", "-q", "-m", file]);
  return sh(root, ["rev-parse", "HEAD"]);
}

describe("commitDiff diffHash is abbrev-invariant (#392)", () => {
  it("yields the SAME diffHash regardless of core.abbrev (full-index)", async () => {
    const root = initRepo();
    const parent = commit(root, "a.txt", "one\n");
    const head = commit(root, "a.txt", "one\ntwo\n");

    const hashAt = async (abbrev: string): Promise<string> => {
      sh(root, ["config", "core.abbrev", abbrev]);
      return diffHash(await commitDiff(parent, head, root));
    };

    const h4 = await hashAt("4");
    const h8 = await hashAt("8");
    const h40 = await hashAt("40");

    // Without --full-index these would differ (the `index aaaa..bbbb` line bytes
    // change with the abbreviation length). With it, all three are identical.
    expect(h8).toBe(h4);
    expect(h40).toBe(h4);
  });

  it("emits full 40-hex object ids in the index line", async () => {
    const root = initRepo();
    const parent = commit(root, "b.txt", "x\n");
    const head = commit(root, "b.txt", "x\ny\n");
    sh(root, ["config", "core.abbrev", "7"]); // would abbreviate without --full-index
    const diff = await commitDiff(parent, head, root);
    const indexLine = diff.split("\n").find((l) => l.startsWith("index "));
    expect(indexLine).toBeDefined();
    // index <40-hex>..<40-hex> <mode>
    expect(indexLine).toMatch(/^index [0-9a-f]{40}\.\.[0-9a-f]{40}/);
  });

  it("root-commit diff (no parent) also uses full-index", async () => {
    const root = initRepo();
    const head = commit(root, "c.txt", "root\n");
    sh(root, ["config", "core.abbrev", "7"]);
    const diff = await commitDiff("", head, root);
    const indexLine = diff.split("\n").find((l) => l.startsWith("index "));
    expect(indexLine).toBeDefined();
    expect(indexLine).toMatch(/[0-9a-f]{40}/);
  });
});
