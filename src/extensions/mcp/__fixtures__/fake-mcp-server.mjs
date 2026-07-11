#!/usr/bin/env node
// Fake MCP server for testing. Reads newline-delimited JSON-RPC from stdin, responds on stdout.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Notifications have no id — do not respond
  if (msg.id === undefined) return;

  const respond = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");

  const respondError = (code, message) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } }) + "\n");

  if (msg.method === "initialize") {
    respond({ protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake" } });
  } else if (msg.method === "tools/list") {
    respond({
      tools: [{
        name: "echo",
        description: "echoes input",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      }],
    });
  } else if (msg.method === "tools/call") {
    const text = msg.params?.arguments?.text ?? "no-text";
    respond({ content: [{ type: "text", text }] });
  } else {
    respondError(-32601, "Method not found");
  }
});
