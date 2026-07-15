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
commands, and Tab completion. A `.railgun.md` (or
`RAILGUN.md`), `AGENTS.md`/`agents.md`, `CLAUDE.md`/`claude.md`, or
`.cursorrules` in the user's home directory
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

The Electron app is not part of the published CLI package. Installation,
scripts, dependency resolution, and lockfile management use pnpm.

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

### Interactive diagnostics

Fresh and resumed TUI sessions always write privacy-safe JSONL diagnostics locally.
To follow the current run:

```sh
tail -f ~/.railgun/logs/interactive-latest.jsonl
```

Records contain lifecycle metadata, phases, elapsed durations, outcomes, aggregate
message sizes/counts, model and tool names, error classifications, process metadata,
and terminal dimensions. They never contain prompts, assistant text, tool arguments
or results, shell commands, environment variables, credentials, or extension
payloads. Error summaries are redacted and truncated.

The worker reports an event-loop stall after 10 seconds without a main-thread
heartbeat and an operation stall after 30 seconds without progress. Approval,
clarification, and idle waits are exempt; unresolved warnings repeat every 30
seconds and recovery is recorded once. Detection never cancels the operation.
Logs use private directory/file permissions, expire after seven days, and are pruned
oldest-first to a 100 MiB total cap. Non-interactive modes create no interactive log.
See [Interactive diagnostics](docs/INTERACTIVE_DIAGNOSTICS.md) for the exact JSONL
schema, privacy boundary, phase rules, and watchdog lifecycle.

### Operational inspection

Every conversational surface—interactive, one-shot, RPC, desktop, ACP, and cron—
receives a `Railgun runtime` context and the read-only `railgun_inspect` tool. When
asked about a Railgun failure, the agent can inspect runtime paths and versions,
effective redacted configuration, cron daemon/job health, bounded interactive,
cron, or desktop log tails, and bounded per-job cron reports. The tool resolves
only Railgun-owned paths beneath `~/.railgun`. Configuration inspection redacts
credential-like keys, every MCP environment value, and credential-bearing MCP
argument forms such as `--token value`, `--api-key=value`, Bearer, and
Authorization values. See [Operational diagnostics](docs/OPERATIONAL_DIAGNOSTICS.md).

Direct edits to `~/.railgun/config.json` remain supported through the normal file
tools. Preserve unknown keys and existing MCP entries, do not print secrets, write
valid JSON, and run `railgun config` afterward. That command prints the effective
configuration without redaction, so keep its output local. Model, approval,
advisor, MoA, MCP/extension, identity, and instruction changes apply to a new session; the
desktop and other long-lived backends must be restarted before they use them.

