import { describe, it, expect } from "vitest";
import {
  MARKER_OPEN,
  MARKER_CLOSE,
  validateNoteMarkers,
  validateLatestBlock,
  spliceAgentContextBlock,
} from "../../src/handoff/markers.js";

const O = MARKER_OPEN;
const C = MARKER_CLOSE;

describe("markers — constants", () => {
  it("MARKER_OPEN = <!-- agent-context:v1 -->", () => {
    expect(MARKER_OPEN).toBe("<!-- agent-context:v1 -->");
  });
  it("MARKER_CLOSE = <!-- /agent-context:v1 -->", () => {
    expect(MARKER_CLOSE).toBe("<!-- /agent-context:v1 -->");
  });
});

describe("markers — validateNoteMarkers (first-block: open before close)", () => {
  it("passes on a well-formed block", () => {
    expect(validateNoteMarkers(`${O}\nreasoning\n${C}\n`)).toBe(true);
  });
  it("fails when open marker missing", () => {
    expect(validateNoteMarkers(`reasoning\n${C}\n`)).toBe(false);
  });
  it("fails when close marker missing", () => {
    expect(validateNoteMarkers(`${O}\nreasoning\n`)).toBe(false);
  });
  it("fails when close appears before open (reversed)", () => {
    expect(validateNoteMarkers(`${C}\nreasoning\n${O}\n`)).toBe(false);
  });
});

describe("markers — validateLatestBlock (last-block well-formedness)", () => {
  it("passes when only block is well-formed", () => {
    expect(validateLatestBlock(`${O}\nreasoning\n${C}\n`)).toBe(true);
  });
  it("fails when latest block is open-only (newer malformed)", () => {
    const body = `${O}\nold valid\n${C}\n\nseparator\n\n${O}\nnewer no-close\n`;
    expect(validateLatestBlock(body)).toBe(false);
  });
  it("passes when an older block is malformed but newest is well-formed", () => {
    // Defensive: latest matters; this is unusual but tolerated.
    const body = `${O}\nleaks-open\n${O}\nlatest\n${C}\n`;
    expect(validateLatestBlock(body)).toBe(true);
  });
  it("fails on reversed markers (close before open)", () => {
    expect(validateLatestBlock(`${C}\nreasoning\n${O}\n`)).toBe(false);
  });
});

describe("markers — spliceAgentContextBlock", () => {
  it("appends when old body has no markers (preserves operator text)", () => {
    const oldBody = "existing operator description\n";
    const newBlock = `${O}\nnew reasoning\n${C}`;
    const result = spliceAgentContextBlock(oldBody, newBlock);
    expect(result).toContain("existing operator description");
    expect(result).toContain(`${O}\nnew reasoning\n${C}`);
  });
  it("replaces FIRST-open through LAST-close (single block, idempotent)", () => {
    const oldBody = `before\n${O}\nold\n${C}\nafter\n`;
    const newBlock = `${O}\nnew\n${C}`;
    const result = spliceAgentContextBlock(oldBody, newBlock);
    expect(result).toContain("before");
    expect(result).toContain("after");
    expect(result).toContain("new");
    expect(result).not.toContain("old");
  });
  it("replaces FIRST-open through LAST-close (multi-block → single-block)", () => {
    // Operator error: two stale blocks. Splice collapses to one.
    const oldBody = `before\n${O}\nold1\n${C}\n\n${O}\nold2\n${C}\nafter\n`;
    const newBlock = `${O}\nnew\n${C}`;
    const result = spliceAgentContextBlock(oldBody, newBlock);
    expect(result).toContain("before");
    expect(result).toContain("after");
    expect(result).toContain("new");
    expect(result).not.toContain("old1");
    expect(result).not.toContain("old2");
  });
  it("returns just the new block on empty input", () => {
    const newBlock = `${O}\nnew\n${C}`;
    expect(spliceAgentContextBlock("", newBlock)).toBe(newBlock);
  });
  it("preserves marker tokens within the new block (no double-splicing)", () => {
    const oldBody = `before\n${O}\nold\n${C}\n`;
    const newBlock = `${O}\nnew\n${C}`;
    const result = spliceAgentContextBlock(oldBody, newBlock);
    // Should contain exactly ONE open marker (in the new block).
    expect((result.match(/<!-- agent-context:v1 -->/g) ?? []).length).toBe(1);
    expect((result.match(/<!-- \/agent-context:v1 -->/g) ?? []).length).toBe(1);
  });
});

// Structural edge tests (lessons from Task 1 review)
describe("markers — structural edges", () => {
  it("validateNoteMarkers on empty string returns false", () => {
    expect(validateNoteMarkers("")).toBe(false);
  });
  it("validateLatestBlock on empty string returns false", () => {
    expect(validateLatestBlock("")).toBe(false);
  });
  it("validateNoteMarkers on body with markers on same line", () => {
    // Edge: markers concatenated with no content. open precedes close on same line.
    // Bash awk per-line: same line index for both. open < close requires DIFFERENT lines.
    // Bash behavior: grep -F finds both, sed -n picks line 1 for both, 1 < 1 is false.
    // → validateNoteMarkers returns FALSE for same-line markers.
    expect(validateNoteMarkers(`${O}${C}`)).toBe(false);
  });
  it("spliceAgentContextBlock with multi-line new block preserves internal newlines", () => {
    const newBlock = `${O}\nline 1\nline 2\nline 3\n${C}`;
    const result = spliceAgentContextBlock("", newBlock);
    expect(result).toBe(newBlock);
  });
});
