# 0008. Use source-aware Devin credentials and never replay rejected turns

Date: 2026-07-10

## Status

Accepted

## Context

Railgun previously used only `~/.railgun/devin-token`, opened browser OAuth
implicitly when that file was absent, and left expired-token recovery to manual
file deletion. That was awkward for headless use, could not distinguish a
process environment credential from a cached credential, and left retry
behavior too broad for authentication and client failures.

Authentication is a boundary shared by model discovery and asynchronous chat
streaming. A 401 can occur during either operation, including after a REPL has
already started. Recovery must avoid deleting a valid cache merely because an
overriding environment token failed, and it must not repeat a failed message or
tool sequence after credentials change.

## Decision

- A trimmed nonempty `DEVIN_TOKEN` uses a process-local memory token store and
  takes precedence without reading, writing, or clearing the file cache.
  Whitespace-only values count as absent.
- Without an environment token, Railgun uses
  `~/.railgun/devin-token`. Browser OAuth opens implicitly only when that cache
  is absent.
- Model-discovery and streaming HTTP 401 responses become a source-aware
  credential-rejection error. File rejection attempts to clear the cache;
  environment rejection never does. A cache-removal failure is reported
  alongside, rather than instead of, the original 401.
- `railgun login` always performs fresh browser OAuth against the file store.
  The previous cache remains until OAuth returns a replacement. Railgun then
  verifies model discovery: 401 clears the replacement, while API or protocol
  uncertainty retains it and exits nonzero with saved-but-unverified context.
- `railgun logout` idempotently clears only the file cache. Both authentication
  commands warn when `DEVIN_TOKEN` overrides or survives the cache operation,
  and both dispatch before SQLite, project context, session, or TUI setup.
- Authentication rejection and raw HTTP 401 classify as `reauth_required` and
  fail immediately. HTTP 408, 429, 5xx, and recognizable fetch transport
  failures receive at most three attempts with 500ms and 1000ms delays. Other
  4xx, protocol, and unrelated errors fail immediately.
- The REPL remains open after rejection, rolls back turn-local todo state, and
  saves no checkpoint. A later file-backed request can observe a token written
  by `railgun login`, but the user must manually resubmit the failed message.
  Railgun never automatically replays that message or its tools.

## Consequences

- Headless and ephemeral environments can authenticate without persisting a
  token, while interactive users retain browser OAuth and a private cache.
- Credential cleanup is safe with respect to precedence: a bad environment
  token cannot destroy a potentially valid cached login.
- Explicit login/logout provide an actionable recovery path without requiring
  users to manipulate credential files manually.
- No token contents are written to output or incorporated into Railgun's error
  messages.
- Authentication recovery favors predictable side effects over seamless
  replay. A user must resubmit after fixing credentials, which prevents tools
  from being executed twice.
