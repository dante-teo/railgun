# 0014. MCP client support

Date: 2026-07-12

## Status

Accepted

## Context

Phase 23's extension system gave external code a surface to register tools via
`api.registerTool()`. Phase 24's goal is to let users configure standard MCP
(Model Context Protocol) servers — off-the-shelf tools distributed as npm
packages, local scripts, or binaries — without writing Railgun-specific
extension code. MCP uses JSON-RPC 2.0 over stdio with a fixed three-step
handshake (`initialize` / `notifications/initialized` / `tools/list`), so a
small transport layer is sufficient to discover and call MCP tools.

## Decision

### Transport: handwritten JSON-RPC framing over stdio, no SDK

The `@modelcontextprotocol/sdk` package was evaluated but not used. The full
MCP handshake over stdio requires about 50 lines of line-buffered JSON-RPC code.
Adding a new runtime dependency for that surface area would increase the
dependency tree without meaningfully reducing complexity. If real-world servers
expose compatibility gaps (e.g. out-of-order notifications the client must
handle), the fallback is to replace `connection.ts` with SDK client calls —
the naming and factory layers are unaffected.

### Stdio transport only

HTTP/SSE transport and OAuth are deferred. The config schema accepts only
`command`, `args?`, and `env?`. A future `url` field in `McpServerConfig`
would branch in `connectMcpServer` without touching the naming or factory layers.

### Built-in programmatic extension, not a filesystem extension file

MCP is bootstrapped in `cli.ts` by calling `createMcpExtension(servers)(api)`
directly, after `loadExtensions` completes. It does not live in
`~/.railgun/extensions/`. This keeps MCP startup deterministic and testable
(controlled by the injected `dependencies.loadConfig`), and avoids having the
user maintain a file that is really infrastructure. A filesystem extension
that calls `connectMcpServer` manually remains possible — the transport is
exported — but is not the supported path.

### `createExtensionAPI` exported from `loader.ts`

To create an `ExtensionAPI` for the MCP extension without routing through the
filesystem loader, `createExtensionAPI` is exported. This is the minimal change:
one `export` keyword, one re-export from `extensions/index.ts`. No new
abstractions.

### One broken server must not block startup

`Promise.allSettled` runs all server connections concurrently. Failed connections
log `[mcp] server "<name>" failed to connect: <error>` to stderr and are
skipped. The agent starts with whatever subset of servers connected successfully.

### Tool name format: `mcp__<server>__<tool>`

Server names and tool names are sanitized (`[^a-z0-9_-]` → `_`, consecutive
underscores collapsed, leading/trailing stripped) and joined with `__`
separators. A `seen: Set<string>` shared across all servers ensures global
uniqueness — a collision between two servers appends `_1`, `_2`, etc.

### Config loaded once, via DI, threaded into bootstrap

`bootstrapExtensions(sessionId, config)` receives the already-loaded `AppConfig`
from the call site. `resolveSessionTrust` was changed to return `config`
alongside `decision` and `store`, so the single `dependencies.loadConfig()` call
per session serves both trust resolution and MCP server parsing. This keeps
`bootstrapExtensions` testable and eliminates the double config read that would
result from a bare `loadConfig()` call inside it.

### `bootstrapExtensions` returns `{ runner, cleanup }`

Previously returned `ExtensionRunner` directly. Now returns a `cleanup()` fn
that kills all connected MCP child processes. All three call sites (`print`,
`fresh`, `resume`) wrap session work in `try/finally { cleanup() }` to ensure
child processes are killed even when the session throws.

## Consequences

- Users can configure MCP servers in `~/.railgun/config.json` under `mcpServers`
  without writing extension code.
- MCP tools appear in the tool registry as `mcp__<server>__<tool>` and are
  available to the model on every turn, alongside built-in and filesystem
  extension tools.
- One broken MCP server logs an error but does not prevent the agent from
  starting or any other tools from working.
- MCP server processes run with the same OS privileges as Railgun. Only
  configure servers you trust. There is no sandbox.
- MCP child processes are killed in `try/finally` on session shutdown — no
  leaked OS processes even on REPL/agent error.
- HTTP/SSE transport and OAuth are not supported. Servers that require them
  cannot be configured in this phase.
- `bootstrapExtensions` is now a two-argument function. The signature change
  is internal (the function is not exported); TypeScript enforces it at all
  three call sites in `cli.ts`.
