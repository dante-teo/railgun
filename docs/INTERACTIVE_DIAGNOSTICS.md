# Interactive diagnostics

Railgun creates local diagnostics for fresh and resumed interactive agent
sessions. The diagnostics are always observational: they do not cancel work,
change operation deadlines, or terminate the session.

## Files and lifecycle

Each run writes one newline-delimited JSON file:

```text
~/.railgun/logs/interactive-<timestamp>-<pid>-<run-id>.jsonl
```

`~/.railgun/logs/interactive-latest.jsonl` is an atomically replaced symlink to
the current run. Follow it during a session with:

```sh
tail -f ~/.railgun/logs/interactive-latest.jsonl
```

The directory uses mode `0700` and each run file uses mode `0600`. At worker
initialization, completed logs older than seven days are deleted, then remaining
logs are pruned oldest-first to a 100 MiB aggregate cap.

The main thread gives the worker a bounded shutdown window and then terminates
it. Failure to construct or run the worker does not fail the interactive
session; the TUI displays `logs unavailable` instead.

Only fresh and resumed TUI launches create these files. One-shot, RPC, ACP,
cron, configuration, authentication, import, dream, and session-listing modes
do not initialize interactive diagnostics.

## Record schema

Every line is one bounded JSON object. Fields other than the core envelope are
present only when relevant.

| Field | Type | Meaning |
| --- | --- | --- |
| `timestamp` | ISO-8601 string | Wall-clock time assigned by the writer. |
| `event` | string | Bounded event category, such as `operation_start`, `operation_success`, or `operation_stall`. |
| `severity` | `debug` \| `info` \| `warning` \| `error` | Record severity. |
| `runId` | string | Correlates every record from one interactive launch. |
| `sessionId` | string | Optional persisted-session correlation. |
| `operationId` | string | Optional operation correlation, including tool-call IDs where available. |
| `phase` | string | Fixed operation phase; never prompt or command content. |
| `durationMs` | number | Monotonic elapsed duration, bounded to a safe integer. |
| `outcome` | `start` \| `progress` \| `success` \| `failure` \| `timeout` \| `abort` \| `recovery` | Lifecycle outcome. |
| `model` | string | Optional bounded model identifier. |
| `toolName` | string | Optional bounded tool name. Tool arguments and results are excluded. |
| `errorClass` | string | Optional bounded error classification. |
| `errorMessage` | string | Optional redacted, single-line summary capped at 512 characters. |
| `progressCount` | number | Optional aggregate progress count. |
| `messageCount` | number | Optional aggregate message count. |
| `messageBytes` | number | Optional aggregate byte count; message content is excluded. |
| `terminalColumns` | number | Optional terminal width. |
| `terminalRows` | number | Optional terminal height. |
| `process` | object | Writer PID, Node.js version, and platform. |

Unknown input properties are discarded by a whitelist before serialization.
String metadata is single-line and bounded; numeric metadata is finite,
nonnegative, and bounded.

Example:

```json
{"timestamp":"2026-07-14T01:02:03.000Z","event":"operation_start","severity":"info","runId":"6e72…","operationId":"b1a4…","phase":"provider_stream","outcome":"start","model":"model-a","process":{"pid":1234,"platform":"darwin","node":"v22.19.0"}}
```

## Privacy boundary

Diagnostics never record:

- prompts, clarification questions, or answers;
- assistant or advisor text;
- tool arguments, tool results, or shell commands;
- environment variables, credentials, or authorization values;
- extension payloads;
- cron prompts, skill bodies, or expanded skill content.

Provider deltas are reduced to aggregate counts and byte sizes. Errors are
redacted for credentials, paths, and command-like text before truncation.

Slash commands are observed as operations, including long-running commands such
as `/compact`, `/dream`, and summary branches. Their phases come from a fixed
allowlist (`slash_compact`, `slash_dream`, and similar categories). Skill names
map to `slash_skill`; unknown slash tokens map to `slash_unknown`. User-provided
command or skill tokens are never copied into `phase`.

## Watchdog and progress

The main thread sends a monotonic heartbeat every two seconds. The independent
worker evaluates two conditions:

- `event_loop_stall`: no heartbeat for 10 seconds;
- `operation_stall`: heartbeats remain healthy, but an active non-exempt
  operation has made no progress for 30 seconds.

Idle time and waits for approval or clarification are exempt from operation
stall warnings. An unresolved warning repeats every 30 seconds. The next
heartbeat or operation progress emits one recovery record with the total stalled
duration.

Parent turns and child operations are tracked together. Provider streams,
tools, compaction, MoA, and advisor/subagent work become the current watchdog
phase while active; parent progress is recorded before child progress so it
cannot overwrite the more specific child phase.

## TUI status

The status bar displays `ready` with no active operations. When work begins after
idle, elapsed time resets to the first operation's start. For overlapping work,
elapsed time is measured from the earliest still-active operation and parallel
tools render as `tools (N)`. Ending a child restores its active parent phase.

An operation stall is shown prominently with the stable latest-log path. A
diagnostics initialization or worker failure shows `logs unavailable`; neither
state crashes or cancels the session.
