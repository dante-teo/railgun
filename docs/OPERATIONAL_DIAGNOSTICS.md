# Operational diagnostics

Railgun injects a concise runtime block into every general agent session. It
identifies the active surface (`desktop` or `cron`), process and version facts,
`~/.railgun`, and the fixed configuration,
state, extension, skill, cron, report, and log paths. Rebuilt model runtimes
retain the same surface.

## `railgun_inspect`

The default read-only `railgun_inspect` tool supports five bounded areas:

- `sessions`: the stored non-archived session summaries.
- `memories`: up to 20 saved memories.
- `cron`: the current cron job definitions and their recorded run state.
- `paths`: a fixed configured-state summary for state, cron, and skills paths.
- `config`: whether the state database and cron definition files exist.

The tool derives every path internally; callers cannot supply arbitrary paths.
Its serialized output is capped at 200,000 characters. It intentionally does
not return configuration contents, credentials, MCP environment values, logs,
or cron reports. Use the app's Settings controls for ordinary configuration
changes and inspect the relevant bounded area instead of assuming runtime
state.

## Configuration activation

Raw configuration edits must preserve unknown keys and existing MCP entries, avoid
displaying secret values, and produce valid JSON. Configuration and injected
instruction state are captured at backend startup. Restart the backend before
claiming a change is active. Diagnose configuration, MCP, extension, cron, and
desktop failures from inspected state and logs rather than assumptions.

The renderer-facing configuration RPC is a security boundary: `config_get` and
`config_update` never return the stored `mcpServers` object. MCP commands expose
only the dedicated projection, where environment variable names may be shown
but values are never returned. MCP changes must use those commands so an
unrelated configuration update cannot echo persisted credentials onto RPC
stdout.
