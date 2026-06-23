import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeCriterion,
  parseObjectivesManifest,
} from "@momentiq/dark-factory-schemas";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  cmdObjectives,
  extractExitCriteria,
  parseObjectivesArgs,
} from "../src/commands/objectives.js";

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

// ---------------------------------------------------------------------------
// extractExitCriteria — the hash-consistency core.
// ---------------------------------------------------------------------------

describe("extractExitCriteria — id assignment + text extraction", () => {
  it("uses positional ids + strips a leading EC<k> token for backtick-no-separator items", () => {
    // Mirrors the plan's Task 5 Step 1 fixture: a backtick-wrapped label with NO
    // separator does NOT label-match in the validator, so it resolves
    // positionally (ec1, ec2) — and the display text drops the EC token.
    const body = "- `EC1` Route table populated.\n- `EC2` Panel renders.";
    expect(extractExitCriteria(body).map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "ec1", text: "Route table populated." },
      { id: "ec2", text: "Panel renders." },
    ]);
  });

  it("reads an explicit EC<k> label (with separator) and strips it from the text", () => {
    const body = "- **EC1**: Route table populated.\n- **EC2**: Panel renders.";
    expect(extractExitCriteria(body).map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "ec1", text: "Route table populated." },
      { id: "ec2", text: "Panel renders." },
    ]);
  });

  it("falls back to positional ids when items carry no EC<k> label", () => {
    const body = "- Route table populated.\n- Panel renders.";
    expect(extractExitCriteria(body).map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "ec1", text: "Route table populated." },
      { id: "ec2", text: "Panel renders." },
    ]);
  });

  it("honors out-of-order EC labels (label match, not position)", () => {
    // The validator resolves `ec1`/`ec2` by label match first, so an out-of-order
    // doc must assign ids by the item's OWN label, not its position.
    const body = "- **EC2**: Second criterion.\n- **EC1**: First criterion.";
    expect(extractExitCriteria(body).map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "ec2", text: "Second criterion." },
      { id: "ec1", text: "First criterion." },
    ]);
  });

  it("retains the verbatim raw line as the hash input (full marker + label)", () => {
    const body = "- **EC1**: Route table populated.";
    const [c] = extractExitCriteria(body);
    expect(c?.raw).toBe("- **EC1**: Route table populated.");
    // The hash input is the raw line; canonicalizeCriterion strips the marker +
    // label itself, so feeding the raw line is what matches the validator.
    expect(canonicalizeCriterion(c!.raw)).toBe("Route table populated.");
  });

  it("enumerates numbered (N.) and star (*) markers identically to the validator", () => {
    const body = "1. First numbered.\n* Star bullet.\n- Dash bullet.";
    expect(extractExitCriteria(body).map((c) => c.id)).toEqual(["ec1", "ec2", "ec3"]);
  });

  it("ignores non-list lines (prose, blank lines, headings) between items", () => {
    const body = [
      "Some intro prose.",
      "",
      "- `EC1` First.",
      "",
      "More prose explaining a thing.",
      "- `EC2` Second.",
    ].join("\n");
    expect(extractExitCriteria(body).map((c) => c.id)).toEqual(["ec1", "ec2"]);
  });
});

// ---------------------------------------------------------------------------
// df objectives derive — manifest generation from a cycle doc.
// ---------------------------------------------------------------------------

