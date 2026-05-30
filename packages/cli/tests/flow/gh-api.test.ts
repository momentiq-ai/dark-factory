import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  DfFlowGhError,
  createGhFetcher,
  parseNdjson,
} from "../../src/commands/flow/gh-api.js";

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function spawnFromTable(table: Record<string, SpawnResult>) {
  const calls: string[][] = [];
  const spawn = (args: string[]): SpawnResult => {
    calls.push(args);
    const key = args.join(" ");
    const r = table[key];
    if (!r) throw new Error(`no programmed result for: ${key}`);
    return r;
  };
  return { spawn, calls };
}

describe("flow/gh-api — fetchFileText", () => {
  it("decodes base64 file content", () => {
    const content = Buffer.from("hello world", "utf8").toString("base64");
    const { spawn } = spawnFromTable({
      "api repos/momentiq-ai/df-assessments/contents/foo/bar.json?ref=main": {
        status: 0,
        stdout: JSON.stringify({ type: "file", encoding: "base64", content }),
        stderr: "",
      },
    });
    const f = createGhFetcher(spawn);
    expect(f.fetchFileText("foo/bar.json")).toBe("hello world");
  });
  it("returns null on HTTP 404 stderr", () => {
    const { spawn } = spawnFromTable({
      "api repos/momentiq-ai/df-assessments/contents/missing.json?ref=main": {
        status: 1,
        stdout: "",
        stderr: "gh: Not Found (HTTP 404)\n",
      },
    });
    const f = createGhFetcher(spawn);
    expect(f.fetchFileText("missing.json")).toBeNull();
  });
  it("returns null on JSON-shaped not-found body", () => {
    const { spawn } = spawnFromTable({
      "api repos/momentiq-ai/df-assessments/contents/missing.json?ref=main": {
        status: 1,
        stdout: "",
        stderr: '{"message":"Not Found","documentation_url":"x"}',
      },
    });
    const f = createGhFetcher(spawn);
    expect(f.fetchFileText("missing.json")).toBeNull();
  });
  it("throws DfFlowGhError on other non-zero exits", () => {
    const { spawn } = spawnFromTable({
      "api repos/momentiq-ai/df-assessments/contents/x.json?ref=main": {
        status: 1,
        stdout: "",
        stderr: "API rate limit exceeded",
      },
    });
    const f = createGhFetcher(spawn);
    expect(() => f.fetchFileText("x.json")).toThrow(DfFlowGhError);
  });
  it("throws on a response with no content field", () => {
    const { spawn } = spawnFromTable({
      "api repos/momentiq-ai/df-assessments/contents/x.json?ref=main": {
        status: 0,
        stdout: JSON.stringify({ type: "dir" }),
        stderr: "",
      },
    });
    const f = createGhFetcher(spawn);
    expect(() => f.fetchFileText("x.json")).toThrow(/no file content/);
  });
});

describe("flow/gh-api — fetchDir", () => {
  it("returns the dir array", () => {
    const dir = [{ name: "2310.json", type: "file", size: 4332, path: "p", sha: "s", download_url: null }];
    const { spawn } = spawnFromTable({
      "api repos/momentiq-ai/df-assessments/contents/store/tenant/sage3c/pr?ref=main": {
        status: 0,
        stdout: JSON.stringify(dir),
        stderr: "",
      },
    });
    const f = createGhFetcher(spawn);
    expect(f.fetchDir("store/tenant/sage3c/pr")).toEqual(dir);
  });
  it("returns null on 404", () => {
    const { spawn } = spawnFromTable({
      "api repos/momentiq-ai/df-assessments/contents/missing?ref=main": {
        status: 1,
        stdout: "",
        stderr: "gh: Not Found (HTTP 404)",
      },
    });
    const f = createGhFetcher(spawn);
    expect(f.fetchDir("missing")).toBeNull();
  });
  it("throws when payload isn't an array (path was a file)", () => {
    const { spawn } = spawnFromTable({
      "api repos/momentiq-ai/df-assessments/contents/x.json?ref=main": {
        status: 0,
        stdout: JSON.stringify({ type: "file" }),
        stderr: "",
      },
    });
    const f = createGhFetcher(spawn);
    expect(() => f.fetchDir("x.json")).toThrow(/expected directory array/);
  });
});

describe("flow/gh-api — parseNdjson", () => {
  it("parses every non-blank line", () => {
    const text = '{"a":1}\n{"a":2}\n\n{"a":3}\n';
    expect(parseNdjson<{ a: number }>(text, "test")).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });
  it("surfaces line number on malformed row", () => {
    const text = '{"a":1}\nnot-json\n';
    expect(() => parseNdjson(text, "test")).toThrow(/line 2/);
  });
});
