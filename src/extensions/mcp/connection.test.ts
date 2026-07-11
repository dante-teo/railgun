import { describe, it, expect, afterEach } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMcpServer } from "./connection.js";
import type { McpConnection } from "./connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "__fixtures__");

describe("connectMcpServer", () => {
  const conns: McpConnection[] = [];

  afterEach(() => {
    for (const c of conns) c.close();
    conns.length = 0;
  });

  it("connects, handshakes, and discovers tools", async () => {
    const conn = await connectMcpServer("fake", {
      command: "node",
      args: [join(fixtures, "fake-mcp-server.mjs")],
    });
    conns.push(conn);
    expect(conn.serverName).toBe("fake");
    expect(conn.tools).toHaveLength(1);
    expect(conn.tools[0]?.name).toBe("echo");
    expect(conn.tools[0]?.description).toBe("echoes input");
  });

  it("calls a tool and returns the text content", async () => {
    const conn = await connectMcpServer("fake", {
      command: "node",
      args: [join(fixtures, "fake-mcp-server.mjs")],
    });
    conns.push(conn);
    const result = await conn.call("echo", { text: "hello" });
    expect(result).toBe("hello");
  });

  it("rejects when connecting to a non-existent binary", async () => {
    await expect(
      connectMcpServer("bad", { command: "nonexistent-binary-xyz-railgun" }),
    ).rejects.toThrow(/nonexistent-binary-xyz-railgun|ENOENT|failed to start/i);
  });

  it("rejects pending RPC calls when the server exits unexpectedly", async () => {
    // The die fixture exits after responding to initialize, so tools/list is never answered
    await expect(
      connectMcpServer("die", {
        command: "node",
        args: [join(fixtures, "fake-mcp-server-die.mjs")],
      }),
    ).rejects.toThrow(/exited unexpectedly|MCP/i);
  });
});
