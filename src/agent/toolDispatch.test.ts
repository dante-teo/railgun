import { describe, expect, it } from "vitest";
import { pathsOverlap, safeParseToolArgs, shouldParallelizeToolBatch } from "./toolDispatch.js";

describe("shouldParallelizeToolBatch", () => {
  it("returns false for an empty array", () => {
    expect(shouldParallelizeToolBatch([])).toBe(false);
  });

  it("returns false for a single call", () => {
    expect(shouldParallelizeToolBatch([{ name: "read_file", arguments: { path: "/tmp/a.txt" } }])).toBe(false);
  });

  it("returns false when the batch contains clarify, regardless of the other calls", () => {
    expect(
      shouldParallelizeToolBatch([
        { name: "clarify", arguments: {} },
        { name: "read_file", arguments: { path: "/tmp/a.txt" } }
      ])
    ).toBe(false);
  });

  it("returns true for two read_file calls on different absolute paths", () => {
    expect(
      shouldParallelizeToolBatch([
        { name: "read_file", arguments: { path: "/tmp/a.txt" } },
        { name: "read_file", arguments: { path: "/tmp/b.txt" } }
      ])
    ).toBe(true);
  });

  it("returns false for two read_file calls on the identical absolute path", () => {
    expect(
      shouldParallelizeToolBatch([
        { name: "read_file", arguments: { path: "/tmp/a.txt" } },
        { name: "read_file", arguments: { path: "/tmp/a.txt" } }
      ])
    ).toBe(false);
  });

  it("returns false for read_file on a parent path and write_file on a child path (overlapping)", () => {
    expect(
      shouldParallelizeToolBatch([
        { name: "read_file", arguments: { path: "/a/b" } },
        { name: "write_file", arguments: { path: "/a/b/c.txt" } }
      ])
    ).toBe(false);
  });

  it("returns false when the batch includes an unknown tool not on any list", () => {
    expect(
      shouldParallelizeToolBatch([
        { name: "read_file", arguments: { path: "/tmp/a.txt" } },
        { name: "run_shell_command", arguments: { command: "echo hi" } }
      ])
    ).toBe(false);
  });

  it("returns false when a read_file call's arguments.path is missing", () => {
    expect(
      shouldParallelizeToolBatch([
        { name: "read_file", arguments: {} },
        { name: "read_file", arguments: { path: "/tmp/b.txt" } }
      ])
    ).toBe(false);
  });

  it("returns false when a read_file call's arguments.path is non-string", () => {
    expect(
      shouldParallelizeToolBatch([
        { name: "read_file", arguments: { path: 123 } },
        { name: "read_file", arguments: { path: "/tmp/b.txt" } }
      ])
    ).toBe(false);
  });
});

describe("pathsOverlap", () => {
  it("returns false for two disjoint absolute paths", () => {
    expect(pathsOverlap("/a/b.txt", "/c/d.txt")).toBe(false);
  });

  it("returns true for an identical path", () => {
    expect(pathsOverlap("/a/b.txt", "/a/b.txt")).toBe(true);
  });

  it("returns true for a path and its subdirectory", () => {
    expect(pathsOverlap("/a/b", "/a/b/c.txt")).toBe(true);
  });
});

describe("safeParseToolArgs", () => {
  it("returns ok:true with the parsed args for a valid JSON object string", () => {
    expect(safeParseToolArgs('{"path":"a.txt"}')).toEqual({ ok: true, args: { path: "a.txt" } });
  });

  it("returns ok:false for an empty string", () => {
    expect(safeParseToolArgs("")).toEqual({ ok: false });
  });

  it("returns ok:false for truncated JSON", () => {
    expect(safeParseToolArgs('{"path": "a.txt"')).toEqual({ ok: false });
  });
});
