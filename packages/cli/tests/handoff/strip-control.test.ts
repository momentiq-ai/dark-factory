import { describe, it, expect } from "vitest";
import { stripControlChars } from "../../src/handoff/strip-control.js";

describe("stripControlChars", () => {
  it("removes ESC sequences (\\x1B)", () => {
    expect(stripControlChars("hello\x1B[31mred\x1B[0m world")).toBe(
      "hello[31mred[0m world",
    );
  });
  it("preserves TAB (\\x09) and LF (\\x0A)", () => {
    expect(stripControlChars("a\tb\nc")).toBe("a\tb\nc");
  });
  it("removes BEL (\\x07), BS (\\x08), DEL (\\x7F)", () => {
    expect(stripControlChars("alert\x07!")).toBe("alert!");
    expect(stripControlChars("back\x08space")).toBe("backspace");
    expect(stripControlChars("del\x7Fete")).toBe("delete");
  });
  it("removes VT (\\x0B), FF (\\x0C), CR (\\x0D) [bash treats CR as control]", () => {
    expect(stripControlChars("a\x0Bb")).toBe("ab");
    expect(stripControlChars("a\x0Cb")).toBe("ab");
    expect(stripControlChars("a\x0Db")).toBe("ab");
  });
  it("preserves printable ASCII (0x20-0x7E)", () => {
    const printable = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
    expect(stripControlChars(printable)).toBe(printable);
  });
  it("preserves multi-byte UTF-8 characters", () => {
    expect(stripControlChars("café 🚀 中文")).toBe("café 🚀 中文");
  });
  it("empty string returns empty", () => {
    expect(stripControlChars("")).toBe("");
  });
});
