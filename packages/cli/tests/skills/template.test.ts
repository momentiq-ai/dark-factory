// Unit tests for the skill template renderer.
//
// Pins:
//  - {{VAR}} substitution; {VAR} (single-brace, runtime var) is NOT touched.
//  - Undeclared variables raise (catches typos).
//  - `kind: "list"` accepts array overrides; scalar variables reject arrays.
//  - Default value is used when no override is supplied.

import { describe, expect, it } from "vitest";

import {
  extractReferencedVariables,
  renderTemplateBody,
  type SkillManifest,
} from "../../src/skills/template.js";

function manifest(overrides?: Partial<SkillManifest>): SkillManifest {
  return {
    name: "test-skill",
    version: "1.0.0",
    summary: "test",
    files: [{ template: "SKILL.md.tmpl", target: "SKILL.md" }],
    variables: {
      REPO_NAME: { description: "", default: "default-repo" },
      ADR_DIR: { description: "", default: "docs/ADR" },
      QUALITY_GATE_TARGETS: {
        description: "",
        default: "make quality-gates",
        kind: "list",
      },
    },
    ...overrides,
  };
}

describe("renderTemplateBody", () => {
  it("substitutes {{VAR}} with the consumer override", () => {
    const out = renderTemplateBody("Hello {{REPO_NAME}}!", {
      manifest: manifest(),
      overrides: { REPO_NAME: "Dark Factory" },
    });
    expect(out.body).toBe("Hello Dark Factory!");
    expect(out.substituted).toEqual([
      { name: "REPO_NAME", value: "Dark Factory" },
    ]);
  });

  it("falls back to the manifest default when no override is supplied", () => {
    const out = renderTemplateBody("Hello {{REPO_NAME}}!", {
      manifest: manifest(),
      overrides: {},
    });
    expect(out.body).toBe("Hello default-repo!");
  });

  it("does NOT touch single-brace {VAR} (runtime delimiter)", () => {
    const out = renderTemplateBody(
      "Path: {{ADR_DIR}}. Agent var: {PR_NUMBER}",
      { manifest: manifest(), overrides: { ADR_DIR: "docs/decisions" } },
    );
    expect(out.body).toBe("Path: docs/decisions. Agent var: {PR_NUMBER}");
  });

  it("dedupes identical {{VAR}} references (only counted once in substituted list)", () => {
    const out = renderTemplateBody(
      "1: {{REPO_NAME}} 2: {{REPO_NAME}} 3: {{REPO_NAME}}",
      { manifest: manifest(), overrides: { REPO_NAME: "X" } },
    );
    expect(out.body).toBe("1: X 2: X 3: X");
    expect(out.substituted).toEqual([{ name: "REPO_NAME", value: "X" }]);
  });

  it("throws on an undeclared {{VAR}} reference (catches typos)", () => {
    expect(() =>
      renderTemplateBody("Hello {{REOP_NAME}}", {
        manifest: manifest(),
        overrides: {},
      }),
    ).toThrow(/undeclared variable "\{\{REOP_NAME\}\}"/);
  });

  it("renders kind:list array override as newline-separated lines", () => {
    const out = renderTemplateBody(
      "```bash\n{{QUALITY_GATE_TARGETS}}\n```",
      {
        manifest: manifest(),
        overrides: {
          QUALITY_GATE_TARGETS: ["make lint", "make test", "make build"],
        },
      },
    );
    expect(out.body).toBe(
      "```bash\nmake lint\nmake test\nmake build\n```",
    );
  });

  it("throws if a scalar variable receives an array override", () => {
    expect(() =>
      renderTemplateBody("X = {{REPO_NAME}}", {
        manifest: manifest(),
        overrides: { REPO_NAME: ["a", "b"] },
      }),
    ).toThrow(/REPO_NAME.*array override.*kind: "scalar"/);
  });

  it("accepts an empty body without error", () => {
    const out = renderTemplateBody("", {
      manifest: manifest(),
      overrides: {},
    });
    expect(out.body).toBe("");
    expect(out.substituted).toEqual([]);
  });

  it("ignores lowercase or mixed-case brace pairs (not template variables)", () => {
    // {{foo}} (lowercase) is NOT a template variable — the regex enforces
    // uppercase. This keeps documentation that mentions handlebars unrelated
    // to skill installation from breaking the renderer.
    const out = renderTemplateBody("Run {{foo}} and {{REPO_NAME}}", {
      manifest: manifest(),
      overrides: { REPO_NAME: "X" },
    });
    expect(out.body).toBe("Run {{foo}} and X");
  });
});

describe("extractReferencedVariables", () => {
  it("returns the deduplicated list in first-encounter order", () => {
    const vars = extractReferencedVariables(
      "{{A}} {{B}} {{A}} {{C}} {{B}} {{D}}",
    );
    expect(vars).toEqual(["A", "B", "C", "D"]);
  });

  it("returns an empty list when no {{VAR}} references exist", () => {
    expect(extractReferencedVariables("plain text with {single} braces")).toEqual([]);
  });

  it("only matches the uppercase identifier shape", () => {
    expect(extractReferencedVariables("{{lower}} {{Mixed}} {{UPPER1}} {{1NUMERIC}}")).toEqual([
      "UPPER1",
    ]);
  });
});