Electron main writes redacted, truncated lifecycle and structured transport
summaries shown in the desktop UI to `~/.railgun/logs/desktop-<timestamp>-<pid>.jsonl`.
`desktop-latest.jsonl` points to the current launch. These private local logs use
the same seven-day and 100 MiB retention boundary as interactive diagnostics and
exclude RPC payloads, prompts, tool arguments/results, environment variables, and
credentials. Backend stderr remains visible only in the bounded in-memory desktop
diagnostics view and is never persisted because MCP processes may write arbitrary
user or credential data there. If private log storage cannot be initialized, the
desktop continues without persisted diagnostics.

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
  "operationTimeoutMs": 600000 }`, which
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
  Railgun makes one final tool-free model call to summarize completed work,
  useful findings, and blockers. If that synthesis call fails, the assistant
  falls back to
  `I've reached the iteration limit for this session, so I'm stopping here gracefully.`
  The REPL stays open. Cancelling during synthesis remains a normal cancelled
  turn rather than being reported as successful completion.
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
  - `/settings` — open nested pickers for the primary model, default MoA preset, and advisor.
  - `/compact` — manually summarize and compact the current conversation history now, without waiting for the automatic 90%-context-window trigger. Prints `Compacted conversation history to stay under the context limit.` on success.
  - `/moa` — open a session-only picker for the active mixture-of-agents preset.
  - `/moa <preset>` — activate a named preset; `/moa off` disables MoA for the session.
  - `/branch [--summary] <message-id>` — move the saved session branch to a prior message, optionally inserting a summary of the abandoned suffix. Bare `/branch` opens a recent-message picker.
  - `/fork` — copy the active branch into a new session and continue there.
  - `/dream` — manually trigger memory consolidation. Reviews all stored memories, merges duplicates, deletes stale entries, and promotes stable user preferences to `~/.railgun/SOUL.md`. Requires at least 5 stored memories. Progress lines appear in the transcript. The installed background service also runs this automatically at local midnight.
  - `/cron` — list all scheduled jobs.
  - `/cron add <id> <schedule> <prompt>` — create a new cron job. `<schedule>` is a 5-field cron expression (e.g. `0 9 * * *`); `<prompt>` is the remainder of the line. Validates the expression and rejects duplicate ids.
  - `/cron remove <id>` — delete a scheduled job by id.
  - `/skill:<name> [args]` — load a discovered local skill and send its instructions, plus optional arguments, into the next agent turn. The agent can also self-manage skills: ask it to create or refine a skill and it writes to `~/.railgun/skills/<name>/SKILL.md` directly via `write_file`; ask it to delete one and it uses `run_shell_command` (subject to the normal shell approval flow). Updated skills are visible to the next agent run without restarting.
  (The agent tool can also manage jobs via natural language — ask "list my scheduled tasks" or "add a daily summary job".)
- **Note writing**: ask the agent to "save a note" or "remember this as a note" and it calls `note_write` to store the text in the note library (`~/.railgun/state.db`). Notes saved this way are immediately searchable with `note_search`; semantic search via `note_search_semantic` requires a later `import-notes` run to backfill the missing embedding vector.
- **Proactive recall**: before answering questions about your projects, preferences, or history, the agent proactively searches both memories (`memory_search`) and notes (`note_search` / `note_search_semantic`) rather than relying solely on what was injected at session start.
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
- **Session save error**: a completed turn stays usable in memory and the
  status line shows `unsaved`. The next successful turn retries the complete
  pending conversation/todo state; a recovery message appears once persistence
  succeeds.
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
`devin-token`, `state.db`, `SOUL.md`, `extensions/`, `cron/jobs.json`,
`cron/logs/`, and `cron/output/`. There are no profiles or home-path overrides.

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

**Extensions:** only global extensions from `~/.railgun/extensions/` are loaded. There is no sandbox — extension code runs with the same OS process privileges as Railgun.

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
successfully. Resumes rebuild the system prompt, home-directory context, and
personal identity from the fixed home workspace and start with a fresh 90-step
process budget. Historical user/assistant text is restored to scrollback;
historical tool frames are intentionally not reconstructed.

Missing IDs, corrupt saved state, database failures, and unavailable saved
models exit nonzero with an actionable error. Treat `state.db` as private
application state rather than editing it manually; stop Railgun before making
a backup so the database and its WAL are consistent. Session persistence covers
conversation history and todos only. File writes and shell-command side effects
apply directly to the working directory, so protect project files with normal
version control or backups.

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
    "requiredOutputs": ["/Users/alex/reports/daily-summary.md"],
    "lastRun": null,
    "lastSuccess": null,
    "lastStatus": null,
    "lastError": null
  }
]
```

Each job has a cron expression (`schedule`, interpreted in local time), a
`prompt` sent to a fresh agent session, and optional `requiredOutputs`.
Required outputs must be unique absolute paths (maximum 10). A run completes
only when every declared path is a newly created or changed, non-empty regular
file. Omitting the field or setting it to `[]` disables the output contract.

`lastRun` is the epoch timestamp of the latest attempted scheduled run and is
used for due-time calculation. `lastSuccess` advances only after a completed
run. `lastStatus` is `"completed"`, `"incomplete"`, `"failed"`, or `null`, and
`lastError` records the latest non-completion reason. Legacy jobs are normalized
on load: a non-null legacy `lastRun` becomes `lastSuccess` and implies a
`"completed"` status. The scheduler wakes every 60 seconds, runs due jobs
sequentially, and writes attempt state back to `jobs.json` atomically. The file
is re-read every cycle so edits take effect without restarting.

