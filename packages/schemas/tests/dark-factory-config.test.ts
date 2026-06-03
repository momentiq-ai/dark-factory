// `darkfactory.yaml` schema parser — public contract tests.
//
// The schema lives in this package so external consumers (CLI, MCP, and
// any third-party tool that introspects darkfactory.yaml) can validate
// against the same canonical shape without depending on the CLI's
// internal zod schema. Mirrors parseAgentReviewConfig in scope: validates
// shape, returns a strongly-typed value, throws SchemaError on bad input.

import { describe, expect, it } from "vitest";

import {
  parseDarkFactoryConfig,
  SchemaError,
  type DarkFactoryConfig,
} from "../src/index.js";

describe("parseDarkFactoryConfig", () => {
  it("accepts an empty object (all fields optional)", () => {
    const parsed = parseDarkFactoryConfig({});
    expect(parsed).toEqual({});
  });

  it("accepts a fully-populated config", () => {
    const raw = {
      repo: {
        displayName: "Dark Factory Platform",
        slug: "dark-factory-platform",
        ownerRepo: "momentiq-ai/dark-factory-platform",
      },
      docs: {
        manifesto: "docs/PRINCIPLES.md",
        adrDir: "docs/ADR",
        cycleDocsDir: "docs/roadmap/cycles",
        rfcDir: "docs/rfcs",
        prdDir: "docs/prds",
      },
      agents: { chiefEngineer: ".claude/agents/chief-engineer.md" },
      qualityGates: ["make quality-gates", "make test"],
      qualityGatesExtras: { apiTypes: "make generate-api-types" },
      worktreeRoot: ".claude/worktrees",
      agentCommitterOrg: "momentiq",
      skills: {
        "chief-engineer-review": { enabled: true },
        "chief-engineer-blitz": { enabled: false },
      },
    };
    const parsed: DarkFactoryConfig = parseDarkFactoryConfig(raw);
    expect(parsed.repo?.displayName).toBe("Dark Factory Platform");
    expect(parsed.docs?.adrDir).toBe("docs/ADR");
    expect(parsed.qualityGates).toEqual(["make quality-gates", "make test"]);
    expect(parsed.skills).toEqual({
      "chief-engineer-review": { enabled: true },
      "chief-engineer-blitz": { enabled: false },
    });
  });

  it("rejects unknown top-level keys (strict shape)", () => {
    expect(() =>
      parseDarkFactoryConfig({ totallyUnknownKey: 1 }),
    ).toThrow(SchemaError);
  });

  it("rejects wrong types on repo.displayName", () => {
    expect(() => parseDarkFactoryConfig({ repo: { displayName: 42 } })).toThrow(
      SchemaError,
    );
  });

  it("rejects non-string entries in qualityGates", () => {
    expect(() =>
      parseDarkFactoryConfig({ qualityGates: ["ok", 7] }),
    ).toThrow(SchemaError);
  });

  it("rejects non-boolean enabled in skills entries", () => {
    expect(() =>
      parseDarkFactoryConfig({
        skills: { "chief-engineer-review": { enabled: "yes" } },
      }),
    ).toThrow(SchemaError);
  });

  it("rejects null input", () => {
    expect(() => parseDarkFactoryConfig(null)).toThrow(SchemaError);
  });
});
