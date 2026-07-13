import type { ExtensionAPI } from "../types.js";
import { connectMcpServer } from "./connection.js";
import type { McpServerConfig, McpConnection } from "./connection.js";
import { makeUniquePrefixedName } from "./naming.js";

export { parseMcpServers } from "./config.js";
export type { McpServerConfig } from "./connection.js";

export const createMcpExtension = (
  servers: Record<string, McpServerConfig>,
): (api: ExtensionAPI) => Promise<{ close(): void }> =>
  async (api) => {
    const seen = new Set<string>();
    const connections: McpConnection[] = [];

    const entries = Object.entries(servers);
    const results = await Promise.allSettled(
      entries.map(async ([name, config]) => {
        const conn = await connectMcpServer(name, config);
        connections.push(conn);
        for (const tool of conn.tools) {
          const prefixedName = makeUniquePrefixedName(name, tool.name, seen);
          api.registerTool({
            name: prefixedName,
            description: tool.description ?? `MCP tool ${tool.name} from server "${name}"`,
            inputSchema: tool.inputSchema,
            execute: async (args, context) => {
              const content = await conn.call(tool.name, args, context.signal);
              return { content };
            },
          });
        }
      }),
    );

    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        const name = entries[i]?.[0] ?? `<server ${i}>`;
        console.error(`[mcp] server "${name}" failed to connect: ${result.reason}`);
      }
    }

    return {
      close: () => connections.forEach(c => c.close()),
    };
  };
