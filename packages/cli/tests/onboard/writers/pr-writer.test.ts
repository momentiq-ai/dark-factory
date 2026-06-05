import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrMode, type SubprocessRunner } from "../../../src/onboard/writers/pr-writer.js";
import type { ScaffoldPlan } from "../../../src/onboard/scaffold-schema.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pr-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const PLAN: ScaffoldPlan = {
  schemaVersion: 1, sourceAnalysisSchemaVersion: 1,
  templateRef: "file:///t@0000000000000000000000000000000000000000",
  generatedAtIso: "2026-06-03T12:00:00.000Z",
  files: [{ path: "X.md", action: "emit", rationale: "x", tailored_content: "y\n" }],
  summary: "stub",
};

function fakeRunner(scripted: Record<string, { stdout?: string; stderr?: string; code?: number }>): SubprocessRunner {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    const matched = Object.keys(scripted).find((k) => key.startsWith(k));
    if (!matched) throw new Error(`unscripted subprocess call: ${key}`);
    const r = scripted[matched]!;
    if ((r.code ?? 0) !== 0) {
      const err: Error & { stdout?: string; stderr?: string; code?: number } = new Error(r.stderr ?? "failed");
      if (r.stdout !== undefined) err.stdout = r.stdout;
      if (r.stderr !== undefined) err.stderr = r.stderr;
      if (r.code !== undefined) err.code = r.code;
      throw err;
    }
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

describe("runPrMode — preflight", () => {
  it("rejects when gh auth status fails", async () => {
    const run = fakeRunner({
      "gh auth status": { code: 1, stderr: "not logged in" },
    });
    await expect(runPrMode(root, PLAN, "abcdef12", {
      run, canonicalName: "acme/widget", defaultBranch: "main",
    })).rejects.toThrow(/gh auth login|not logged in/);
  });

  it("accepts the `Logged in` banner when gh writes it ONLY on stderr", async () => {
    const run = fakeRunner({
      "gh auth status": { stderr: "Logged in to github.com account lyra", stdout: "" },
      "git status --porcelain": { stdout: "" },
      "git switch -c df/onboard-abcdef12": { stdout: "" },
      "git add -A": { stdout: "" },
      "git commit -m": { stdout: "" },
      "git push -u origin df/onboard-abcdef12": { stdout: "" },
      "gh pr create": { stdout: "https://github.com/acme/widget/pull/42\n" },
    });
    const r = await runPrMode(root, PLAN, "abcdef12", {
      run, canonicalName: "acme/widget", defaultBranch: "main",
    });
    expect(r.branch).toBe("df/onboard-abcdef12");
  });

  it("rejects when the working tree is dirty (regardless of current branch)", async () => {
    const run = fakeRunner({
      "gh auth status": { stdout: "Logged in to github.com account lyra" },
      "git status --porcelain": { stdout: " M src/foo.ts\n?? notes.txt\n" },
    });
    await expect(runPrMode(root, PLAN, "abcdef12", {
      run, canonicalName: "acme/widget", defaultBranch: "main",
    })).rejects.toThrow(/dirty working tree|commit or stash/i);
  });

  it("accepts a clean worktree on the default branch (no committing-onto-main block)", async () => {
    const run = fakeRunner({
      "gh auth status": { stdout: "Logged in to github.com account lyra" },
      "git status --porcelain": { stdout: "" },
      "git switch -c df/onboard-abcdef12": { stdout: "" },
      "git add -A": { stdout: "" },
      "git commit -m": { stdout: "" },
      "git push -u origin df/onboard-abcdef12": { stdout: "" },
      "gh pr create": { stdout: "https://github.com/acme/widget/pull/42\n" },
    });
    const r = await runPrMode(root, PLAN, "abcdef12", {
      run, canonicalName: "acme/widget", defaultBranch: "main",
    });
    expect(r.branch).toBe("df/onboard-abcdef12");
  });
});

describe("runPrMode — full flow", () => {
  it("creates branch, applies plan, commits, opens PR", async () => {
    const run = fakeRunner({
      "gh auth status": { stdout: "Logged in to github.com account lyra" },
      "git status --porcelain": { stdout: "" },
      "git switch -c df/onboard-abcdef12": { stdout: "" },
      "git add -A": { stdout: "" },
      "git commit -m": { stdout: "" },
      "git push -u origin df/onboard-abcdef12": { stdout: "" },
      "gh pr create": { stdout: "https://github.com/acme/widget/pull/42\n" },
    });
    const r = await runPrMode(root, PLAN, "abcdef12", {
      run, canonicalName: "acme/widget", defaultBranch: "main",
    });
    expect(r.branch).toBe("df/onboard-abcdef12");
    expect(r.prUrl).toBe("https://github.com/acme/widget/pull/42");
  });

  it("uses `git switch -C` when force=true so a stale df/onboard-<sha8> is recreated", async () => {
    const run = fakeRunner({
      "gh auth status": { stdout: "Logged in to github.com account lyra" },
      "git status --porcelain": { stdout: "" },
      "git switch -C df/onboard-abcdef12": { stdout: "" },
      "git add -A": { stdout: "" },
      "git commit -m": { stdout: "" },
      "git push -u origin df/onboard-abcdef12": { stdout: "" },
      "gh pr create": { stdout: "https://github.com/acme/widget/pull/42\n" },
    });
    const r = await runPrMode(root, PLAN, "abcdef12", {
      run, canonicalName: "acme/widget", defaultBranch: "main", force: true,
    });
    expect(r.branch).toBe("df/onboard-abcdef12");
  });

  it("uses `gh pr create --base <defaultBranch>` from the passed-in value (not git symbolic-ref)", async () => {
    let capturedBase: string | null = null;
    const run: SubprocessRunner = async (cmd, args) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key.startsWith("gh pr create")) {
        const baseIdx = args.indexOf("--base");
        capturedBase = baseIdx >= 0 ? (args[baseIdx + 1] ?? null) : null;
        return { stdout: "https://github.com/acme/widget/pull/42\n", stderr: "" };
      }
      if (key.startsWith("gh auth status")) return { stdout: "Logged in to github.com account lyra", stderr: "" };
      if (key.startsWith("git status --porcelain")) return { stdout: "", stderr: "" };
      if (key.startsWith("git symbolic-ref")) throw new Error("must NOT call git symbolic-ref — defaultBranch is passed in");
      return { stdout: "", stderr: "" };
    };
    await runPrMode(root, PLAN, "abcdef12", {
      run, canonicalName: "acme/widget", defaultBranch: "trunk",
    });
    expect(capturedBase).toBe("trunk");
  });

  it("falls back to \"main\" + warns when defaultBranch is empty (DFP #262 belt-and-braces)", async () => {
    let capturedBase: string | null = null;
    const stderrLines: string[] = [];
    const run: SubprocessRunner = async (cmd, args) => {
      const key = `${cmd} ${args.join(" ")}`;
      if (key.startsWith("gh pr create")) {
        const baseIdx = args.indexOf("--base");
        capturedBase = baseIdx >= 0 ? (args[baseIdx + 1] ?? null) : null;
        return { stdout: "https://github.com/acme/widget/pull/42\n", stderr: "" };
      }
      if (key.startsWith("gh auth status")) return { stdout: "Logged in to github.com account lyra", stderr: "" };
      if (key.startsWith("git status --porcelain")) return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    await runPrMode(root, PLAN, "abcdef12", {
      run, canonicalName: "acme/widget", defaultBranch: "",
    }, (s) => stderrLines.push(s));
    expect(capturedBase).toBe("main");
    expect(stderrLines.join("")).toMatch(/defaultBranch.*empty.*main/i);
    expect(stderrLines.join("")).toContain("dark-factory-platform/issues/262");
  });

  it("propagates a ScaffoldApplyError (no commit, no PR) when applyPlan fails mid-loop", async () => {
    await writeFile(join(root, "X.md"), "x");
    const run = fakeRunner({
      "gh auth status": { stdout: "Logged in to github.com account lyra" },
      "git status --porcelain": { stdout: "" },
      "git switch -c df/onboard-abcdef12": { stdout: "" },
    });
    await expect(runPrMode(root, PLAN, "abcdef12", {
      run, canonicalName: "acme/widget", defaultBranch: "main",
    })).rejects.toThrow(/refuses to overwrite|ScaffoldApplyError|write failed/);
  });
});