describe("df objectives derive", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  // Build a throwaway repo with `docs/roadmap/cycles/cycle<N>-<slug>.md`.
  function fixtureRepo(cycleNum: string, exitCriteriaBody: string): string {
    const root = mkdtempSync(join(tmpdir(), "df-objectives-derive-"));
    tmpDirs.push(root);
    const cyclesDir = join(root, "docs", "roadmap", "cycles");
    mkdirSync(cyclesDir, { recursive: true });
    const doc = [
      "---",
      `title: Cycle ${cycleNum} — fixture`,
      "status: active",
      "---",
      "",
      `# Cycle ${cycleNum} — fixture`,
      "",
      "## Scope",
      "",
      "Some scope prose.",
      "",
      "## Exit criteria",
      "",
      exitCriteriaBody,
      "",
      "## Risks",
      "",
      "None.",
      "",
    ].join("\n");
    writeFileSync(join(cyclesDir, `cycle${cycleNum}-fixture.md`), doc, "utf8");
    return root;
  }

  function sha256OfCriterion(rawLine: string): string {
    return createHash("sha256")
      .update(canonicalizeCriterion(rawLine), "utf8")
      .digest("hex");
  }

  it("emits N objectives with correct ids, locators, and validator-matching sha256", async () => {
    const ecBody = "- `EC1` Route table populated.\n- `EC2` Panel renders.";
    const root = fixtureRepo("23", ecBody);
    const cap = makeIo();

    const code = await cmdObjectives(["derive", "--cycle", "23", "--cwd", root], cap.io);
    expect(code).toBe(0);
    expect(cap.stderr).toBe("");

    // Round-trips through the schema parser to exactly 2 objectives.
    const manifest = parseObjectivesManifest(yamlParse(cap.stdout));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.objectives).toHaveLength(2);

    const [o1, o2] = manifest.objectives;
    expect(o1?.id).toBe("cycle23#ec1");
    expect(o1?.source).toEqual({ kind: "cycle", ref: "23" });
    expect(o1?.attestedBy).toEqual([]);
    expect(o1?.enforced).toBe(false);
    expect(o1?.text).toBe("Route table populated.");
    expect(o1?.sourceCriterion).toEqual({
      kind: "text-hash",
      locator: "exit_criteria#ec1",
      sha256: sha256OfCriterion("- `EC1` Route table populated."),
    });

    expect(o2?.id).toBe("cycle23#ec2");
    expect(o2?.sourceCriterion).toEqual({
      kind: "text-hash",
      locator: "exit_criteria#ec2",
      sha256: sha256OfCriterion("- `EC2` Panel renders."),
    });
  });

  it("--apply writes .darkfactory/objectives.yaml that round-trips", async () => {
    const ecBody = "- **EC1**: First.\n- **EC2**: Second.";
    const root = fixtureRepo("7", ecBody);
    const cap = makeIo();

    const code = await cmdObjectives(["derive", "--cycle", "7", "--cwd", root, "--apply"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout).toContain("Wrote 2 objectives");

    const written = readFileSync(join(root, ".darkfactory", "objectives.yaml"), "utf8");
    const manifest = parseObjectivesManifest(yamlParse(written));
    expect(manifest.objectives.map((o) => o.id)).toEqual(["cycle7#ec1", "cycle7#ec2"]);
    expect(manifest.objectives[0]?.sourceCriterion).toEqual({
      kind: "text-hash",
      locator: "exit_criteria#ec1",
      sha256: sha256OfCriterion("- **EC1**: First."),
    });
  });

  it("accepts a 'cycle23' style --cycle value (normalizes to the bare number)", async () => {
    const root = fixtureRepo("23", "- `EC1` Only one.");
    const cap = makeIo();
    const code = await cmdObjectives(["derive", "--cycle", "cycle23", "--cwd", root], cap.io);
    expect(code).toBe(0);
    const manifest = parseObjectivesManifest(yamlParse(cap.stdout));
    expect(manifest.objectives[0]?.id).toBe("cycle23#ec1");
    expect(manifest.objectives[0]?.source).toEqual({ kind: "cycle", ref: "23" });
  });

  it("--json emits the manifest object as JSON that round-trips", async () => {
    const root = fixtureRepo("9", "- `EC1` A.\n- `EC2` B.");
    const cap = makeIo();
    const code = await cmdObjectives(["derive", "--cycle", "9", "--cwd", root, "--json"], cap.io);
    expect(code).toBe(0);
    const manifest = parseObjectivesManifest(JSON.parse(cap.stdout));
    expect(manifest.objectives).toHaveLength(2);
    expect(manifest.objectives.map((o) => o.id)).toEqual(["cycle9#ec1", "cycle9#ec2"]);
  });

  describe("idempotence", () => {
    it("preserves a hand-added attestedBy binding by objective id on re-derive", async () => {
      const ecBody = "- `EC1` First.\n- `EC2` Second.";
      const root = fixtureRepo("23", ecBody);

      // First derive → write the manifest.
      const cap1 = makeIo();
      expect(await cmdObjectives(["derive", "--cycle", "23", "--cwd", root, "--apply"], cap1.io)).toBe(0);

      // Hand-edit: bind ec1 to a route (what an agent would author).
      const manifestPath = join(root, ".darkfactory", "objectives.yaml");
      const edited = parseObjectivesManifest(yamlParse(readFileSync(manifestPath, "utf8")));
      const o1 = edited.objectives.find((o) => o.id === "cycle23#ec1")!;
      o1.attestedBy = [{ kind: "route", routeId: "playwright-smoke" }];
      writeFileSync(manifestPath, yamlStringify(edited), "utf8");

      // Re-derive → ec1's hand binding survives; ec2 stays empty.
      const cap2 = makeIo();
      expect(await cmdObjectives(["derive", "--cycle", "23", "--cwd", root, "--apply"], cap2.io)).toBe(0);
      const reread = parseObjectivesManifest(yamlParse(readFileSync(manifestPath, "utf8")));
      expect(reread.objectives.find((o) => o.id === "cycle23#ec1")?.attestedBy).toEqual([
        { kind: "route", routeId: "playwright-smoke" },
      ]);
      expect(reread.objectives.find((o) => o.id === "cycle23#ec2")?.attestedBy).toEqual([]);
    });

    it("reconciles added/removed criteria while preserving surviving bindings", async () => {
      const root = fixtureRepo("23", "- `EC1` First.\n- `EC2` Second.");
      const manifestPath = join(root, ".darkfactory", "objectives.yaml");

      const cap1 = makeIo();
      expect(await cmdObjectives(["derive", "--cycle", "23", "--cwd", root, "--apply"], cap1.io)).toBe(0);
      const m1 = parseObjectivesManifest(yamlParse(readFileSync(manifestPath, "utf8")));
      m1.objectives.find((o) => o.id === "cycle23#ec1")!.attestedBy = [
        { kind: "critic", criticId: "codex" },
      ];
      writeFileSync(manifestPath, yamlStringify(m1), "utf8");

      // Cycle doc grows a 3rd criterion; re-derive against the NEW doc.
      const cyclesDir = join(root, "docs", "roadmap", "cycles");
      writeFileSync(
        join(cyclesDir, "cycle23-fixture.md"),
        ["---", "title: t", "status: active", "---", "", "## Exit criteria", "",
          "- `EC1` First.\n- `EC2` Second.\n- `EC3` Third.", ""].join("\n"),
        "utf8",
      );
      const cap2 = makeIo();
      expect(await cmdObjectives(["derive", "--cycle", "23", "--cwd", root, "--apply"], cap2.io)).toBe(0);
      const m2 = parseObjectivesManifest(yamlParse(readFileSync(manifestPath, "utf8")));
      expect(m2.objectives.map((o) => o.id)).toEqual(["cycle23#ec1", "cycle23#ec2", "cycle23#ec3"]);
      expect(m2.objectives.find((o) => o.id === "cycle23#ec1")?.attestedBy).toEqual([
        { kind: "critic", criticId: "codex" },
      ]);
    });
  });

  it("returns exit 1 when the cycle doc is not found", async () => {
    const root = fixtureRepo("23", "- `EC1` Present.");
    const cap = makeIo();
    const code = await cmdObjectives(["derive", "--cycle", "999", "--cwd", root], cap.io);
    expect(code).toBe(1);
    expect(cap.stderr).toContain("cycle999");
    expect(cap.stderr).toContain("not found");
  });

  it("returns exit 1 when the cycle doc has no Exit criteria section", async () => {
    const root = mkdtempSync(join(tmpdir(), "df-objectives-derive-"));
    tmpDirs.push(root);
    const cyclesDir = join(root, "docs", "roadmap", "cycles");
    mkdirSync(cyclesDir, { recursive: true });
    writeFileSync(
      join(cyclesDir, "cycle5-fixture.md"),
      ["---", "title: t", "status: active", "---", "", "## Scope", "", "Only scope.", ""].join("\n"),
      "utf8",
    );
    const cap = makeIo();
    const code = await cmdObjectives(["derive", "--cycle", "5", "--cwd", root], cap.io);
    expect(code).toBe(1);
    expect(cap.stderr).toContain("Exit criteria");
  });

  it("returns exit 2 for usage errors (missing --cycle)", async () => {
    const cap = makeIo();
    const code = await cmdObjectives(["derive"], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr).toContain("--cycle is required");
  });
});
