# 0032. Versioned desktop RPC

## Status

Accepted

## Context

The original JSONL stdio protocol intentionally supported a small, headless surface. It auto-approved shell confirmation callbacks, rejected clarification, retained history only in memory, and accepted one running prompt. Desktop needs interactive requests, durable conversations, and access to local management stores, but existing RPC consumers must not change behavior merely because the server was upgraded.

## Decision

RPC connections begin in legacy mode. A client opts into protocol v1 by sending `initialize` with `version: 1` before its first run. Success returns the negotiated version and capability names. Unsupported versions return a correlated error and leave the connection in legacy mode. Initialization is never automatic in `RpcClient`; Electron explicitly initializes and validates required capabilities before probing `get_state`.

Protocol v1 adds:

- persistent active-session metadata and session list/load/save/branch/fork/recent-message commands;
- request-ID-correlated approval and clarification events/responses;
- config and secret-redacted MCP management;
- cron, memory, note import/search, and skill-read commands.

All JSON commands pass through runtime validation before dispatch. Raw agent events remain unenveloped and JSONL continues to split only on byte `0x0a`. Legacy clients retain the original ten commands, response shapes, shell auto-approval, clarification error, in-memory history, and one-running-prompt rule.

An initialized connection allocates an unsaved session immediately. A valid completed or aborted transcript is checkpointed automatically. Empty sessions are not written. Checkpoint errors are exposed in enhanced state and as a raw `checkpoint_error` event without discarding memory, and `session_save` retries them. Load/new/branch/fork are rejected during a run.

Session mutations, model changes, and compaction share one ordered session-operation queue. Compaction therefore checkpoints the session it started against before a queued load/new/fork can activate another transcript. Each activated model is resolved to its full provider metadata and model-specific system prompt before session activation. Changing the model of a saved or checkpoint-error transcript derives a new unsaved session ID with copied history and todos, preserving the immutable metadata of the original saved session; changing an empty unsaved session updates it in place. Legacy `set_model` behavior remains unchanged.

MCP secrets never cross JSONL: reads expose command, arguments, and environment key presence only. MCP environment upserts retain omitted keys and delete keys assigned `null`. Generic config patches reject `mcpServers`; both config and cron continue to use their existing atomic writers.

Pending interactions are stored in maps keyed by unique request ID. Abort, EOF, and run settlement reject all remaining requests, preventing parallel approvals from overwriting one another or leaving promises unresolved.

## Consequences

The desktop has a deterministic compatibility check and a complete backend surface without expanding preload or renderer APIs in this change. The server carries two explicit behavior modes, but compatibility does not depend on client-name detection. Store and interaction handlers are separated from transport dispatch so validation and secret redaction can be tested independently.
