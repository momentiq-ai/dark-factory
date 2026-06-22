import { describe, expect, it } from "vitest";

import { cmdProve } from "../src/commands/prove.js";
import type { CollectedProofInputs } from "../src/evidence/prove.js";
import type { BoundProofRecord, EvidenceBinding, Objective } from "@momentiq/dark-factory-schemas";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
    out,
    err,
  };
}

function obj(id: string, attestedBy: EvidenceBinding[], enforced = false): Objective {
  return { id, source: { kind: "cycle", ref: "21" }, text: id, attestedBy, enforced };
}

// Injected collector: crafts ProofInputs so the command's render + exit logic is
// tested without git/disk (collectProofInputs itself is covered in prove.test.ts).
function collectReturning(objectives: Objective[], gateResults: Record<string, { exitCode: number }> = {}): CollectedProofInputs {
  return {
    resolvedSha: "abc123def456",
    inputs: {
      commit: "abc123def456",
      headDiffHash: "h",
      objectives,
      gateResults,
      evidenceDiffHash: "h",
      criticResults: {},
    },
  };
}

const NOW = () => "2026-06-20T00:00:00.000Z";

function deps(collected: CollectedProofInputs | null) {
  return { collect: async () => collected, now: NOW };
}

describe("cmdProve", () => {
  it("--help prints usage and exits 0", async () => {
    const c = capture();
    expect(await cmdProve(["--help"], c.io)).toBe(0);
    expect(c.out.join("")).toContain("df prove");
  });

  it("rejects an unknown flag with exit 2", async () => {
    const c = capture();
    expect(await cmdProve(["--bogus"], c.io)).toBe(2);
    expect(c.err.join("")).toMatch(/unknown flag/);
  });

  it("exits 0 with a message when no objectives are declared", async () => {
    const c = capture();
    expect(await cmdProve([], c.io, deps(null))).toBe(0);
    expect(c.out.join("")).toMatch(/nothing to prove/);
  });

  it("renders a proven objective and exits 0 (--json)", async () => {
    const c = capture();
    const collected = collectReturning(
      [obj("cycle21#ec1", [{ kind: "route", routeId: "targeted-test" }])],
      { "targeted-test": { exitCode: 0 } },
    );
    const code = await cmdProve(["--json"], c.io, deps(collected));
    expect(code).toBe(0);
    const record = JSON.parse(c.out.join("")) as BoundProofRecord;
    expect(record.objectives[0].status).toBe("proven");
    expect(record.summary).toEqual({ proven: 1, pending: 0, failed: 0, total: 1 });
  });

  it("informational: a non-enforced pending objective still exits 0", async () => {
    const c = capture();
    const collected = collectReturning([obj("cycle21#ec1", [{ kind: "critic", criticId: "codex" }])]);
    expect(await cmdProve([], c.io, deps(collected))).toBe(0);
    expect(c.err.join("")).toMatch(/informational/);
  });

  it("exits 1 when an ENFORCED objective is not proven", async () => {
    const c = capture();
    const collected = collectReturning([
      obj("cycle21#ec1", [{ kind: "critic", criticId: "codex" }], true), // enforced, pending
    ]);
    const code = await cmdProve([], c.io, deps(collected));
    expect(code).toBe(1);
    expect(c.err.join("")).toMatch(/not proven/);
    expect(c.err.join("")).toMatch(/cycle21#ec1 \(pending\)/);
  });

  it("--strict exits 1 on any unproven objective even when not enforced", async () => {
    const c = capture();
    const collected = collectReturning([obj("cycle21#ec1", [{ kind: "critic", criticId: "codex" }])]);
    expect(await cmdProve(["--strict"], c.io, deps(collected))).toBe(1);
  });

  it("--strict exits 0 when every objective is proven", async () => {
    const c = capture();
    const collected = collectReturning(
      [obj("cycle21#ec1", [{ kind: "route", routeId: "r" }])],
      { r: { exitCode: 0 } },
    );
    expect(await cmdProve(["--strict"], c.io, deps(collected))).toBe(0);
  });
});
