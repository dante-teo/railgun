import { spawn } from "node:child_process";

export interface McpServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpConnection {
  readonly serverName: string;
  readonly tools: readonly McpTool[];
  call(toolName: string, args: Record<string, unknown>): Promise<string>;
  close(): void;
}

interface Pending {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const parseTools = (result: unknown): McpTool[] => {
  if (!isPlainObject(result) || !Array.isArray(result["tools"])) return [];
  return result["tools"].flatMap((item: unknown): McpTool[] => {
    if (!isPlainObject(item) || typeof item["name"] !== "string") return [];
    return [{
      name: item["name"],
      ...(typeof item["description"] === "string" ? { description: item["description"] } : {}),
      inputSchema: isPlainObject(item["inputSchema"]) ? item["inputSchema"] : { type: "object", properties: {} },
    }];
  });
};

const parseCallResult = (result: unknown): string => {
  if (!isPlainObject(result) || !Array.isArray(result["content"])) {
    return JSON.stringify(result);
  }
  const textParts = result["content"].flatMap((part: unknown): string[] => {
    if (!isPlainObject(part) || part["type"] !== "text" || typeof part["text"] !== "string") return [];
    return [part["text"]];
  });
  return textParts.length > 0 ? textParts.join("\n") : JSON.stringify(result["content"]);
};

export const connectMcpServer = async (name: string, config: McpServerConfig): Promise<McpConnection> => {
  const proc = spawn(config.command, [...(config.args ?? [])], {
    env: { ...process.env, ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  let closed = false;
  const pending = new Map<number, Pending>();
  let stdoutBuf = "";

  // spawnError promise: only ever rejects (on proc error), never resolves
  const { promise: spawnErrorPromise, reject: rejectSpawn } = Promise.withResolvers<never>();

  const rejectAll = (err: Error): void => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  proc.on("error", (err) => {
    const e = new Error(`MCP server "${name}" failed to start: ${err.message}`);
    rejectSpawn(e);
    rejectAll(e);
  });

  proc.on("exit", (code) => {
    if (closed) return;
    const e = new Error(`MCP server "${name}" exited unexpectedly (code ${code ?? "null"})`);
    rejectAll(e);
  });

  proc.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!isPlainObject(parsed) || typeof parsed["id"] !== "number") continue;
      const handler = pending.get(parsed["id"]);
      if (!handler) continue;
      pending.delete(parsed["id"]);
      if (isPlainObject(parsed["error"])) {
        const code = typeof parsed["error"]["code"] === "number" ? parsed["error"]["code"] : -1;
        const msg = typeof parsed["error"]["message"] === "string" ? parsed["error"]["message"] : "Unknown error";
        handler.reject(new Error(`MCP RPC error ${code}: ${msg}`));
      } else {
        handler.resolve(parsed["result"]);
      }
    }
  });

  let stderrBuf = "";
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop() ?? "";
    for (const line of lines) process.stderr.write(`[mcp:${name}] ${line}\n`);
  });
  proc.stderr!.on("end", () => {
    if (stderrBuf) process.stderr.write(`[mcp:${name}] ${stderrBuf}\n`);
  });

  const sendRpc = (method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> => {
    const id = nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP RPC timeout after ${timeoutMs}ms: ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return promise;
  };

  const sendNotification = (method: string, params: Record<string, unknown>): void => {
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };

  const handshake = async (): Promise<McpConnection> => {
    await sendRpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "railgun", version: "1.0.0" },
    }, 10_000);
    sendNotification("notifications/initialized", {});
    const toolsResult = await sendRpc("tools/list", {}, 10_000);
    const tools = parseTools(toolsResult);

    return {
      serverName: name,
      tools,
      call: async (toolName, args) => {
        const result = await sendRpc("tools/call", { name: toolName, arguments: args }, 30_000);
        return parseCallResult(result);
      },
      close: () => {
        closed = true;
        proc.kill();
      },
    };
  };

  // Race handshake against spawn errors; spawnErrorPromise only ever rejects
  return Promise.race([handshake(), spawnErrorPromise]);
};
