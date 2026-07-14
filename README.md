# railgun

A from-scratch TypeScript replication of [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s
core agent loop, built incrementally, phase by phase (see
[`docs/PRODUCT.md`](docs/PRODUCT.md)). The REPL's agent can read and write
files, list directories, run shell commands (gated behind a three-tier risk
classifier — catastrophic commands blocked unconditionally, dangerous ones
requiring approval or LLM review, safe ones running immediately), and maintain
a flat todo plan before answering. It also has zero-configuration, read-only
internet access for public web search and readable page extraction, looping the conversation with Devin until it
has a final text answer. The loop is hardened with
parallel-safe tool batching, corrupted tool-call JSON self-healing,
transient API retry, automatic context compaction, and a 90-step
iteration budget. In the REPL that budget is shared for the process lifetime; in one-shot mode each invocation
gets a fresh budget. Exhausting it is a graceful stop, not a failure.
Interactive conversations and todos are checkpointed to a private local
SQLite database and can be resumed across restarts. An extension system lets
outside code hook the agent lifecycle — block or observe tool calls, rewrite
results, intercept user input, and register new LLM-callable tools — by
placing `.js` or `.ts` files in `~/.railgun/extensions/`. The agent can also spawn bounded subagents via `delegate_task`, fanning a task out to up to three independent child loops running concurrently, with configurable depth limits and automatic parent-abort propagation. The REPL is a full-screen,
resize-aware Ink interface with automatic mint-light/mint-dark appearance,
Markdown replies, transcript history navigation, a multiline composer, slash
commands (`/exit`, `/help`, `/clear`, `/model`, `/compact`), and Tab completion. A `.railgun.md` (or
`RAILGUN.md`) found in the project tree (walking up to the git root), or
an `AGENTS.md`/`agents.md`, `CLAUDE.md`/`claude.md`, or `.cursorrules` in the working directory,
 is loaded into the system prompt automatically at session startup — as is
 a personal `~/.railgun/SOUL.md` — with untrusted content truncated and
 scanned for prompt-injection patterns before use. The agent is explicitly
 told it can create or update `~/.railgun/SOUL.md` using `write_file`; changes
 take effect on the next session. The `/dream` command and `railgun dream` CLI
 mode can also promote stable preferences into `SOUL.md` automatically.

## Prerequisites

- Node.js >= 22.19.0
- pnpm 11.11.0 (pinned by `packageManager` in `package.json`)
- A Devin/Cascade account you are permitted to access programmatically (see
  [Compliance](#compliance) below)

## Supported surfaces

Railgun is a Node.js package with four published entry points and one private
desktop workspace:

- the full-screen terminal REPL (`pnpm start`)
- one-shot terminal output (`pnpm start --print "..."`)
- JSONL RPC over stdio (`--mode rpc`)
- Agent Client Protocol over stdio (`--mode acp`)
- the macOS Electron desktop (`pnpm dev` or `pnpm dev:mock`)

The Electron app is not part of the published CLI package. There is no daemon
or socket service in this repository. Installation, scripts, dependency
resolution, and lockfile management use pnpm.

## Install

Install the published CLI globally with pnpm:

```sh
pnpm add --global @dantea/railgun
railgun config
```

`railgun config` is a non-interactive installation check that prints the
effective configuration as JSON without authenticating. Run `railgun` to open
the interactive REPL.

To work from a repository checkout instead:

```sh
pnpm install
```

## Run

```sh
pnpm start
```

`pnpm start` with no arguments opens a fresh full-screen Ink chat REPL in the
terminal's alternate screen buffer. The original terminal contents are
restored on normal exit, Ctrl+C, cancellation, and errors. Alternate-screen
mode is skipped for non-TTY output and when `INK_SCREEN_READER=true`. The
session becomes durable after its first successful turn:

- **Automatic appearance**: Railgun first asks the terminal whether its canvas
  is light or dark, then falls back to the OS appearance and finally dark.
  Terminal and OS changes repaint the interface live. The terminal's own canvas
  background remains untouched. Appearance is not configurable.
- **Configuration**: `~/.railgun/config.json` is the single configuration
  source. A missing file has the effective defaults `{ "model": null,
  "defaultProjectTrust": "ask", "operationTimeoutMs": 600000 }`, which
  selects the first model returned by Devin. Unknown fields are preserved;
  malformed files and invalid recognized values fail without automatic repair.
  Optional recognized fields: `model` (string or null), `approvalMode`
  (`"manual"` | `"smart"` | `"off"`, default `"manual"`), `operationTimeoutMs`
  (positive integer, default `600000`), and `reviewerModel`
  (string — the Devin model ID used for smart-mode LLM review; defaults to the
  session model when absent).
- **Authentication**: a nonempty, trimmed `DEVIN_TOKEN` takes precedence for
  this process and is never persisted. Otherwise Railgun reuses
  `~/.railgun/devin-token` (mode `0600`), opening browser sign-in only when
  that cache is absent. Whitespace-only `DEVIN_TOKEN` values count as absent.
- Type a message and press Enter to send it; Shift+Enter inserts a newline in
  terminals supporting enhanced keyboard reporting. The composer grows from
  one through six rows (and caps lower in short terminals), preserves multiline
  paste, and remains active while the agent works so Enter can queue steering
  for the next assistant/tool boundary. A temporary queued indicator appears
  immediately; the normal `YOU` row is appended only when the steering message
  enters model history. The composer is modal and disabled only during shell
  approval or model selection. Tab completes an
  active slash suggestion and moves the cursor to the completed value's end;
  otherwise it is reserved for future message enqueue. `Ctrl+U` clears the
  complete draft.
  Every prior turn is sent as context on the next turn. After
  each successful turn, messages and todos are atomically checkpointed to
  `~/.railgun/state.db`; the full session ID prints after the first save and
  its short form remains in the status line.
- Ask something that requires reading a file in the working directory
  (e.g. `"What does notes.txt say?"`) and the REPL calls `read_file`
  automatically and uses its contents to answer. While the tool runs, a
  live spinner line shows `Reading notes.txt` in place of the streaming
  placeholder; once it finishes, a permanent `✓ Reading notes.txt` line
  stays in the scrollback (or `✗ ...` on failure) — the tool's raw result
  content itself is never shown, only this verb+arg label. `write_file`
  and `list_directory` show the equivalent `Writing`/`Listing` labels. A
  parallel-safe batch of tool calls (e.g. reading two different files in
  one round) collapses to a single `Running N tools concurrently` line
  and one `✓ N/N tools completed` line, not one pair per call.
  Assistant narration is committed before the tool row that follows it, so
  multi-step turns retain chronological user → assistant → tool ordering.
- Ask about current or unfamiliar information and the agent can use `web_search`
  to discover public pages, then `web_fetch` to extract useful text from them.
  Search returns up to 10 results through an automatic provider chain. It uses
  configured Brave, Tavily, Jina, or SearXNG credentials when available, then
  Exa's public MCP endpoint; the unofficial DuckDuckGo scraper is only a final
  fallback and may be rate-limited or challenged. Configure providers with
  `BRAVE_API_KEY`, `TAVILY_API_KEY`, `JINA_API_KEY`, or `SEARXNG_ENDPOINT`
  (`SEARXNG_TOKEN` is optional). `web_fetch` supports HTML, plain text,
  and JSON with bounded redirects, response size, time, and output. It does not
  execute page JavaScript, click or submit forms, parse PDFs, or access localhost
  and private/reserved networks. Every redirect is revalidated against DNS to
  prevent a public URL from redirecting into a private service.
- Ask for a multi-step plan and the model can call the `todo` planning
  tool. The REPL renders the current flat todo list in a sticky
  panel above suggestions, approval, and the composer, with a
  `Todos · completed/total` header and per-item
  status glyphs (`[ ]`/`[>]`/`[x]`/`[-]`). While a todo update is in
  flight, an empty panel shows a `Crafting todos` spinner. Todo activity
  is intentionally not echoed as normal `✓ todo ...` transcript lines.
  Interactive todo state is saved with the conversation and restored on
  resume. One-shot todo state remains invocation-local.
- Ask it to run a shell command and it passes through a three-tier risk gate
  before anything executes. **Hardline** commands (`rm -rf /`, `mkfs.*`,
  `shutdown`/`reboot`, fork bombs, `dd of=/dev/<disk>`) are refused immediately
  with no prompt, regardless of configuration. **Dangerous** commands (`rm -r*`,
  `sudo`, `git push --force`, `DROP TABLE`, block-device redirects,
  world-writable `chmod`, `curl | bash`) go through the configured approval
  tier: `"manual"` (default) freezes the composer and shows
  `APPROVAL · Run shell command: <command> [y/n]` — press `y` to run, `n`/Esc
  to decline; `"smart"` consults an LLM reviewer first and only falls through
  to the human prompt when the reviewer is uncertain; `"off"` skips the prompt
  (hardline blocks still apply). **Safe** commands run immediately. Once a
  pattern class is approved in a session (e.g. `sudo`), that class is not
  re-prompted for the rest of the conversation. Ctrl+C while approval or agent
  work is active cancels that run without closing Railgun; an approved shell's
  complete POSIX process group is terminated. Completed side effects and todo
  changes remain, while queued steering is discarded.
- A REPL session has one shared 90-step iteration budget across all turns.
  Each Devin/tool-call round consumes one step. If the budget is exhausted,
  the assistant prints
  `I've reached the iteration limit for this session, so I'm stopping here gracefully.`
  and the REPL stays open.
- Completed assistant replies render as GFM Markdown, including wrapping,
  links, tables, lists, inline code, and fenced code boxes with language labels.
  Partial streaming text remains plain until the reply completes.
- Transcript history: the mouse wheel scrolls by rows; PageUp/PageDown move by
  a viewport; Home/End jump to the bounds. An unseen-output cue reserves a
  visible row when new output arrives while scrolled up. New output and terminal
  resizes continue following only when the viewport was already at the bottom.
- Slash commands:
  - `/exit` — quit the REPL. Ctrl+C exits when no agent/approval is active;
    otherwise it cancels the active run and returns to the composer.
  - `/help` — print the list of available commands.
  - `/clear` — clear the terminal canvas without discarding conversation state.
  - `/model` — open an interactive model picker (Up/Down to navigate, Enter to switch and save, Esc to cancel).
  - `/model <name-or-index>` — switch the active model directly and save as the new default.
  - `/model <name-or-index> --session` — switch for this session only (not saved).
  - `/model --session` — open the picker; the selected model applies to this session only.
  - `/compact` — manually summarize and compact the current conversation history now, without waiting for the automatic 90%-context-window trigger. Prints `Compacted conversation history to stay under the context limit.` on success.
  - `/dream` — manually trigger memory consolidation. Reviews all stored memories, merges duplicates, deletes stale entries, and promotes stable user preferences to `~/.railgun/SOUL.md`. Requires at least 5 stored memories. Progress lines appear in the transcript.
  - `/cron` — list all scheduled jobs.
  - `/cron add <id> <schedule> <prompt>` — create a new cron job. `<schedule>` is a 5-field cron expression (e.g. `0 9 * * *`); `<prompt>` is the remainder of the line. Validates the expression and rejects duplicate ids.
  - `/cron remove <id>` — delete a scheduled job by id.
  (The agent tool can also manage jobs via natural language — ask "list my scheduled tasks" or "add a daily summary job".)
- **Tab-completion**: type `/` to see a dropdown of matching slash
  commands as you type; press Tab to complete an unambiguous match, or
  `Esc` to dismiss the dropdown.
- **Per-turn error**: a failed turn (e.g. an expired token) prints a red
  one-line error into the transcript and the REPL stays open for the next
  message — it does not exit the process. A rejected cached credential is
  removed automatically; run `pnpm start login` in another terminal, then
  manually resubmit the failed message in the still-open REPL. A rejected
  environment credential is never removed from disk: update or unset
  `DEVIN_TOKEN` instead. Failed turns are never replayed automatically.
  Todo changes from the failed turn are rolled back, though file and shell
  side effects already performed by tools cannot be undone.
- **Checkpoint error**: a completed turn stays usable in memory and the
  status line shows `unsaved`. The next successful turn retries the complete
  pending snapshot; a recovery message appears once persistence succeeds.
- **Context compaction**: after each turn step, if the model's reported
  input+output token usage reaches 90% of its context window, Railgun
  automatically summarizes the conversation and replaces history with a
  single compacted message (recent user turns plus an LLM-generated
  handoff summary), then continues the turn — the same mechanism the
  manual `/compact` command triggers on demand. If Devin itself rejects a
  request as too large (HTTP 413), Railgun compacts reactively and retries
  the same request, up to 3 compaction attempts before giving up.

### Authentication commands

```sh
pnpm start login
pnpm start logout
```

`login` always starts fresh browser OAuth. The existing cached credential stays
in place until OAuth returns a replacement, which Railgun saves and verifies
with model discovery. A verification 401 removes the replacement and fails;
other API or protocol verification failures retain it and report that it was
saved but could not be verified. If `DEVIN_TOKEN` is set, Railgun warns that it
still overrides the new cache.

`logout` idempotently removes only the cached credential and succeeds when no
cache exists. If `DEVIN_TOKEN` is set, Railgun warns that environment-based
authentication remains active. These commands do not open SQLite, load project
context, initialize a chat session, or start the TUI. They are exact
subcommands: `login`/`logout` do not accept extra arguments and have no flag
aliases.

HTTP 401 is never retried. Railgun retries HTTP 408, 429, and 5xx responses and
fetch-style transport failures up to three total attempts, waiting 500ms then
1000ms. HTTP 413 (payload too large) triggers context compaction and retry
instead, up to 3 attempts, with no backoff delay. Other 4xx responses,
protocol failures, and unrelated errors fail immediately.

### Configuration

Run `/settings` in the interactive REPL to configure the primary model, the
persisted default MOA preset, and the advisor. Pickers use Up/Down, Enter, and
Escape; confirmed changes apply to subsequent turns and are atomically saved to
`~/.railgun/config.json`. Bare `/moa` opens a session-only preset picker.
Long lists open with the current selection already scrolled into view.

When enabled, the advisor reviews completed primary-model steps with read-only
filesystem access (`read_file`, `list_directory`) and can query the user's saved
memories (`memory_search`) and imported notes (`note_search`) to detect responses
that contradict known facts or preferences.
It stays silent when it finds no meaningful issue and emits at most one steer per
user request, even when the primary agent takes multiple internal steps. Silent
reviews do not consume that allowance, and a later user request can receive
fresh advice. Notes appear as dedicated `ADVISOR` transcript rows rather than
user messages: green `NIT`, amber `CONCERN`, or red `BLOCKER`.
The XML envelope used internally is decoded before display and removed from
persisted history, so advisory steering cannot invalidate session checkpoints.

```sh
pnpm start config
```

`config` prints the effective configuration as pretty JSON. It is an exact,
read-only subcommand: extra arguments are usage errors, and it does not
authenticate, open SQLite, create files, or enter the TUI. Recognized fields:

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string \| null | `null` | Devin model ID to use for new sessions; `null` selects Devin's first available model |
| `approvalMode` | `"manual"` \| `"smart"` \| `"off"` | `"manual"` | Shell command approval tier: manual y/n prompt, LLM review, or no prompt (hardline blocks always apply) |
| `reviewerModel` | string | _(session model)_ | Devin model ID used for smart-mode LLM review; omit to use the same model as the session |
| `operationTimeoutMs` | positive integer | `600000` | Per-operation deadline for providers, tools, extensions, listeners, compaction, and delegated work; approval and clarification prompts have no automatic deadline |

Unknown fields are preserved on read and write. Malformed files and invalid recognized values fail without automatic repair.

Async operations yield Node's event loop while they wait. A synchronous, CPU-bound extension can still block the process and cannot be preempted without worker or process isolation.

If a configured model disappears, an interactive launch opens the themed,
resize-aware model chooser. Up/Down wraps, Enter atomically saves the selected
replacement before startup continues, and Escape/Ctrl-C cancels successfully
without changing configuration or starting a session. A non-interactive launch
instead exits nonzero and lists the unavailable ID, available IDs, and how to
launch interactively. Resumed conversations remain pinned to their recorded
model and never use this recovery path. The REPL's `/model` command opens an
inline interactive picker (Up/Down, Enter, Esc) to switch the active model
live; by default the choice persists to `config.json` for all future sessions,
while `--session` limits the switch to the current REPL run. `/model <name>`
switches directly without the picker.

All application files derive from the fixed `~/.railgun` home: `config.json`,
`devin-token`, `state.db`, `SOUL.md`, `extensions/`, and `cron/jobs.json`. There are no profiles or home-path
overrides.

### Extensions

Drop a `.js` or `.ts` file (or a subdirectory with an `index.js`/`index.ts`) into
`~/.railgun/extensions/` to hook into the agent's lifecycle. Each extension
default-exports a factory function:

```js
export default function myExtension(api) {
  // Block a specific tool
  api.on("tool_call", ({ toolName }) => {
    if (toolName === "run_shell_command") {
      return { block: true, reason: "Shell blocked by extension." };
    }
  });

  // Log tool durations
  api.on("tool_result", ({ toolName, durationMs, isError }) => {
    process.stderr.write(`[ext] ${toolName} ${durationMs}ms ${isError ? "err" : "ok"}\n`);
  });

  // Intercept user input
  api.on("input", ({ text }) => {
    if (text.startsWith("!")) {
      process.stderr.write(`[ext] suppressed command: ${text}\n`);
      return { action: "handled" };          // silently consume, agent never sees it
    }
    // or: return { action: "transform", text: text.toUpperCase() };
  });

  // Register a new LLM-callable tool
  api.registerTool({
    name: "current_time",
    description: "Returns the current ISO timestamp.",
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => ({ content: new Date().toISOString() }),
  });
}
```

**Event reference:**

| Event | When | Handler can return |
|---|---|---|
| `tool_call` | Before every tool dispatch | `{ block: true, reason? }` to block; `void` to pass through |
| `tool_result` | After every tool dispatch | `{ content?, isError? }` overrides; `void` to pass through |
| `input` | Before each user message reaches the agent | `{ action: "transform", text? }` to rewrite; `{ action: "handled" }` to consume silently |
| `session_start` | Once per session, before the REPL/one-shot starts | `void` (observer only) |
| `session_shutdown` | Once per session, after the REPL/one-shot exits | `void` (observer only) |

**Error isolation:** a throwing `tool_call` handler fails that single call closed (the agent gets an error tool result) without crashing the session. All other handler throws are caught, logged to stderr as `[extension error]`, and do not affect remaining handlers.

**Trust:** project-local extensions (`.railgun/extensions/` in the working directory) are loaded alongside global ones. There is no sandbox — extension code runs with the same OS process privileges as Railgun.

**Development runtime:** `pnpm start` runs under `tsx`, so `.ts` extension files import directly. A compiled `dist/` build requires pre-compiled `.js` extensions.

### Saved sessions

```sh
pnpm start --resume <session-id>
pnpm start --resume
pnpm start -r <session-id>
pnpm start -r
pnpm start --list-sessions
```

`-r` is the short alias for `--resume`; both accept an optional session ID.
`--resume <session-id>` restores that conversation and its todos. Railgun
requires the saved model to still be available and fails clearly instead of
switching models. Bare `--resume` opens a newest-first, full-screen chooser
using the same live mint theme. Use Up/Down to highlight a session (navigation
wraps at either end) and press Enter to resume it; Escape or Ctrl-C cancels
successfully. The list viewport follows selection and terminal resizes.
`--list-sessions` prints the detailed table without authenticating to Devin.
If there are no sessions, both commands print `No saved sessions.` and exit
successfully. Resumes rebuild the system prompt, project context, and personal
identity from the current launch directory and start with a fresh 90-step
process budget. Historical user/assistant text is restored to scrollback;
historical tool frames are intentionally not reconstructed.

Missing IDs, corrupt saved state, database failures, and unavailable saved
models exit nonzero with an actionable error. Treat `state.db` as private
application state rather than editing it manually; stop Railgun before making
a backup so the database and its WAL are consistent.

### Manual persistence smoke test

1. Run `pnpm start`, complete a memorable turn, and copy the printed session
   ID.
2. Exit with `/exit`, then run `pnpm start --resume <session-id>` and ask a
   follow-up that depends on the remembered turn.
3. Run bare `pnpm start --resume`, move with Up/Down, and press Enter to resume.
4. Run `pnpm start --list-sessions` and confirm sessions appear newest-first
   with model, message count, full ID, and preview fields.
5. Run a `--print` question and confirm a second `--list-sessions` produces the
   same saved-session list.

### One-shot / scripting mode

```sh
pnpm start --print "What is the capital of France?"
pnpm start -p "What is the capital of France?"
```

`--print`/`-p` now runs the same tool-calling turn loop as the REPL (file
read/write, directory listing, shell commands, and the in-memory todo
planning tool) instead of Phase 1's plain no-tools stream, but keeps Phase
1's stdout/stderr contract: a single
question in, the streamed answer on stdout, status/progress messages (model
selection, login prompt, and — if the model calls `run_shell_command` — the
approval prompt) on stderr, and a non-zero exit code with a one-line error
on failure. `pnpm start --print` alone (no question text) sends the default
question `"Hello!"`. While a tool runs, the same live spinner+label
(e.g. `Reading notes.txt`) and final `✓`/`✗` line print to stderr, never
stdout, so `pnpm start --print "..." | some-other-tool` still pipes only
the answer text.

Each `--print`/`-p` invocation gets its own fresh 90-step iteration budget.
If it is exhausted, the limit message is printed as the successful answer
text and the process exits normally.

Automatic context compaction (see above) applies equally to `--print`/`-p`:
usage crossing 90% of the model's context window triggers summarization
mid-invocation, and a too-large request (HTTP 413) triggers reactive
compaction and retry. The manual `/compact` slash command is REPL-only —
one-shot mode has no interactive command surface.

Todo planning in `--print`/`-p` operates silently on stdout: there is no
persistent panel and todo results do not appear in the final answer text.
The generic stderr tool spinner still fires for all tools including `todo`.

If the model calls `run_shell_command`, `--print`/`-p` prompts on stderr
with `Run shell command: <command>` and blocks reading a line from stdin —
type `yes` to run it, anything else (including EOF) declines. This is a
blocking, interactive prompt: piping stdin closed or non-interactive
(e.g. `< /dev/null`) resolves immediately to "declined" rather than
hanging, but leaving stdin open and unanswered (e.g. a backgrounded process
with no controlling terminal) blocks indefinitely until answered.

One-shot mode never opens the session database and never creates or updates a
saved session.

### Cron scheduler

```sh
pnpm start cron
```

`cron` runs the agent on a schedule without human input. Jobs are defined in `~/.railgun/cron/jobs.json`:

```json
[
  {
    "id": "daily-summary",
    "schedule": "0 9 * * *",
    "prompt": "Summarize what files changed in the current directory today.",
    "lastRun": null
  }
]
```

Each job has a cron expression (`schedule`, interpreted in local time), a `prompt` sent to a fresh agent session, and a `lastRun` epoch timestamp (or `null` for never run). The scheduler wakes every 60 seconds, checks which jobs are due, and runs them sequentially. After each cycle it writes the updated `lastRun` values back to `jobs.json` atomically. The file is re-read every cycle so edits take effect without restarting.

Behavior in cron mode:
- Each job gets a **fresh 30-step iteration budget** and a **fresh session** — no conversation history, no session database entry.
- Shell commands are **denied by default** unless `approvalMode: "off"` is set in `config.json` (hardline-blocked commands always apply).
- Extensions are **not loaded** — unattended safety.
- Output (text deltas, tool start/end) is logged to **stderr** only.
- Press **Ctrl+C** or send **SIGTERM** to stop the scheduler cleanly after the current job finishes.

A missing `~/.railgun/cron/jobs.json` is treated as an empty list — the scheduler runs but never fires. The `schedule` field uses standard cron syntax (`* * * * *` — minute, hour, day-of-month, month, day-of-week); five-field expressions are supported via `cron-parser`.

Jobs can now be managed without editing the file directly: the `/cron` REPL slash command (`/cron`, `/cron add`, `/cron remove`) provides quick in-session access, and the agent `cron` tool (`action: list|add|remove|update`) lets the LLM manage jobs on behalf of the user via natural language.

Any other positional argument is a usage error. `pnpm start "no flag"` prints
the supported `login`, `logout`, `--print`, `--resume`/`-r`, and
`--list-sessions` usage to stderr and exits non-zero without launching anything.

### Working directory override

```sh
pnpm start --cwd <dir>
pnpm start -C <dir>
```

`--cwd`/`-C` changes the process working directory to `<dir>` before any other
startup step runs. All downstream `process.cwd()` calls — project-context
discovery, trust-store resolution, system-prompt injection — naturally pick up
the new directory. Tilde prefixes (`~/`, `~`) are expanded even when the shell
does not expand them (e.g. a quoted `"~/projects"`). The flag accepts any
valid path; an absent or non-directory path causes `process.chdir` to throw
`ENOENT`/`ENOTDIR`, which the top-level error handler prints before exiting
non-zero. Omitting `--cwd` leaves the working directory unchanged — identical
to current behavior. The flag is compatible with all modes and is processed
before mode dispatch.

Missing value (`pnpm start --cwd` with no argument) is a usage error and prints
the usage string with exit code 1.

### RPC mode

```sh
railgun --mode rpc
```

`--mode rpc` runs Railgun headlessly as one process per client. The protocol is
JSONL over stdio: the client writes one JSON command per line to stdin, and the
process writes responses and events as JSON lines to stdout. There is no shared
socket server or gateway; each client spawns its own `railgun --mode rpc`
process.

Each command is a JSON object with a `type` field and an optional `id` field:

| Command | Required fields | Description |
|---|---|---|
| `prompt` | `message` (string) | Start a new agent run with the given user message. |
| `steer` | `message` (string) | Send a steering message while a run is in progress. |
| `follow_up` | `message` (string) | Send a follow-up message while a run is in progress. |
| `abort` | — | Cancel the current run. |
| `get_state` | — | Return lightweight session state. |
| `get_messages` | — | Return the current message transcript. |
| `set_model` | `modelId` (string) | Switch to the given Devin model ID. |
| `get_available_models` | — | Return the list of available Devin models. |
| `compact` | — | Trigger manual context compaction. |
| `set_auto_compaction` | `enabled` (boolean) | Enable or disable automatic context compaction (currently no-op). |

Responses are JSON objects with the same `id` as the command (if any),
`type: "response"`, `command` set to the command type, and a `success` boolean:

```json
{ "id": "1", "type": "response", "command": "prompt", "success": true }
```

When `success` is `false`, the response includes an `error` string instead of
`data`. When `success` is `true`, `get_state`, `get_messages`, and
`get_available_models` include a `data` object; other commands omit `data`.

Events are raw `AgentSessionEvent` objects (no wrapper envelope) and are emitted
as each occurs:

- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_end`
- `compaction_start`
- `compaction_end`
- `subagent_start`
- `subagent_end`
- `agent_settled`
- `queue_update`

Only one prompt can be in flight at a time. A second `prompt` while a run is
already running returns an error response with `success: false`. `steer`,
`follow_up`, and `abort` work only while a run is in progress; sending them
while idle returns an error response.

When stdin reaches EOF, any in-flight run is aborted and the process exits
cleanly.

Shell commands are auto-approved in RPC mode because there is no human at the
terminal; the configured `approvalMode` still applies but the human confirmation
callback always returns true. The `clarify` tool throws as a tool error and
surfaces in the transcript.

These are the unchanged legacy semantics. Desktop-capable clients may opt into
protocol v1 before the first run:

```json
{ "id": "init", "type": "initialize", "version": 1, "clientName": "my-client" }
```

The handshake returns `version` and `capabilities`. V1 adds persistent session
commands (`session_new`, `session_list`, `session_load`, `session_save`,
`session_branch`, `session_fork`, `session_recent_messages`), interactive
`approval_request`/`approval_response` and
`clarification_request`/`clarification_response` pairs, and config/MCP, cron,
memory, notes, and skills management commands. Active transcripts checkpoint
after completed or aborted runs; enhanced `get_state` reports session identity
and persistence status. MCP responses expose environment key presence but never
secret values. See [ADR 0032](docs/adr/0032-versioned-desktop-rpc.md) for the
compatibility and lifecycle rules.

`initialize` is accepted once and only before a run starts. An unsupported
version returns a correlated error without changing the connection from legacy
mode. In protocol v1, session mutations, model changes, and manual compaction
are serialized, so a pending compaction cannot write its transcript into a
newly activated session. Loading or forking a session resolves that session's
model metadata and model-specific prompt before it becomes active. Changing
the model of a persisted session creates a new unsaved session identity with a
copy of the active transcript and todos; it never rewrites the saved session's
immutable model metadata.

`--approve` and `--no-approve` are incompatible with `--mode rpc` and produce a
usage error.

Minimal example:

```sh
echo '{"id":"1","type":"prompt","message":"What is 2+2?"}' | railgun --mode rpc
```

This pipes a single command to the process and prints interleaved JSONL event
and response lines to stdout.

## Development

Launch the Electron desktop against the real Railgun RPC process or its
deterministic mock process:

```sh
pnpm dev
pnpm dev:mock
```

`pnpm dev:mock` opens the same desktop chat shell as real mode, backed by the
deterministic JSONL child instead of the Devin provider. Mock behavior belongs
in `apps/desktop/src/mock/scenarios.ts`, not renderer fixtures; scenario and
transport controls live under Settings diagnostics rather than replacing the
product UI. New Chat restarts the supervised backend before clearing the
transcript, so the next prompt has empty RPC history in both modes. Aborting a
mock prompt cancels all remaining scheduled output and settles its pending RPC
response before another prompt can start.

The real desktop backend never opens browser OAuth implicitly. If its cached
credential is missing or rejected, run `pnpm start login` in Terminal and use
Retry. If `DEVIN_TOKEN` is rejected, update or unset it in the environment that
launches the app and relaunch Railgun; a cached login cannot override that
environment credential.

The native desktop shell supports `⌘N` for New Chat, `⌘K` for the command
palette, `⌘1` for Chat, `⌘,` for Settings, and `⌃⌘S` to toggle the sidebar.
The sidebar can be resized by dragging its separator or with the arrow, Home,
and End keys while the separator is focused; double-click resets its width.
Pane widths persist locally across launches, while sidebar visibility remains
session-only. Standard macOS Control-only editing keys are left untouched.
Native context menus expose only applicable Undo/Redo, Cut/Copy/Paste, and
Select All actions.

Run the desktop checks and create a local Electron package with:

```sh
pnpm --filter @dantea/railgun-desktop typecheck
pnpm --filter @dantea/railgun-desktop test
pnpm --filter @dantea/railgun-desktop build
```

Desktop `build` intentionally runs the complete Forge packaging pipeline; the
desktop-local `package` command is an equivalent explicit name. The package is
written beneath `apps/desktop/out/`. Before Forge runs, the build compiles the
root CLI and stages a production-only deployment plus the bundled mock backend
in the ignored `apps/desktop/backend/` directory. Forge copies those files to
`Resources/backend`, and the packaged app launches them with Electron's
embedded Node runtime. It therefore does not require a repository checkout or
a separately installed Node.js or pnpm at runtime.

The packaged renderer uses `railgun://app/`, not `file://`. IPC is restricted
to the known main frame and all preload traffic is runtime-validated.
Production fuses intentionally retain `RunAsNode` for the packaged real/mock
backend launcher while disabling Node options, CLI inspection, and extra
file-protocol privileges. Development uses Forge's exact origin and a CSP hash
for Vite's injected React Refresh preamble rather than allowing arbitrary
inline scripts.

Desktop typography is fully offline: the renderer bundles Barlow Variable for
interface text and Departure Mono Nerd Font for code, diagnostics, and
transport logs. The [Barlow provenance record](apps/desktop/src/renderer/public/fonts/barlow/SOURCE.md)
and [Departure Mono Nerd Font provenance record](apps/desktop/src/renderer/public/fonts/departure-mono-nerd-font/SOURCE.md)
link their upstream releases and colocated SIL Open Font License notices.

```sh
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest run — includes real temporary-SQLite persistence tests and CLI/REPL/session coverage
pnpm run build       # compile src/ to dist/
pnpm run smoke:package # build, launch the packaged CLI, and validate `railgun config` JSON output
```

`smoke:package` runs the built executable through a temporary symlink on
POSIX, matching pnpm's global-bin launch behavior. On Windows it invokes the
built script with Node because creating symlinks may require Developer Mode or
elevated privileges. The smoke check uses an isolated temporary home directory,
cleans it in all outcomes, and runs automatically during `prepublishOnly` after
typechecking and tests.

The Ink REPL UI is supported by automated tests for its pure state and
rendering helpers, alongside tests for
`src/agent/turn.ts` (turn/history loop), `src/agent/toolDispatch.ts`
(parallel-batch safety, corrupted-JSON detection), `src/agent/recovery.ts`
(API failure classification and retry), `src/agent/compaction.ts`
(token-budgeted history summarization and truncation), `src/agent/projectContext.ts`
(context-file discovery, git-root walk, injection scan, truncation,
`SOUL.md` loading), `src/security/threatPatterns.ts` (injection-pattern
matching), `src/tools/cron.ts` (cron job management) and each tool's own handler logic in `src/tools/` (including delegation depth/concurrency/abort propagation for `delegate_task`, plus web extraction and SSRF defenses),
`src/commands.ts` (slash-command prefix matching and parsing), theme detection,
physical-row viewport/navigation, mouse parsing and lifecycle cleanup, composer
sizing/actions, chronological streaming/tool segmentation, terminal resizing,
Markdown output, todo rendering, and session chooser navigation.

## Compliance

Railgun talks to Devin through the [`widevin`](https://github.com/dante-teo/widevin)
npm package. Only use programmatic Devin/Cascade access when your organization
and Devin's terms permit it — this is an operational responsibility, not
something the code enforces. See
[`docs/adr/0001-single-provider-devin-via-widevin.md`](docs/adr/0001-single-provider-devin-via-widevin.md).

## Docs

- [`docs/PRODUCT.md`](docs/PRODUCT.md) — what this project is and why
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, data flow, integrations
- [`docs/DESIGN.md`](docs/DESIGN.md) — CLI interaction model
- [`docs/adr/`](docs/adr/) — architectural decision records
