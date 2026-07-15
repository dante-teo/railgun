# Operational diagnostics

Railgun injects a concise runtime block into every general agent session. It
identifies the active surface (`interactive`, `one-shot`, `rpc`, `desktop`, `acp`,
or `cron`), process and version facts, `~/.railgun`, and the fixed configuration,
state, extension, skill, cron, report, and log paths. Delegated agents and rebuilt
model runtimes retain the same surface.

## `railgun_inspect`

The default read-only `railgun_inspect` tool supports five bounded areas:

- `runtime`: surface, Railgun/Node/process facts, cwd, and path inventory.
- `config`: the effective validated configuration. Credential-like keys and all
  MCP `env` values are replaced with `[REDACTED]`. MCP argument redaction covers
  separate credential flag/value pairs, `--key=value`, combined flag/value,
  Bearer, and Authorization forms while retaining ordinary arguments.
- `cron`: daemon status plus normalized job `lastRun`, `lastSuccess`, `lastStatus`,
  and `lastError` fields.
- `logs`: a bounded tail of `interactive-latest.jsonl`, `cron-latest.log`, or
  `desktop-latest.jsonl` selected with `source`.
- `cron_runs`: bounded summaries for a job's hashed report directory, or one
  selected bounded full report.

The caller may request at most 200 lines, jobs, or reports. Log and report excerpts
are capped at 64 KiB; selected oversized reports return a bounded head/tail excerpt.
Configuration and cron state files are rejected above 1 MiB, and serialized tool
output is capped at 128,000 characters. Paths are derived internally; callers cannot supply
arbitrary paths. Cron prompts and tool summaries can appear in cron logs and reports
by their existing design, so the inspector returns them only when that area is
explicitly requested.

Argument redaction cannot reliably identify an unlabelled positional secret. MCP
credentials should be configured in `env`, not as bare positional arguments. The
`railgun config` CLI command remains an operator-facing validation command and
prints effective configuration without redaction; do not share or paste its output.

## Desktop JSONL

Electron main creates one `desktop-<timestamp>-<pid>.jsonl` file per launch and
atomically replaces `desktop-latest.jsonl`. Each line has:

```json
{"timestamp":"2026-07-15T00:00:00.000Z","category":"transport","direction":"stdout","text":"type=response command=get_state id=desktop-ready-1 success=true"}
```

`category` is `transport` or `lifecycle` for records currently persisted;
`direction` is optional. The supervisor sanitizes and bounds structured summaries
once, then uses that exact value for both the desktop snapshot and persistence.
Backend stderr is bounded for the in-memory UI only and is never written to disk,
because MCP processes can emit arbitrary prompts, results, or bare credentials.
Records never contain raw RPC frames or payloads, prompts, tool arguments/results,
commands, environment variables, or credentials. The directory is mode `0700`,
files are `0600`, and prior launch files are pruned after seven days or oldest-first
above a 100 MiB aggregate cap. Initialization and writes are best-effort: an
unwritable diagnostics location does not prevent the desktop from starting. In
that state no launch file or `desktop-latest.jsonl` is created, and a desktop log
inspection reports the fixed latest path as missing.

## Configuration activation

Raw configuration edits must preserve unknown keys and existing MCP entries, avoid
displaying secret values, produce valid JSON, and be checked with `railgun config`.
Configuration and injected instruction state are captured at session/backend
startup. Start a new CLI session or restart a long-lived backend before claiming a
change is active. Diagnose configuration, MCP, extension, cron, interactive, and
desktop failures from inspected state and logs rather than assumptions.
