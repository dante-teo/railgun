#!/usr/bin/env node
// Fake MCP server that exits after responding to initialize — simulates a server
// that dies mid-conversation, causing pending RPC calls to be rejected.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.id === undefined) return;

  if (msg.method === "initialize") {
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "die" } } }) + "\n",
    );
    // Exit immediately after responding — pending tools/list will never get a reply
    process.exit(0);
  }
});
