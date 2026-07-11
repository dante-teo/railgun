import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { serializeJsonLine, makeLineReader } from "./jsonl.js";

describe("serializeJsonLine", () => {
  it("serializes a value to JSON followed by a newline", () => {
    expect(serializeJsonLine({ type: "hello" })).toBe('{"type":"hello"}\n');
  });

  it("handles strings, numbers, and null", () => {
    expect(serializeJsonLine("abc")).toBe('"abc"\n');
    expect(serializeJsonLine(42)).toBe('42\n');
    expect(serializeJsonLine(null)).toBe('null\n');
  });

  it("round-trips through JSON.parse", () => {
    const value = { a: 1, b: [true, null, "x"] };
    const line = serializeJsonLine(value);
    expect(JSON.parse(line.trim())).toEqual(value);
  });
});

describe("makeLineReader", () => {
  it("splits a single line correctly", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    makeLineReader(stream, line => lines.push(line));

    stream.push(Buffer.from('{"type":"hello"}\n'));
    expect(lines).toEqual(['{"type":"hello"}']);
  });

  it("splits multiple lines in a single chunk", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    makeLineReader(stream, line => lines.push(line));

    stream.push(Buffer.from('line1\nline2\nline3\n'));
    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  it("handles lines split across multiple data events", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    makeLineReader(stream, line => lines.push(line));

    stream.push(Buffer.from('hell'));
    expect(lines).toHaveLength(0);
    stream.push(Buffer.from('o\nworld\n'));
    expect(lines).toEqual(["hello", "world"]);
  });

  it("ignores empty lines", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    makeLineReader(stream, line => lines.push(line));

    stream.push(Buffer.from('\n\nhello\n\n'));
    expect(lines).toEqual(["hello"]);
  });

  it("does NOT split on U+2028 (line separator) or U+2029 (paragraph separator)", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    makeLineReader(stream, line => lines.push(line));

    // U+2028 and U+2029 encoded in UTF-8 should not split lines
    const text = `{"a":"\u2028\u2029"}\n`;
    stream.push(Buffer.from(text, "utf-8"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({ a: "\u2028\u2029" });
  });

  it("calls the cleanup function to detach the listener", () => {
    const stream = new PassThrough();
    const onLine = vi.fn();
    const cleanup = makeLineReader(stream, onLine);

    stream.push(Buffer.from('first\n'));
    expect(onLine).toHaveBeenCalledTimes(1);

    cleanup();
    stream.push(Buffer.from('second\n'));
    // No more calls after cleanup
    expect(onLine).toHaveBeenCalledTimes(1);
  });

  it("handles a line with no trailing newline (partial buffer, no output until newline)", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    makeLineReader(stream, line => lines.push(line));

    stream.push(Buffer.from('incomplete'));
    expect(lines).toHaveLength(0);
    stream.push(Buffer.from(' line\n'));
    expect(lines).toEqual(["incomplete line"]);
  });
});