Behavior in cron mode:
- Each job gets a **fresh 30-step iteration budget** and a **fresh session** — no conversation history, no session database entry.
- The final **5 steps are finalization mode**: new searches are disabled while source fetching, file writing, and verification remain available. The model is instructed to use existing evidence, produce every required output, and report partial results honestly.
- Agent sessions warn after 6 consecutive `web_search` calls, stop cron research after 10 consecutive searches, warn when an identical idempotent call returns the same result twice, and block that call after 5 non-progressing attempts. Independent allowed calls may still execute concurrently; their results retain declared call order.
- Shell commands are **denied by default** unless `approvalMode: "off"` is set in `config.json` (hardline-blocked commands always apply).
- Extensions are **not loaded** — unattended safety.
- Output (timestamps, turn events, tool calls, completion summaries) is written to **`~/.railgun/cron/logs/cron-YYYY-MM-DD.log`** (rotated daily at UTC midnight; `cron-latest.log` symlinks to today's file). The daemon's own stdout/stderr go to `/dev/null` — the scheduler logger captures everything.
- Every attempted run advances `lastRun`, including incomplete and failed runs, so it waits for the next cron window instead of retrying every scheduler tick. Only completed runs advance `lastSuccess`.
- Every attempt writes an atomic Markdown report below **`~/.railgun/cron/output/<safe-job-id>/`** with the prompt, status, duration, turn/tool counts, output verification, final response, and failure reason. Railgun retains the newest 50 reports per job. A report-write failure changes the run status to `failed` and is logged.
- A normal final response with all required outputs satisfied is `completed`. Iteration exhaustion, an empty final response, or a missing, empty, stale, or non-file output is `incomplete`. Uncaught provider/runtime exceptions and report-write failures are `failed`; ordinary tool error results remain available to the model to recover from or report.
- Each log line is prefixed with an ISO-8601 timestamp. Scheduler startup emits a **run ID** (`[run-PID-EPOCH]`) that appears in both the `started` and `stopped` lines, making it easy to correlate entries when the daemon restarts on the same calendar day.
- Press **Ctrl+C** or send **SIGTERM** to stop the scheduler cleanly after the current job finishes.

A missing `~/.railgun/cron/jobs.json` is treated as an empty list — the scheduler runs but never fires. The `schedule` field uses standard cron syntax (`* * * * *` — minute, hour, day-of-month, month, day-of-week); five-field expressions are supported via `cron-parser`.

Jobs can be managed without editing the file directly: the `/cron` REPL slash
command (`/cron`, `/cron add`, `/cron remove`) provides quick in-session access,
and the agent `cron` tool (`action: list|add|remove|update`) lets the LLM manage
jobs on behalf of the user via natural language. The tool's `required_outputs`
argument maps to the persisted `requiredOutputs` field for `add` and `update`;
passing an empty array clears the contract.

### Background service daemon

For users who want the cron scheduler to run automatically in the background without keeping a terminal open, Railgun supports registering a persistent OS daemon.

> ⚠️ **Prerequisites & Limitations**:
> - **Global Installation Required**: The daemon management commands require installing the package globally (e.g., via `pnpm add --global @dantea/railgun`). They are **not** supported when running from a repository checkout via `pnpm start`.
> - **Supported Platforms**: The daemon commands are only supported on **macOS** and **Linux**. Windows is not supported (the commands will throw an error on unsupported platforms).
To manage the background service, use the following subcommands:

- **`railgun cron install`**: Registers and enables a persistent OS daemon (`launchd` on macOS, or a `systemd` user service on Linux). This service is configured to run `railgun cron` in the foreground at user login, automatically keeping the scheduler alive in the background without needing an active REPL session. It also installs a hidden OS-managed task that runs `railgun dream` every day at local midnight. Cron job logs are written to `~/.railgun/cron/logs/cron-YYYY-MM-DD.log` (rotated daily at UTC midnight, 7-day retention). A `cron-latest.log` symlink in that directory points to today's UTC date file.
- **`railgun cron status`**: Queries the OS service manager and prints the current status of the daemon, including the platform, service file path, log directory, and whether the daemon is installed and running.
- **`railgun cron uninstall`**: Stops, disables, and completely removes the generated scheduler and hidden nightly-dream services from your system.

The nightly dream task is separate from `~/.railgun/cron/jobs.json` and does
not appear in `/cron` listings. It invokes the same `railgun dream` command as
the manual path, including its minimum-five-memory guard; use `railgun dream`
when you want to watch its progress in the terminal. The generated task uses
the machine's local timezone and keeps its output hidden from interactive
sessions.

#### Running in the foreground

The standalone foreground scheduler still remains fully supported and can be run explicitly via:

```sh
# From a global installation:
railgun cron

# From a repository checkout:
pnpm start cron
```

In both cases, output goes to `~/.railgun/cron/logs/cron-YYYY-MM-DD.log` (same as the daemon). `cron-latest.log` in that directory symlinks to today's UTC date file.

Any other positional argument is a usage error. `pnpm start "no flag"` prints
the supported `login`, `logout`, `--print`, `--resume`/`-r`, and
`--list-sessions` usage to stderr and exits non-zero without launching anything.

### Working directory

Railgun always changes its working directory to the current user's home
directory before startup. There is no project selection, per-project trust
state, or working-directory override. Explicit relative paths passed to
`import-notes` are resolved against the directory where the command was invoked
before Railgun switches to the home directory.

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
`session_branch`, `session_fork`, `session_recent_messages`,
`session_transcript`), interactive
`approval_request`/`approval_response` and
`clarification_request`/`clarification_response` pairs, and config/MCP, cron,
memory, notes, Dream, fixed-ID instruction-file, and skills management commands.
`notes_import` remains keyword-only when its optional `semantic` field is omitted;
desktop imports explicitly send `semantic: true`. Active transcripts checkpoint
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

