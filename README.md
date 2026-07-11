# railgun

A from-scratch TypeScript replication of [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s
core agent loop, built incrementally, phase by phase (see
[`docs/PRODUCT.md`](docs/PRODUCT.md)). The REPL's agent can read and write
files, list directories, run shell commands (the last gated behind an
interactive y/n approval prompt), and maintain a flat todo
plan before answering, looping the conversation with Devin until it has a
final text answer. The loop is hardened with
parallel-safe tool batching, corrupted tool-call JSON self-healing,
transient API retry, automatic context compaction, and a 90-step
iteration budget. In the REPL that budget is shared for the process lifetime; in one-shot mode each invocation
gets a fresh budget. Exhausting it is a graceful stop, not a failure.
Interactive conversations and todos are checkpointed to a private local
SQLite database and can be resumed across restarts. The REPL is a full-screen,
resize-aware Ink interface with automatic mint-light/mint-dark appearance,
Markdown replies, transcript history navigation, a multiline composer, slash
commands (`/exit`, `/help`, `/clear`, `/model`, `/compact`), and Tab completion. A `.railgun.md` (or
`RAILGUN.md`) found in the project tree (walking up to the git root), or
an `AGENTS.md`/`agents.md`, `CLAUDE.md`/`claude.md`, or `.cursorrules` in the working directory,
is loaded into the system prompt automatically at session startup — as is
a personal `~/.railgun/SOUL.md` — with untrusted content truncated and
scanned for prompt-injection patterns before use.

## Prerequisites

- Node.js >= 22
- pnpm
- A Devin/Cascade account you are permitted to access programmatically (see
  [Compliance](#compliance) below)

## Install

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
  source. A missing file has the effective default `{ "model": null }`, which
  selects the first model returned by Devin. Unknown fields are preserved;
  malformed files and invalid recognized values fail without automatic repair.
- **Authentication**: a nonempty, trimmed `DEVIN_TOKEN` takes precedence for
  this process and is never persisted. Otherwise Railgun reuses
  `~/.railgun/devin-token` (mode `0600`), opening browser sign-in only when
  that cache is absent. Whitespace-only `DEVIN_TOKEN` values count as absent.
- Type a message and press Enter to send it; Shift+Enter inserts a newline in
  terminals supporting enhanced keyboard reporting. The composer grows from
  one through six rows (and caps lower in short terminals), preserves multiline
  paste, and keeps its draft while busy or awaiting approval. Tab completes an
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
- Ask for a multi-step plan and the model can call the `todo` planning
  tool. The REPL renders the current flat todo list in a sticky
  panel above suggestions, approval, and the composer, with a
  `Todos · completed/total` header and per-item
  status glyphs (`[ ]`/`[>]`/`[x]`/`[-]`). While a todo update is in
  flight, an empty panel shows a `Crafting todos` spinner. Todo activity
  is intentionally not echoed as normal `✓ todo ...` transcript lines.
  Interactive todo state is saved with the conversation and restored on
  resume. One-shot todo state remains invocation-local.
- Ask it to run a shell command (e.g. `"run echo hello in the shell"`) and
  the REPL freezes the text input and prints
  `Run shell command: <command> [y/n]`; press `y` to run it and feed the
  real output back to the agent, or `n`/`Esc` to decline (the agent gets
  told the command was not approved and answers accordingly).
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
  - `/exit` (or `Ctrl+C`) — quit the REPL.
  - `/help` — print the list of available commands.
  - `/clear` — clear the terminal canvas without discarding conversation state.
  - `/model` — open an interactive model picker (Up/Down to navigate, Enter to switch and save, Esc to cancel).
  - `/model <name-or-index>` — switch the active model directly and save as the new default.
  - `/model <name-or-index> --session` — switch for this session only (not saved).
  - `/model --session` — open the picker; the selected model applies to this session only.
  - `/compact` — manually summarize and compact the current conversation history now, without waiting for the automatic 90%-context-window trigger. Prints `Compacted conversation history to stay under the context limit.` on success.
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

```sh
pnpm start config
```

`config` prints the effective configuration as pretty JSON. It is an exact,
read-only subcommand: extra arguments are usage errors, and it does not
authenticate, open SQLite, create files, or enter the TUI. Set `model` to an
exact Devin model ID to use it for new REPL and one-shot sessions; set it to
`null` to use Devin's first available model.

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
`devin-token`, `state.db`, and `SOUL.md`. There are no profiles or home-path
overrides.

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

Any other positional argument is a usage error. `pnpm start "no flag"` prints
the supported `login`, `logout`, `--print`, `--resume`/`-r`, and
`--list-sessions` usage to
stderr and exits non-zero without launching anything.

## Development

```sh
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest run — includes real temporary-SQLite persistence tests and CLI/REPL/session coverage
pnpm run build       # compile src/ to dist/
```

The Ink REPL UI is supported by automated tests for its pure state and
rendering helpers, alongside tests for
`src/agent/turn.ts` (turn/history loop), `src/agent/toolDispatch.ts`
(parallel-batch safety, corrupted-JSON detection), `src/agent/recovery.ts`
(API failure classification and retry), `src/agent/compaction.ts`
(token-budgeted history summarization and truncation), `src/agent/projectContext.ts`
(context-file discovery, git-root walk, injection scan, truncation,
`SOUL.md` loading), `src/security/threatPatterns.ts` (injection-pattern
matching), each tool's own handler logic in `src/tools/`,
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
