import { describe, expect, it } from "vitest";
import { parseRpcCommand } from "./protocol.js";

describe("parseRpcCommand", () => {
  it("parses handshake and management commands", () => {
    expect(parseRpcCommand({ id: "1", type: "initialize", version: 1 })).toEqual({ id: "1", type: "initialize", version: 1 });
    expect(parseRpcCommand({ type: "notes_search", query: "roadmap", mode: "semantic", limit: 5 })).toEqual({ type: "notes_search", query: "roadmap", mode: "semantic", limit: 5 });
    expect(parseRpcCommand({ type: "session_transcript", sessionId: "saved", cursor: 10, limit: 50 }))
      .toEqual({ type: "session_transcript", sessionId: "saved", cursor: 10, limit: 50 });
    expect(parseRpcCommand({ type: "session_load", sessionId: "saved", includeMessages: false }))
      .toEqual({ type: "session_load", sessionId: "saved", includeMessages: false });
  });

  it.each([
    [{ type: "prompt" }, /message/],
    [{ type: "set_auto_compaction", enabled: "yes" }, /enabled/],
    [{ type: "memory_list", limit: 0 }, /limit/],
    [{ type: "session_transcript", sessionId: "saved", cursor: -1 }, /cursor/],
    [{ type: "session_load", sessionId: "saved", includeMessages: "no" }, /includeMessages/],
    [{ type: "mcp_upsert", name: "x", command: "node", env: { TOKEN: 2 } }, /env values/],
    [{ type: "future" }, /unknown command/],
  ])("rejects malformed command %#", (command, expected) => {
    expect(() => parseRpcCommand(command)).toThrow(expected);
  });
});