`session_load`, `session_branch`, and `session_fork` retain their existing
full-history responses by default. Clients that do not need provider history
can send `includeMessages: false` and then page through `session_transcript`
with `sessionId`, an optional zero-based `cursor`, and an optional `limit` from
1 to 100. Transcript pages contain only bounded textual user/assistant messages
plus an optional positive persistence `messageId`, an optional
`branchable: true` marker, and `nextCursor`; thinking, tool calls, arguments,
results, and other provider-only fields are removed before JSONL serialization.
The branch marker appears only on persisted complete assistant-turn boundaries.
Persistence revalidates that boundary before moving the active leaf, so invalid
or stale message IDs cannot leave a session on an incomplete path. Forks use a
bounded independent `fork-<UUID>` identity. This transcript projection is the
required restoration path for bounded-frame clients such as the desktop app.

Cron commands also retain their original full-job responses by default.
Bounded-frame clients may page `cron_list` with a zero-based `cursor`, a
`limit` from 1 to 100, `editableOnly: true`, and a positive
`maxPromptLength`. Editable-only pages contain just `id`, `schedule`, and
`prompt`, plus `nextCursor` when more jobs remain; a selected prompt above the
requested limit returns a correlated error before serialization. `cron_add`
and `cron_update` accept `includeJob: false` to return only `{ "jobId": "…" }`
after persistence. Omitting these optional fields preserves the legacy list
and mutation response shapes.

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

`pnpm dev:mock` opens the same desktop task shell as real mode, backed by the
deterministic JSONL child instead of the Devin provider. Mock behavior belongs
in `apps/desktop/src/mock/scenarios.ts`, not renderer fixtures; scenario and
transport controls live under Settings diagnostics rather than replacing the
product UI. New Task calls `session_new` without restarting the supervised
backend; backend restart remains an explicit recovery action. Aborting a
mock prompt cancels all remaining scheduled output and settles its pending RPC
response before another prompt can start.

