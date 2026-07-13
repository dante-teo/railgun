import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpConnection } from "./connection.js";
import type { ExtensionAPI, ExtensionRegisteredTool } from "../types.js";

// Module-level mock — Vitest hoists this before imports
vi.mock("./connection.js", () => ({
  connectMcpServer: vi.fn(),
}));

// Import after mock declaration so module is the mocked version
import { connectMcpServer } from "./connection.js";
import { createMcpExtension } from "./index.js";

const makeConn = (toolName: string, serverName = "test"): McpConnection => ({
  serverName,
  tools: [{ name: toolName, description: `tool ${toolName}`, inputSchema: { type: "object", properties: {} } }],
  call: vi.fn(async () => "result"),
  close: vi.fn(),
});

const makeApi = (): { api: ExtensionAPI; registered: ExtensionRegisteredTool[] } => {
  const registered: ExtensionRegisteredTool[] = [];
  const api: ExtensionAPI = {
    on: vi.fn(),
    registerTool: vi.fn((tool) => { registered.push(tool); }),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    registerProvider: vi.fn(),
  };
  return { api, registered };
};

describe("createMcpExtension", () => {
  beforeEach(() => {
    vi.mocked(connectMcpServer).mockReset();
  });

  it("registers tools with prefixed names for each server", async () => {
    const conn = makeConn("read");
    vi.mocked(connectMcpServer).mockResolvedValue(conn);
    const { api, registered } = makeApi();

    const factory = createMcpExtension({ myserver: { command: "fake" } });
    await factory(api);

    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe("mcp__myserver__read");
    expect(registered[0]?.description).toBe("tool read");
  });

  it("calls api.registerTool for every tool across multiple servers", async () => {
    const connA = makeConn("alpha");
    const connB = makeConn("beta");
    vi.mocked(connectMcpServer)
      .mockResolvedValueOnce(connA)
      .mockResolvedValueOnce(connB);
    const { api, registered } = makeApi();

    const factory = createMcpExtension({
      serverA: { command: "a" },
      serverB: { command: "b" },
    });
    await factory(api);

    expect(registered).toHaveLength(2);
    expect(registered.map(r => r.name).sort()).toEqual([
      "mcp__servera__alpha",
      "mcp__serverb__beta",
    ]);
  });

  it("one failing server does not prevent other servers from loading", async () => {
    vi.mocked(connectMcpServer)
      .mockRejectedValueOnce(new Error("server dead"))
      .mockResolvedValueOnce(makeConn("ok"));
    const { api, registered } = makeApi();

    const factory = createMcpExtension({
      bad: { command: "bad" },
      good: { command: "good" },
    });
    // Should not throw
    await expect(factory(api)).resolves.toBeDefined();
    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe("mcp__good__ok");
  });

  it("close() calls close on all connections", async () => {
    const connA = makeConn("a");
    const connB = makeConn("b");
    vi.mocked(connectMcpServer)
      .mockResolvedValueOnce(connA)
      .mockResolvedValueOnce(connB);
    const { api } = makeApi();

    const factory = createMcpExtension({
      sa: { command: "a" },
      sb: { command: "b" },
    });
    const handle = await factory(api);
    handle.close();

    expect(connA.close).toHaveBeenCalledOnce();
    expect(connB.close).toHaveBeenCalledOnce();
  });

  it("tool execute calls conn.call with the original (unprefixed) tool name", async () => {
    const conn = makeConn("read_file");
    vi.mocked(connectMcpServer).mockResolvedValue(conn);
    const { api, registered } = makeApi();

    const factory = createMcpExtension({ fs: { command: "fake" } });
    await factory(api);

    await registered[0]!.execute({ path: "/tmp" }, { sessionId: "s1", signal: new AbortController().signal });
    expect(conn.call).toHaveBeenCalledWith("read_file", { path: "/tmp" }, expect.any(AbortSignal));
  });
});
