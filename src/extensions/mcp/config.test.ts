import { describe, it, expect } from "vitest";
import { parseMcpServers } from "./config.js";

describe("parseMcpServers", () => {
  it("returns {} for undefined", () => {
    expect(parseMcpServers(undefined)).toEqual({});
  });

  it("returns {} for null", () => {
    expect(parseMcpServers(null)).toEqual({});
  });

  it("returns {} for a non-object", () => {
    expect(parseMcpServers("string")).toEqual({});
    expect(parseMcpServers(42)).toEqual({});
    expect(parseMcpServers([])).toEqual({});
  });

  it("parses a valid config with command only", () => {
    const result = parseMcpServers({ fs: { command: "npx" } });
    expect(result).toEqual({ fs: { command: "npx", args: undefined, env: undefined } });
  });

  it("parses command, args, and env", () => {
    const result = parseMcpServers({
      fs: {
        command: "npx",
        args: ["-y", "server-fs"],
        env: { HOME: "/tmp" },
      },
    });
    expect(result).toEqual({
      fs: {
        command: "npx",
        args: ["-y", "server-fs"],
        env: { HOME: "/tmp" },
      },
    });
  });

  it("skips entries missing command", () => {
    const result = parseMcpServers({ bad: { args: ["x"] } });
    expect(result).toEqual({});
  });

  it("skips entries where command is not a string", () => {
    const result = parseMcpServers({ bad: { command: 42 } });
    expect(result).toEqual({});
  });

  it("skips entries that are not objects", () => {
    const result = parseMcpServers({ bad: "not an object", good: { command: "ok" } });
    expect(result).toEqual({ good: { command: "ok", args: undefined, env: undefined } });
  });

  it("filters non-string values from env", () => {
    const result = parseMcpServers({
      fs: { command: "npx", env: { VALID: "yes", INVALID: 42 } },
    });
    expect(result["fs"]?.env).toEqual({ VALID: "yes" });
  });

  it("filters non-string values from args", () => {
    const result = parseMcpServers({
      fs: { command: "npx", args: ["valid", 99, null, "also-valid"] },
    });
    expect(result["fs"]?.args).toEqual(["valid", "also-valid"]);
  });

  it("treats non-object env as undefined", () => {
    const result = parseMcpServers({ fs: { command: "npx", env: "bad" } });
    expect(result["fs"]?.env).toBeUndefined();
  });
});