The sidebar's search action opens a keyboard-accessible task palette over the
newest-first saved-session list. Filtering matches preview, model, or session ID
without changing backend order; selecting a result explicitly resumes its safe
transcript, persisted tool activity (tool name plus success or failure only),
and persisted todos. Raw tool arguments and results never cross the restore
boundary. The sidebar places **Scheduled** directly below **New Task** and keeps
Knowledge inside Settings. Relaunch restores only the last valid Task,
Scheduled, or Settings area, never an active session.
Legacy Knowledge route records migrate to Settings. Knowledge destinations wait
for backend readiness before issuing store requests.

Scheduled lists prompts in backend file order and supports create,
edit, and confirmed delete operations while a task is running. Schedules use
standard five-field cron syntax in the machine's local timezone and display a
live readable description. Job IDs remain backend-generated; runtime history,
pause/daemon controls, and required-output contracts are intentionally not
editable from the desktop.

For branch/fork QA, resume the populated rich-history task under the Ready / idle
scenario. Complete assistant messages with later visible history expose
**Branch from this message**; its dialog supports cancellation, optional tail
summarization, inline retry errors, and authoritative transcript hydration.
Right-click a saved sidebar row—or focus it and press Shift+F10—to choose
**Fork task**. Under the Cancellation scenario, start a prompt and fork a saved
row to verify stop-and-settle occurs before activation. Resume a saved task, then
switch to Command rejection to verify a failed branch keeps its dialog and
current renderer state intact.

The desktop mock also includes ordered saved tasks (including rich Markdown,
todo, scrolling, and dense completed-task fixtures with grouped tool activity),
empty/error stores, approval, choice clarification, free-text clarification,
cancellation, and disconnection scenarios. Approval and
clarification prompts are rendered inline; the ordinary composer is locked while
they are open, Stop remains available, and prompt responses are correlated by
opaque renderer IDs. Backend request IDs never cross the preload boundary, and
hardline-blocked shell commands remain backend-owned with no desktop bypass.

The composer footer keeps task configuration compact: the model trigger opens a
searchable picker with session-only (`This task`) and persisted (`Make default`)
choices, while Agent settings contains the persisted MoA preset, advisor toggle
and model, and manual Compact action. Compact is unavailable during a run or for
empty history. The context label is based on the latest exact provider-reported
input plus output tokens—not a renderer estimate—and resets after a model
change, compaction, backend restart, or New Task. Configuration reads are
reduced in Electron main to a bounded display-safe snapshot; raw configuration,
unknown keys, and provider-only model fields do not cross preload.

Knowledge includes a read-only Skills destination alongside its memory, notes,
Dream, and global-instruction management. Skill search matches names and
descriptions, detail reads remain independent of configuration mutations, and
instruction bodies use the same sanitized Markdown and HTTP(S)-only link
boundary as completed chat messages. Skill source paths never cross preload,
and the detail status distinguishes skills available to model invocation from
those requiring explicit user invocation.

Desktop Settings is a restorable full-page route rather than a card inside the
Task shell. Its sidebar contains General, Agent, Trust, Provider, MCP, and
Diagnostics. Search matches section names, labels, and descriptions, then moves
focus to the selected row. General persists the default model and operation
timeout; Agent persists the default MoA preset and advisor; Trust persists the
approval mode and smart-review model. MCP lists path-redacted commands, ordered
arguments, and environment key presence while stored values appear only as
`Saved secret`. Existing server names are immutable, and Add rejects duplicate
names instead of upserting over an existing server. Unchanged secrets are
retained, edited values—including an intentional empty string—replace them, and
removed keys are deleted. Successful changes refresh authoritative redacted
data and affect new backend sessions, not the currently running session. Saves
are explicit per section, the UI prompts before discarding dirty edits, and
unknown configuration keys remain backend-owned and preserved.

Desktop Knowledge is a restorable full-page route with Skills, Memories, Notes,
and Instructions. Memories expose bounded search and CRUD plus idle-only Dream
progress. Notes use a native folder picker and explicitly request semantic
embeddings; the renderer receives only import counts, source basenames, and
bounded snippets. Instructions expose eight fixed file IDs rather than paths,
skip empty files when reporting loader precedence, and confirm before discarding
dirty Markdown. Save/revert supports empty content, rejects symlinked files and
parent directories, and affects only newly created, loaded, or forked tasks.

