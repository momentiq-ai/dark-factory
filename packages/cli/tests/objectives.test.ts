import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeCriterion } from "@momentiq/dark-factory-schemas";
import { cmdObjectives, parseObjectivesArgs } from "../src/commands/objectives.js";

// Helper: capture stdout/stderr from cmdObjectives
function makeIo(): { stdout: string; stderr: string; io: { stdout: (s: string) => void; stderr: (s: string) => void } } {
  let stdout = "";
  let stderr = "";
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    io: {
      stdout: (s) => { stdout += s; },
      stderr: (s) => { stderr += s; },
    },
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(canonicalizeCriterion(text), "utf8").digest("hex");
}

describe("df objectives hash", () => {
  it("prints the correct sha256 digest of a criterion text and returns 0", async () => {
    const cap = makeIo();
    const code = await cmdObjectives(["hash", "--text", "- **EC1**: Foo bar"], cap.io);
    expect(code).toBe(0);
    const expected = sha256("- **EC1**: Foo bar");
    expect(cap.stdout.trim()).toBe(expected);
    expect(cap.stderr).toBe("");
  });

  it("handles a plain text criterion without list markers", async () => {
    const text = "All routes return 200 under load";
    const cap = makeIo();
    const code = await cmdObjectives(["hash", "--text", text], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.trim()).toBe(sha256(text));
  });

  it("handles --text= form (equals-joined)", async () => {
    const text = "- EC2: Panel renders correctly";
    const cap = makeIo();
    const code = await cmdObjectives(["hash", `--text=${text}`], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout.trim()).toBe(sha256(text));
  });

  it("returns 2 when --text is missing", async () => {
    const cap = makeIo();
    const code = await cmdObjectives(["hash"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr).toContain("--text is required");
    expect(cap.stderr).toContain("df objectives");
  });

  it("returns 2 for unknown flags", async () => {
    const cap = makeIo();
    const code = await cmdObjectives(["hash", "--text", "x", "--unknown-flag"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr).toContain("unknown flag");
  });

  it("returns 2 with a 'not yet implemented' error for --locator", async () => {
    const cap = makeIo();
    const code = await cmdObjectives(["hash", "--locator", "exit_criteria#ec1"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr).toContain("not yet implemented");
    expect(cap.stderr).toContain("--text");
  });

  it("returns 2 with a 'not yet implemented' error for --cycle", async () => {
    const cap = makeIo();
    const code = await cmdObjectives(["hash", "--cycle", "23"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr).toContain("not yet implemented");
    expect(cap.stderr).toContain("--text");
  });
});

describe("df objectives — missing or unknown subcommand", () => {
  it("prints help and returns 2 when no subcommand is given", async () => {
    const cap = makeIo();
    const code = await cmdObjectives([], cap.io);
    expect(code).toBe(2);
    expect(cap.stdout).toContain("df objectives");
    expect(cap.stdout).toContain("Usage:");
  });

  it("returns 2 for an unknown subcommand", async () => {
    const cap = makeIo();
    const code = await cmdObjectives(["unknown-sub"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr).toContain("unknown subcommand");
  });

  it("prints help and returns 0 for --help", async () => {
    const cap = makeIo();
    const code = await cmdObjectives(["--help"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout).toContain("df objectives");
    expect(cap.stdout).toContain("hash");
  });

  it("prints help and returns 0 for -h", async () => {
    const cap = makeIo();
    const code = await cmdObjectives(["-h"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout).toContain("df objectives");
  });
});

describe("parseObjectivesArgs — unit", () => {
  it("returns subcommand: undefined for empty args", () => {
    const result = parseObjectivesArgs([]);
    expect(result).toEqual({ subcommand: undefined });
  });

  it("returns hash options when --text is provided", () => {
    const result = parseObjectivesArgs(["hash", "--text", "my criterion"]);
    expect(result).toEqual({ subcommand: "hash", text: "my criterion" });
  });

  it("returns error for hash without --text", () => {
    const result = parseObjectivesArgs(["hash"]);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("--text is required");
  });

  it("returns error for unknown subcommand", () => {
    const result = parseObjectivesArgs(["bogus"]);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("unknown subcommand");
  });
});
