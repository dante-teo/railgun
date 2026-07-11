import { describe, it, expect } from "vitest";
import { sanitizeForToolName, makeUniquePrefixedName } from "./naming.js";

describe("sanitizeForToolName", () => {
  it("lowercases input", () => {
    expect(sanitizeForToolName("ReadFile")).toBe("readfile");
  });

  it("preserves hyphens and underscores", () => {
    expect(sanitizeForToolName("read-file")).toBe("read-file");
    expect(sanitizeForToolName("read_file")).toBe("read_file");
  });

  it("replaces spaces and special chars with underscore", () => {
    expect(sanitizeForToolName("hello world!")).toBe("hello_world");
  });

  it("collapses consecutive underscores", () => {
    expect(sanitizeForToolName("a___b")).toBe("a_b");
  });

  it("strips leading and trailing underscores", () => {
    expect(sanitizeForToolName("_foo_")).toBe("foo");
  });

  it("handles mixed special chars", () => {
    expect(sanitizeForToolName("Read-File")).toBe("read-file");
  });
});

describe("makeUniquePrefixedName", () => {
  it("prefixes with server name and tool name", () => {
    const seen = new Set<string>();
    expect(makeUniquePrefixedName("fs", "read", seen)).toBe("mcp__fs__read");
  });

  it("deduplicates: second identical server+tool gets _1 suffix", () => {
    const seen = new Set<string>();
    const first = makeUniquePrefixedName("fs", "read", seen);
    const second = makeUniquePrefixedName("fs", "read", seen);
    expect(first).toBe("mcp__fs__read");
    expect(second).toBe("mcp__fs__read_1");
  });

  it("cross-server: different server names produce distinct names without collision", () => {
    const seen = new Set<string>();
    const a = makeUniquePrefixedName("a", "x", seen);
    const b = makeUniquePrefixedName("b", "x", seen);
    expect(a).toBe("mcp__a__x");
    expect(b).toBe("mcp__b__x");
  });

  it("same-server tools that sanitize to same name get deduplication suffix", () => {
    // "read.file" and "read_file" both sanitize to "read_file"
    const seen = new Set<string>();
    const first = makeUniquePrefixedName("a", "read.file", seen);
    const second = makeUniquePrefixedName("a", "read_file", seen);
    expect(first).toBe("mcp__a__read_file");
    expect(second).toBe("mcp__a__read_file_1");
  });

  it("increments counter past 1 when multiple collisions occur", () => {
    const seen = new Set<string>();
    makeUniquePrefixedName("s", "t", seen);
    makeUniquePrefixedName("s", "t", seen);
    const third = makeUniquePrefixedName("s", "t", seen);
    expect(third).toBe("mcp__s__t_2");
  });
});