The desktop transcript fills the main canvas behind its floating toolbar and
composer. Its native scrollbar is hidden in favor of a centered dash indicator
on the left. The indicator is hidden until the transcript overflows, then grows
from a short rail as history accumulates; active dashes show the current scroll
range. The transcript follows new output while it is at the bottom, preserves
the reading position after any user-driven scroll away, and resumes following
when returned to the bottom. Operation errors stay visible below the toolbar and
follow the sidebar inset instead of adding a new layout row.

After a successful turn, activity between the user request and final assistant
response is collapsed into a closed **Worked for ...** disclosure. Expand it to
inspect the ordered tool timeline; activity remains visible while work is active,
failed, or stopped. Restored sessions retain only tool names and success or
failure states, never tool arguments or results. Consecutive uses of the same
tool merge into a parameter-free summary such as **Edited files**; expanding it
reveals the individual tool rows and their available details.

When todos exist, the top-right toggle controls a non-resizable floating card.
At wide widths it reserves transcript space and wraps its content up to the
available height; at constrained widths the same visible card becomes an
overlay instead of disappearing or leaving an empty pane behind it.
While Files is closed, the Todos and Files controls share one divided glass
capsule. Opening Files gives it a fully separate opaque right workspace with its
own header and divider; the Task toolbar material stops at that boundary.

The real desktop backend never opens browser OAuth implicitly during startup.
Use Settings → Provider to launch supervised browser sign-in or remove the
cached credential. Successful sign-in and sign-out restart the backend; helper
failure preserves the existing credential and backend. Authentication and task
mutations are mutually exclusive, so a task cannot begin while browser sign-in
is pending. Sign-out removes only the cache: an active `DEVIN_TOKEN` continues
to take precedence. If that environment credential is rejected, update or
unset it in the environment that launches the app and relaunch Railgun.

The native desktop shell supports `⌘N` for New Task, `⌘K` for the command
palette, `⌘1` for Task, `⌘,` for Settings, and `⌃⌘S` to toggle the sidebar.
The sidebar can be resized by dragging its separator or with the arrow, Home,
and End keys while the separator is focused; double-click resets its width.
The sidebar width persists locally across launches, while sidebar visibility
remains session-only. Standard macOS Control-only editing keys are left untouched.
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
embedded Node runtime. Native backend dependencies are rebuilt for that
Electron runtime and smoke-tested there before Forge copies them. The app
therefore does not require a repository checkout or a separately installed
Node.js or pnpm at runtime.

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

### Desktop releases

The tag workflow keeps the npm CLI release and macOS desktop release on the
same version. A `vX.Y.Z` tag must match the root `package.json` version. It
builds Railgun natively on GitHub's arm64 and Intel macOS runners, imports the
Developer ID certificate into an ephemeral keychain, signs and notarizes both
apps, validates each stapled ticket, and publishes these GitHub release assets:

```text
Railgun-X.Y.Z-arm64.zip
Railgun-X.Y.Z-x64.zip
```

Stable releases then update `Casks/railgun.rb` in
`dante-teo/homebrew-tap`; prereleases publish artifacts without changing the
Cask. Failed release jobs are safe to rerun: an existing npm version is
skipped, existing GitHub assets are replaced, and an unchanged Cask produces no
commit. The release workflow requires these Actions secrets:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `HOMEBREW_TAP_DEPLOY_KEY`, a write-enabled deploy key scoped only to the tap

Users install the stable desktop with:

```sh
brew install --cask dante-teo/tap/railgun
```

See the [release runbook](docs/RELEASING.md) for versioning, credential
ownership and rotation, verification, prerelease metadata, and failure
recovery. The desktop is distributed through Homebrew and GitHub Releases, not
the Mac App Store; [ADR 0036](docs/adr/0036-homebrew-only-desktop-distribution.md)
records that decision.

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
- [`docs/DESIGN.md`](docs/DESIGN.md) — interaction and visual design contracts
- [`docs/adr/`](docs/adr/) — architectural decision records
