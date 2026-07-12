# Product

## Purpose

Railgun is a personal, from-scratch replication of
[Hermes Agent](https://github.com/NousResearch/hermes-agent)'s core agent loop,
built one small, always-usable phase at a time, in TypeScript
(see `~/Projects/hermes-agent/replication_plan.md`, Part 1 "The Core Engine"
onward). Each phase must leave the app runnable end to end — no phase ships
"not usable yet." The end goal is a full agent: chat loop, tool calling,
memory, safety, and multiple front doors (CLI, messaging, GUIs) — but the
project deliberately restricts itself to a single AI backend (Devin, via the
`widevin` npm package) rather than a multi-provider abstraction, so effort
goes toward agent logic instead of provider plumbing (see
`docs/adr/0001-single-provider-devin-via-widevin.md`).

**Current phase — Phase 39 (ACP server mode):**
Phase 29 adds a `railgun cron` command that runs the agent automatically on a schedule without human input. Jobs are defined in `~/.railgun/cron/jobs.json` as a JSON array of objects with `id`, `schedule` (cron expression), `prompt`, and `lastRun` (epoch ms or null). A background loop wakes every 60 seconds, parses each schedule with `cron-parser` to find the last firing time before now, and runs any job whose `lastRun` is before that time (or null). Each job fires a fresh `createAgentSession` with a 30-step iteration budget, shell commands denied by default unless `approvalMode` is `"off"` in `config.json`, and no session persistence — output is logged to stderr. After all due jobs in a cycle complete, `lastRun` is atomically written back to `jobs.json` via `write-file-atomic`. The loop runs until SIGINT or SIGTERM, which are each forwarded to an `AbortController`; the signal propagates through the sleep primitive (built with `Promise.withResolvers()`) so the process exits without waiting out the current interval. Extensions are not loaded in cron mode. `src/cron/jobs.ts` owns job types, disk I/O, and `isDue`; `src/cron/scheduler.ts` owns `tick` (sequential per-cycle run), `runCronJob` (session construction and event collection), and `startScheduler` (the main loop).

Phase 39 adds `railgun --mode acp`, making the agent available to code editors (such as Zed) as a native AI coding assistant over the Agent Client Protocol (ACP v1). ACP is a JSON-RPC 2.0 over stdio standard; Railgun uses the `@agentclientprotocol/sdk` npm package (v1.2.1, Apache-2.0) for protocol handling.

When launched with `--mode acp`, the process advertises itself via `initialize` (protocol version 1, `loadSession: false`), accepts multiple named sessions via `session/new`, and serves each user turn via `session/prompt`. During a turn the agent streams `session/update` notifications to the editor: `agent_message_chunk` for streamed text, `tool_call` when a tool starts, and `tool_call_update` when it completes or fails. `session/cancel` aborts any in-flight run. The mode uses the same `AgentSession`/`createAgentSession` machinery as RPC mode — shell commands are auto-approved, `clarify` throws (no human at the terminal), extensions are bootstrapped identically, and no session is written to SQLite. Unlike RPC mode, ACP supports multiple independent named sessions within a single process, each with its own accumulated conversation history. New files: `src/acp/acpMode.ts` (exports `createAcpApp` and `runAcpMode`), `src/acp/toolKind.ts` (pure tool-name → ACP kind mapping). `src/cli.ts` extended with the `{ kind: "acp" }` mode, `runAcp` dependency, and matching dispatch branch.

`src/acp/toolKind.test.ts` proves all mapped tool names return the correct kind and unknown names fall back to `"other"`; `src/acp/acpMode.test.ts` uses the SDK's in-process `client().connectWith(agentApp, ...)` transport to prove `initialize` returns protocol version 1 and `loadSession: false`, `session/new` returns a non-empty session ID, `session/prompt` with text returns `stopReason: "end_turn"` and streams `agent_message_chunk` notifications, a prompt against an unknown session ID throws a JSON-RPC error, tool executions stream `tool_call` and `tool_call_update` notifications, and `session/cancel` causes `stopReason: "cancelled"`; `src/cli.test.ts` proves `--mode acp` parses to `{ kind: "acp" }`, `--mode acp --approve` throws `CliUsageError`, and `dispatchCli` with `{ kind: "acp" }` calls `initSession`, `loadConfig`, and `runAcp` without opening the session store. Full suite: 68 test files, 833 tests, zero regressions; `pnpm typecheck` clean.

**Phase 24 (MCP client support):**
Phase 24 adds MCP (Model Context Protocol) client support as a built-in
programmatic extension, letting the agent use tools from external MCP servers
configured in `~/.railgun/config.json`. Add a `mcpServers` object whose keys
are server names and values are `{ command, args?, env? }` entries (stdio
transport only); on startup Railgun spawns each server as a child process,
handshakes over JSON-RPC, discovers its tools, and registers them with prefixed
names (`mcp__<server>__<tool>`) via the Phase 23 `registerTool` surface. One
broken server logs an error but does not prevent the agent from starting.
Child processes are killed in `try/finally` on session shutdown. See ADR-0014.

**Phase 25 (persistent memory):**
Phase 25 adds cross-session persistent memory: the agent remembers facts, preferences,
and project details the user shares across separate sessions. A new `memories` table
(schema v2) in `~/.railgun/state.db` stores rows with `id`, `content`, `category`
(`"preference"`, `"fact"`, `"project"`), and `created_at`. Two new tools —
`memory_write` and `memory_search` — are registered under the `"memory"` toolset;
the tool rules block in the system prompt instructs the agent to call `memory_write`
when the user shares a personal fact, preference, or project detail. At session start,
`MemoryStore.recent(20)` is loaded and injected as a `# Memories` block in the system
prompt (via `formatMemoriesForPrompt`). All three session modes (fresh REPL, resume,
one-shot/print) now open the session database to read memories. The `SessionStore`
exposes a `readonly db` handle so `MemoryStore` can share the same SQLite connection
without opening a second one.

**Phase 32 (Mixture of Agents):**
Phase 32 adds an opt-in Mixture of Agents (MoA) mode. When active, every user
turn fans out parallel advisory calls to a configurable set of reference models
before the acting aggregator model decides its next step. Each reference model
receives a stripped, tool-free view of the conversation and is asked to give
analysis, next-steps, and risk notes. Their responses are collected and
injected as a private guidance user message appended to the conversation before
the aggregator's first round. A failed reference produces a labelled
`[failed: ...]` note and never crashes the turn. MoA is activated for the
current session with `/moa <preset-name>` and deactivated with `/moa off`; a
persistent default for one-shot mode is configured via `activeMoaPreset` in
`config.json`. Configuration: `moaPresets` is a top-level `config.json` key
mapping preset names to objects with `referenceModels` (array of
`{model, temperature?}`, at most 8), `aggregator` ({model, temperature?}), and
optional `referenceMaxTokens` (positive integer). New file:
`src/agent/moa.ts`. Three new `AgentEvent` variants:
`moa_reference_start`, `moa_reference_end`, `moa_aggregating`. See
`docs/adr/0014-mixture-of-agents.md`.

**Phase 28 (skills system):**
Phase 28 adds a skills system that lets the agent learn new domain-specific abilities from Markdown files with YAML frontmatter. Skills live in `~/.railgun/skills/` (global only for now; project-local gating is a future phase). A skill file is a `.md` file containing a YAML front-matter block followed by its instruction body; a skill can also be a directory containing `SKILL.md` where the directory name becomes the skill's name. Three front-matter fields are recognized: `name` (optional override, must match `/^[a-z0-9-]{1,64}$/`), `description` (required, ≤ 1024 chars, injected into the system prompt), and `disable-model-invocation` (boolean, default `false` — when `true` the skill is hidden from the model's context but still available via `/skill:<name>`).

At session startup `buildSessionCore` calls `loadSkills()`, which scans `~/.railgun/skills/` synchronously, parses every valid skill file, deduplicates by name (first-found wins), and builds an index. `formatSkillsForPrompt` renders the index as an `<available_skills>` XML block appended to the system prompt; descriptions and paths are XML-attribute-escaped. The model calls `skill_view(name)` (a new `"skills"`-toolset tool) to load a skill's full instruction body on demand.

The `/skill:<name> [args]` REPL slash command bypasses the model for explicitly invoking a skill: the user's input is expanded into a `<skill name="..." location="...">` XML block (plus any trailing args), and the result is sent directly to the agent turn as the user message. Unknown skill names show a red error line. `/help` lists the command. See ADR-0015.

**Phase 23 (extension system):**
Phase 23 adds an extension system that lets outside code observe and intercept
the agent's lifecycle without editing core source. Extensions live in
`~/.railgun/extensions/` (global) and `.railgun/extensions/` (project-local,
currently loaded unconditionally). An extension default-exports a factory
`(api: ExtensionAPI) => void | Promise<void>` and registers handlers via
`api.on()` and new LLM-callable tools via `api.registerTool()`. Five typed
events form a discriminated union: `tool_call` (can block — fail-closed per
call on handler throws), `tool_result` (can rewrite content/isError),
`session_start`, `session_shutdown` (observers only), and `input` (can
transform or consume user text before the agent sees it). `ExtensionRunner`
(`src/extensions/runner.ts`) manages handler dispatch and error isolation;
`loadExtensions` (`src/extensions/loader.ts`) discovers and imports modules at
session startup; `registerExtensionTools` inserts extension-registered tools
into the core registry under a new `"extension"` toolset. All three session
modes — fresh REPL, resume, and one-shot — bootstrap extensions before the
session runs and emit `session_start`/`session_shutdown` around it. See ADR-0013.

Phase 33 adds a `--mode rpc` flag to the railgun CLI. The process accepts JSONL
commands on stdin and emits typed responses plus `AgentSessionEvent` objects on
stdout. Each GUI client or test script spawns `railgun --mode rpc` as a child
process and drives it over stdio — one process per client, no shared gateway, no
socket server. The protocol defines 10 `RpcCommand` types: `prompt` (fires an
agent run with the accumulated history), `steer` and `follow_up` (injected during
a run), `abort` (cancels an in-flight run), `get_state` (running flag, current
model, message count, todo snapshot), `get_messages` (full accumulated history),
`set_model` (swaps the model for subsequent prompts), `get_available_models`,
`compact` (manual history compaction), and `set_auto_compaction`. Every response
carries `{type:"response", command, success, id?}` plus a `data` field on success
or `error` string on failure. `AgentSessionEvent` objects (all 13 variants) are
forwarded as raw JSONL with no envelope. One prompt runs at a time; a second
prompt while one is in-flight returns an error response immediately. stdin EOF
aborts any in-flight run, awaits its completion, and exits cleanly. Shell
commands are auto-approved in RPC mode (headless — no human at the terminal);
the `clarify` tool throws, surfacing as a tool error in the transcript. No
session persistence occurs in RPC mode. The `RpcClient` class
(`src/rpc/rpcClient.ts`) provides a TypeScript consumer surface: it spawns the
child process, assigns auto-incrementing ids, resolves/rejects `call()` promises
when responses arrive, and forwards event objects to registered listeners.
`src/rpc/jsonl.test.ts` proves `serializeJsonLine` round-trips through
`JSON.parse`, `makeLineReader` splits on `0x0a` only (not U+2028/U+2029), handles
chunked input across multiple data events, ignores empty lines, and detaches
cleanly via the cleanup callback; `src/rpc/types.test.ts` confirms the
discriminated union shapes compile and satisfy type constraints;
`src/rpc/rpcMode.test.ts` proves `prompt` responds with success after the agent
finishes, `agent_start` is emitted, `get_state` returns `running:false` with the
correct model when idle, `get_messages` returns an empty array before any
prompts, invalid JSON produces a `parse_error` response, a missing `type` field
returns an error, a second concurrent prompt returns an error response while the
first succeeds, `abort` during a run returns success, `steer` while not running
returns an error, and `steer` while running returns success;
`src/rpc/rpcClient.test.ts` proves the child is spawned with `--mode rpc`
appended, `call()` resolves on a success response, rejects on an error response,
non-response lines reach event listeners, unsubscribing removes the listener,
`stop()` kills the child, out-of-order responses correlate correctly by id, and
malformed JSON is silently ignored; `src/cli.test.ts` proves `--mode rpc` parses
to `{ kind: "rpc" }`, `--mode rpc --approve` throws `CliUsageError`, bare
`--mode` throws, and `--mode unknown` throws; the `dispatchCli` test proves
`initSession` and `loadConfig` are called, `runRpc` is called with the session
and config, and the session store is never opened. Full suite: 52 test files,
592 tests, zero regressions; `pnpm typecheck` clean.
  Phase 28: `src/skills.test.ts` proves `splitFrontmatter` correctly handles LF and CRLF opening fences (CRLF offset is 5, not 4, so frontmatter does not contain a leading `\n`), no-fence input returns the full body, and a missing closing `---` produces no frontmatter; `parseSkillFile` returns a valid `SkillMeta` for well-formed files, infers `name` from directory (for `SKILL.md`) or filename, returns `null` with a `[skills]`-prefixed warning for missing description, invalid name, or overlength description, and respects `disable-model-invocation: true`; `discoverSkills` returns `[]` for a non-existent directory, stops recursion at a `SKILL.md` directory root (no nested skills discovered), finds `.md` files at any level, and skips non-`.md` files; `buildSkillIndex` builds a deduplication map with first-loaded-wins semantics and warns on collision; `formatSkillsForPrompt` returns `""` for an empty index, excludes disabled-model-invocation skills, produces correct `<available_skills>` XML, and escapes `&`/`"`/`<`/`>` in description attributes; `expandSkillCommand` returns `null` for non-`/skill:` input, an `{ kind: "error" }` discriminant for unknown names, `{ kind: "expanded" }` with the full XML body for known skills, and appends trailing args after `</skill>`. `src/tools/skillView.test.ts` proves `skill_view` returns the body for a known name, an error for an unknown name, and an error when the `name` argument is absent. `src/paths.test.ts` proves `SKILLS_PATH` is derived from the same Railgun home as all other paths.

Phase 22 adds automatic working-directory snapshots before file-mutating tool
calls and a `/rollback` REPL command to undo the agent's last round of
changes. Before the first `write_file` or approved `run_shell_command` in a
user turn, a `CheckpointGuard` calls `snapshot`, which stages all files into a
per-project shadow git repository at `~/.railgun/checkpoints/<cwd-hash>/` and
commits them. Subsequent `beforeMutation` calls within the same turn are
no-ops; `resetTurn` re-arms the guard for the next turn. `/rollback` calls
`git checkout HEAD -- .` against the shadow repo, restoring the working tree
to the pre-turn state. One-shot mode receives no guard. See ADR-0013.

Phase 21 (not shown here — see replication plan) added the shell-command
approval gate. Phase 20 added the per-directory project trust gate: `~/.railgun/trust.json` persists trust decisions keyed by canonical path, with ancestor-directory inheritance; `--approve`/`-a` and `--no-approve`/`-na` CLI flags override for one invocation; `/trust` REPL command updates the decision mid-session; `defaultProjectTrust: "ask"|"always"|"never"` in `config.json` short-circuits the prompt. Trust is plumbing-only in Phase 20 — no project-local resources are gated yet. See ADR-0013.
  Phase 22: `src/checkpoint.test.ts` proves `shadowGitDir` determinism,
  `snapshot` creates a commit in a fresh shadow repo, a second snapshot when
  nothing changed is a no-op (covered by `--allow-empty`), `rollback` restores
  overwritten and deleted files to their pre-snapshot content, rollback against
  a missing shadow repo throws, `createCheckpointGuard.beforeMutation` takes
  exactly one commit per turn (duplicates are no-ops), and `resetTurn` re-arms
  the guard so the next `beforeMutation` takes a second commit;
  `src/tools/writeFile.test.ts` proves `checkpointGuard.beforeMutation` is
  invoked exactly once when the guard is present in `ToolContext`;
  `src/commands.test.ts` proves `/rollback` is present in `KNOWN_COMMANDS` and
  returned by `findMatches`.
  Phase 20: `src/trust.test.ts` proves `createProjectTrustStore` returns `unknown` for unrecorded
  directories, `trusted (persisted)` after `set(cwd, "trust")`, `denied (persisted)` after
  `set(cwd, "deny")`, `trusted/denied (session)` for session-only choices without writing to disk,
  `trust-parent` persisting to `dirname(cwd)` with child inheritance, ancestor walking (trusting
  `/a/b` makes `/a/b/c/d` trusted), independent sibling directories, persisted-decision
  load-on-creation, and missing-file empty-store semantics; `resolveProjectTrust` proves
  `cliApprove` short-circuits without prompting, `cliNoApprove` short-circuits,
  `defaultTrust: "always"/"never"` short-circuit, existing persisted decision bypasses prompt, and
  `defaultTrust: "ask"` with no stored decision calls the prompt and persists the result;
  `assertProjectTrustedForRead` and `assertProjectTrustedForInstall` prove they do not throw on
  `trusted` and do throw (with the resource path in the message) on `denied`/`unknown`.
  `src/cli.test.ts` proves `--approve`/`-a`/`--no-approve`/`-na` flag parsing on fresh/print/resume
  modes, rejection on login/logout/config/list modes, and both-flags-together throwing
  `CliUsageError`; `src/config.test.ts` proves `defaultProjectTrust` defaults to `"ask"`, is included
  in the persisted output of `setConfiguredModel`, and is rejected for values outside the
  `"ask"/"always"/"never"` set. See ADR-0013.

Phase 19 adds a `clarify` tool (`src/tools/clarify.ts`) that lets the agent ask the user a clarifying question — with optional numbered multiple-choice answers — instead of guessing when information is missing. The design is callback-based: the tool itself is platform-agnostic; the actual user-interaction mechanism is injected as `ClarifyCallback` (`src/tools/registry.ts`) via `AgentDependencies.clarifyCallback` and threaded through `RunTurnOptions` into `ToolContext`. In the REPL (`src/repl/App.tsx`) the callback uses `Promise.withResolvers` and a ref, mirroring the existing `confirmShellCommand` pattern: an `❓` prompt box renders above the composer, number keys `1`–`4` pick choices (with the composer unfocused to prevent digit bleed-through), Enter submits a freeform typed answer, and Escape resolves with `[user declined to answer]`. In one-shot mode (`src/oneShot.ts`) the callback blocks on `readline`/`process.stdin`. Ctrl+C during a clarify prompt resolves it with `[user declined to answer]` and aborts cleanly. The `"clarify"` toolset is always enabled alongside `"file"`, `"terminal"`, and `"planning"`. The system prompt (`src/agent/systemPrompt.ts`) instructs the model to use `clarify` before irreversible actions when information is missing and to offer choices when the options are clear and few.

Phase 18 replaces `src/agent/turn.ts`'s `LoopCallbacks` with a typed,
two-layer event stream: `src/agent/agent.ts`'s low-level `Agent` now emits a
raw `AgentEvent` union (`agent_start`/`agent_end`, `turn_start`/`turn_end`,
`message_start`/`message_update`/`message_end`, `tool_execution_start`/
`tool_execution_end`, `compaction_start`/`compaction_end`) via `subscribe`,
and a new `src/agent/agentSession.ts`'s `createAgentSession` wraps it,
re-emitting the raw stream plus session-only `agent_settled` and
`queue_update` events. Per-call `tool_execution_start`/`tool_execution_end`
events (correlated by real `toolCallId`) replace the old `"__batch__"`
sentinel a parallel batch used to collapse into; the `Promise.all` barrier
is preserved (all calls start, then all settle — never interleaved).
`src/oneShot.ts`'s spinner and `src/repl/App.tsx`'s
streaming/tool-label/compaction-ack/queue-injection rendering both migrated
from passing callbacks to subscribing on the session object, letting
multiple independent consumers observe the same running turn. See
ADR-0012.

Phase 17 introduces a functional `createAgent` lifecycle with one abort
controller per run, guarded `run`/`abort`/`steer`/`followUp` operations, FIFO
steering injected one message per assistant/tool boundary, and follow-ups
drained only when the run would otherwise settle. Ctrl+C cancels active
provider/tool/approval work without exiting the REPL; idle Ctrl+C exits.
Cancellation retains the submitted user message, streamed assistant text,
completed tools and todo mutations, adds stopped tool results where protocol
pairing requires them, and clears queued input with a visible cancellation
count. Approved POSIX shells run in detached process groups and receive
SIGTERM followed by SIGKILL after a two-second grace period. See ADR-0011.

Phase 16 closed the gap ADR-0004 deferred at Phase 5: `src/agent/recovery.ts`'s
`RecoveryAction` gains a 4th member, `"compress_and_retry"`, and HTTP 413
(payload too large) now triggers it instead of failing the turn immediately.
`src/agent/compaction.ts` (new) ports OpenAI Codex CLI's history-summarization
algorithm (`codex-rs/core/src/compact.rs`): a token-budgeted, newest-first
selection of prior user turns (20 000-token budget, middle-truncated with a
`"…N tokens truncated…"` marker rather than dropped when the boundary message
overflows) plus an LLM-generated handoff summary, merged into a single
`role: "user"` compacted message. `src/agent/turn.ts`'s `runTurn` now takes a
`contextWindow` parameter and compacts two ways: proactively, checking each
step's `usage` stream event against 90% of `contextWindow` after every round
(bounded to at most one compaction per round even if a reactive compaction
already fired); and reactively, via a `compress` callback threaded through
`callDevinWithRecovery`, invoked when Devin itself returns HTTP 413 (capped at
3 compression attempts before giving up, independent of the existing 3-attempt
backoff counter). A new `/compact` REPL slash command triggers the same
summarization on demand and appends a synthetic acknowledgement message to
satisfy `sessionStore.ts::validateTranscript`'s stricter `user → assistant`
alternation — two deliberate departures from Codex's own multi-message
replacement shape, recorded in ADR-0010.

Phase 15 added the `/model` slash command to the interactive REPL. Bare
`/model` opens an inline interactive picker — Up/Down to navigate the
available models, Enter to switch and save as the new default, Escape to
cancel. `/model <name-or-index>` switches directly without the picker and
persists the selection to `~/.railgun/config.json` as the new default for
all future sessions. `/model <name-or-index> --session` or the picker
opened via `/model --session` switches only for the current REPL run
without touching the persisted default. Conversation history and todos are
unaffected by a switch. Resumed sessions remain pinned to their originally
recorded model — the Phase 14 resume-pinning invariant is preserved by
construction.

Phase 13 added exact `login` and `logout` subcommands, process-local
`DEVIN_TOKEN` support, source-aware rejection handling, and precise retry
boundaries. A trimmed nonempty environment token overrides the file cache
without reading, changing, or persisting it. Otherwise Railgun reuses
`~/.railgun/devin-token` and opens browser OAuth only when the cache is absent
or `login` is explicitly requested. HTTP 401 removes a rejected cached token
but never touches the cache for a rejected environment token. Authentication
commands avoid SQLite, project context, chat-session initialization, and the
TUI. Failed authentication turns remain failed: the REPL stays open, but the
user must repair credentials and manually resubmit the message.

Phase 12 persistence remains in place. Successful interactive conversations
and todo snapshots are durable in `~/.railgun/state.db`; exact or interactive
resume restores them, while one-shot and authentication modes remain outside
SQLite. Failed Devin turns roll back todos and save nothing. Failed SQLite
checkpoints retain completed state in memory and retry the full snapshot after
the next successful turn.

The interactive surface has since been upgraded to an adaptive full-screen TUI
(ADR 0007): automatic terminal/OS mint theming, alternate-screen restoration,
physical-row transcript navigation with mouse and keyboard controls, a
multiline composer, chronological assistant/tool activity, completed-reply GFM
Markdown, and the same resize-aware treatment in the resume chooser. This
supersedes the earlier manual skin/config/banner interaction without changing
Phase 12's persistence contracts.

Phase 11 added a planning tool and REPL panel for multi-step work. The
`todo` tool is registered under the always-enabled `"planning"` toolset
and operates on a caller-owned store: the REPL checkpoints it, while each
`--print`/`-p` invocation gets a fresh store. `src/tools/todo.ts` owns the
reducer/store boundary and hardening:
flat ordered todos, globally unique ids, a 256-item cap, 4000-character
content cap with truncation marker, invalid-status normalization to
`pending`, malformed-item coercion (blank content → `"(no description)"`,
blank id → `"?"`, non-object → placeholder), last-occurrence-wins
duplicate-id collapse, partial-field merge-by-id (status-only or
content-only patches preserve untouched fields), and active-work
formatting for prompt injection. The tool handler validates input before
reaching the store: JSON strings are parsed, non-list values are rejected
with an error, and `null` todos are treated as a read.
`src/repl/App.tsx` renders nonempty todo state in a persistent panel above
the input, shows a `Crafting todos` spinner while an empty todo update is
in flight, suppresses normal transcript tool-completion lines for
successful `todo` calls (errors still surface as red `✗` lines), and
keeps one store in a React ref. `--print` mode emits only the final
answer on stdout (stderr still shows the generic tool spinner for all
tools including `todo`).

Phase 10 project-level context loading remains in place: project context
files and `~/.railgun/SOUL.md` are loaded once during session bootstrap,
truncated, scanned for prompt-injection patterns, and appended to the
system prompt when accepted. No mid-session subdirectory hints, no
`.cursor/rules/*.mdc` support, and no config-driven
`context_file_max_chars` override yet. Earlier hardening remains in place:
parallel-safe tool batching, corrupted tool-call JSON self-healing, precisely
bounded transient API retry, and the shared iteration-budget behavior still
apply to both the REPL and one-shot paths. Retryable failures are HTTP 408,
429, 5xx, and fetch-style transport errors; HTTP 401, other 4xx responses,
protocol failures, and unrelated errors fail immediately.

## Users

- Primary users: the project's own author, learning agent-building by
  building one
- Secondary users: none planned while this remains a personal learning project
- Internal stakeholders: none — solo project

## Problems

- Understanding how a production agent (chat loop, tool calling, memory,
  safety limits, multiple front doors) is actually built end to end is hard
  to learn from reading a finished system alone; building an equivalent from
  scratch, phase by phase, makes each piece concrete.

## Goals

- Every phase leaves a runnable, real (not toy/mocked) program.
- Replicate Hermes Agent's core agent-loop architecture idea (loop shape,
  tool structure, session storage) without porting its Python code line for
  line.
- Keep the AI backend simple (Devin via `widevin` only) so effort stays on
  agent logic, not provider abstraction.

## Non-Goals

- Multi-provider AI backend support (explicitly rejected — see ADR 0001).
- Production-grade multi-tenant deployment; this is a personal tool.
- Feature parity with Hermes Agent's Python implementation beyond the
  architectural ideas the replication plan calls out.

## Core Workflows

1. Run `pnpm start` from a terminal. Railgun uses a trimmed nonempty
   `DEVIN_TOKEN`, otherwise reuses the cached Devin credential and opens
   browser sign-in only when the cache is absent. Type messages into the Ink
   chat REPL and read streamed replies from the scrollback. Each successful
   turn checkpoints the whole conversation and todos for later resume.
2. Run `pnpm start --print "<question>"` (or `-p`) for a one-shot,
   scriptable/CI invocation that keeps Phase 1's stdout/stderr contract —
   no interactive REPL, no conversation memory — but can call the same
   tools as the REPL, including silent todo planning and a stdin-blocking
   approval prompt if the model calls `run_shell_command`.
3. Run `pnpm start --resume [session-id]` (or `pnpm start -r [session-id]`) to continue saved work, or
   `pnpm start --list-sessions` to inspect local sessions without logging in.
4. Run `pnpm start login` to deliberately replace and verify the cached Devin
   credential, or `pnpm start logout` to idempotently remove only that cache.
   When `DEVIN_TOKEN` is set, both commands explain that environment
   authentication overrides or survives the cache operation.
5. Run `pnpm start config` to inspect effective configuration without side
   effects. Hand-edit `~/.railgun/config.json` to choose the exact default model
   for new sessions, or use `null` for Devin's first returned model.
6. On the first run in an untrusted project directory, Railgun prompts for trust on stderr before the
   REPL starts. Choose an option (Trust, Trust parent, Trust session-only, Deny, Deny session-only);
   persisted choices are remembered in `~/.railgun/trust.json`. Pass `--approve`/`-a` to trust for a
   single invocation, or `--no-approve`/`-na` to deny. Set `"defaultProjectTrust": "always"` in
   `~/.railgun/config.json` to skip the prompt globally. Use `/trust` inside a running REPL to update
   the decision mid-session.
7. Tell the agent a fact you want remembered (e.g. "Remember that I hate coffee").
   Railgun calls `memory_write` to persist it. On the next fresh session (no `--resume`
   needed), ask about it and Railgun answers from the saved memory.
8. Run `railgun --mode rpc` to start a headless agent process driven over stdio.
   Write JSONL command objects to its stdin (e.g.
   `{"id":"1","type":"prompt","message":"What is 2+2?"}`) and read
   JSONL responses plus `AgentSessionEvent` objects from its stdout. Each client
   spawns its own process — no shared server.

## Success Metrics

- Each phase's own "Definition of Usable" from the replication plan is met
  and manually verified (e.g. Phase 2: a second REPL turn correctly
  references information from the first turn, proving conversation memory;
  `/exit` and a per-turn Devin error both leave the process in a clean
  state; Phase 3: asking about a file's contents (e.g. "What does
  notes.txt say?") triggers a real read_file call whose result is used in
  the answer, without the user pasting the file content themselves; Phase 4:
  the REPL can list a directory, write a file, and run an approved shell
  command in one session, and the `--print`/`-p` path exercises the same
  tool registry — including the y/n approval prompt for
  `run_shell_command` — while keeping its non-interactive stdout/stderr
  contract for the text-only-answer case; Phase 5: since this phase adds no
  user-visible feature, its "Definition of Usable" is verified by automated
  test rather than manual observation — `src/agent/toolDispatch.test.ts` and
  `src/agent/recovery.test.ts` prove the parallel/sequential decision and
  error classification directly, and `src/agent/turn.test.ts`'s integration
  tests prove all three mechanisms wired together: a batch of two
  `read_file` calls on different paths genuinely runs concurrently while two
  calls on the same path run one at a time, a tool call whose buffered JSON
  never parses pushes a corruption message without ever invoking the tool,
  and a round that throws a retryable API error is retried automatically
  and succeeds without surfacing a failure to the caller — plus a manual
  `pnpm start --print "..."` smoke test confirms the non-corrupted,
  non-retried common case is unregressed; Phase 6:
  `src/agent/iterationBudget.test.ts` proves budget consumption and
  exhaustion directly, while `src/agent/turn.test.ts` proves the turn loop
  consumes only the allowed number of outer rounds and appends the friendly
  limit message to returned history; Phase 7: `src/agent/turn.test.ts`'s
  three new event tests prove `tool_execution_start`/`tool_execution_end`
  fire in order for a sequential call, fire once with empty args and
  `isError: true` for a corrupted call, and fire an independent per-call
  pair — correlated by `toolCallId`, never collapsed to a `"__batch__"`
  sentinel — for a parallel batch;
  `src/tools/toolLabel.test.ts` proves `buildToolLabel`'s verb+arg
  formatting for the labeled file/terminal tools plus its unregistered-tool,
  missing/non-string-preview-arg, whitespace-collapsing, and
  60-character-truncation fallback paths; `src/spinner.test.ts` proves
  the one-shot terminal spinner's frame cadence and final `✓`/`✗` line
  under fake timers — plus a manual REPL smoke test (a spinner+label line
  during a tool call, a permanent `✓`/`✗` scrollback line after, and one
  collapsed `"Running N tools concurrently"` line for a concurrent batch
  instead of N separate ones) and a manual one-shot smoke test confirming
  the spinner writes only to stderr, never stdout); Phase 9's original manual
  skin/config/banner implementation is superseded by ADR 0007. Current TUI
  coverage includes exact palettes and terminal-over-OS detection
  (`src/repl/theme.test.ts`), alternate-screen and mouse cleanup
  (`lifecycle.test.ts`), physical-row paging/bottom-follow/unseen-cue behavior
  (`viewport.test.ts`), SGR wheel parsing (`mouse.test.ts`), multiline composer
  controls and protocol filtering (`composer.test.ts`), Markdown and code boxes
  (`markdown.test.ts`), terminal resize fallback (`terminalSize.test.ts`), and
  chronological assistant/tool segmentation (`streamingTranscript.test.ts`).
  `src/commands.test.ts` proves `matchCommand`'s unique-prefix
  resolution (including its ambiguous-`/`-and-no-match undefined cases),
  `findMatches`'s full candidate list, `parseSlashCommand`'s
  command/arg split, and `nextCompletionState`'s state transitions across
  Tab (freeze-then-cycle through multiple matches, auto-complete a single
  match with a trailing space) and Escape (reset to empty). `/help` lists
  `/exit`, `/help`, and `/clear`; there is no `/skin` command. Phase 11:
  `src/tools/todo.test.ts` proves todo normalization, flat replace
  writes, global-id merge with partial-field updates (status-only and
  content-only patches), last-occurrence-wins duplicate-id collapse,
  malformed-item coercion, bad-status normalization, truncation,
  256-item cap, four-way summary breakdown, and active-work injection
  formatting; `src/tools/todo.integration.test.ts` proves the planning
  schema is exposed and caller-owned stores do not leak;
  `src/agent/turn.test.ts` proves `todo` is available to Devin and
  updates the injected store; `src/repl/App.test.tsx` covers the
  panel's empty/loading/nonempty behavior, status glyph rendering,
  and transcript suppression for todo completions); Phase 12:
  `src/persistence/sessionStore.test.ts` exercises real temporary databases
  for schema reopen, exact codecs, lazy/atomic/idempotent checkpoints,
  summaries, missing IDs, and fail-closed corruption; `src/cli.test.ts`
  covers parsing, chooser dispatch/cancel, no-session handling, direct resume,
  and proves list/chooser/print avoid Devin or SQLite where required;
  `src/repl/SessionChooser.test.ts` covers wrapping Up/Down navigation;
  `src/session.test.ts` covers required saved models; and
  `src/repl/App.test.tsx` covers transcript/todo hydration, rollback helpers,
  unsaved retry, and recovery clearing. Phase 13: `src/auth.test.ts` covers
  environment/file selection, missing-cache OAuth, model-discovery and stream
  invalidation, removal failure, fresh login verification, cache preservation,
  and idempotent logout; `src/cli.test.ts` proves exact auth-command parsing and
  stateless dispatch; `src/errors.test.ts` proves source-specific recovery text
  without credential disclosure; and recovery/turn tests prove exact status
  classification, 500ms/1000ms delays, immediate 401 failure, unchanged turn
  history, and no automatic replay. Phase 14: `src/config.test.ts` covers
  defaults, recursive merge, validation, read failures, unknown-field
  preservation, and atomic replacement; `src/paths.test.ts` covers centralized
  application paths; `src/cli.test.ts` proves exact stateless config dispatch;
  `src/session.test.ts` covers null, exact, recovery, persistence ordering,
  cancellation, write failure, non-TTY errors, and unchanged resume pinning;
  chooser/lifecycle tests cover model rows, wrapping and rapid sequential input,
  resize windows, screen-reader behavior, and terminal cleanup. Phase 16:
  `src/agent/compaction.test.ts` proves `approxTokenCount`, the middle-truncation
  marker and verbatim prefix/suffix preservation, summary-message detection,
  newest-first-then-chronological user-text selection (including truncate-not-drop
  at the token-budget boundary), single-message packaging with the separator
  and summary prefix, and `runCompaction` against a fake provider covering the
  success path, the 413-front-trim retry succeeding on a shrunk request, and a
  413 that persists to a single request message rethrowing; `src/agent/turn.test.ts`
  proves the 90%-threshold proactive check is inert for the ~20 pre-existing
  tests (each given a 1,000,000-token `contextWindow`) and adds dedicated
  low-threshold tests for triggering compaction mid-turn, firing `onCompact`,
  staying inert below threshold, and not double-compacting when a reactive
  413 retry still crosses the proactive threshold in the same round;
  `src/agent/recovery.test.ts` proves the widened 4-member `RecoveryAction`,
  HTTP 413 classifying as `compress_and_retry`, `compress` being awaited with
  no backoff delay, and both compression-attempt exhaustion and the
  no-`compress`-callback fallback rethrowing; a manual smoke test round-trips
  `/compact`'s exact compacted-summary-plus-ack output through a real
  `sessionStore.ts` checkpoint without `SessionCorruptionError`. Phase 17:
  `src/agent/{queue,agent}.test.ts` covers immutable queue order/cleanup,
  lifecycle guards, boundary injection, provider abort, protocol-valid empty
  assistant settlement, and reuse after cancellation; turn and registry tests
  cover stopped sequential/parallel tool results and required run signals;
  `src/tools/runShell.test.ts` covers approval abort/failure and live shell
  termination; REPL lifecycle and streaming-transcript tests cover Ctrl+C
  target selection, chronological steering injection, and non-duplicating
  abort settlement. Phase 18: `src/agent/agentSession.test.ts` proves two
  independent subscribers observe the identical ordered `AgentSessionEvent`
  sequence for a run with a tool call (including the full
  `agent_start`→…→`agent_settled` order), that unsubscribing one listener
  never affects another still-subscribed one, that `queue_update` fires
  once on `steer` enqueue and again once the injected message's
  `message_start` dequeues it, that `agent_settled` fires exactly once per
  `run()` call across normal/aborted/fatal-error outcomes, and that
  `steer`/`followUp` on an idle session throw without mutating the queue
  mirror or emitting `queue_update`.
  Phase 22: `src/checkpoint.test.ts` proves `shadowGitDir` determinism,
  `snapshot` creates a commit in a fresh shadow repo, a second snapshot when
  nothing changed is a no-op (covered by `--allow-empty`), `rollback` restores
  overwritten and deleted files to their pre-snapshot content, rollback against
  a missing shadow repo throws, `createCheckpointGuard.beforeMutation` takes
  exactly one commit per turn (duplicates are no-ops), and `resetTurn` re-arms
  the guard so the next `beforeMutation` takes a second commit;
  `src/tools/writeFile.test.ts` proves `checkpointGuard.beforeMutation` is
  invoked exactly once when the guard is present in `ToolContext`;
  `src/commands.test.ts` proves `/rollback` is present in `KNOWN_COMMANDS` and
  returned by `findMatches`.
  Phase 19: `src/tools/clarify.test.ts` proves all six handler cases — missing question arg, absent callback, open-ended callback call returning `{ question, answer }` JSON, choices callback call, max-4 truncation, and abort-before-call returning the stopped message; `src/agent/systemPrompt.test.ts` proves the clarify guidance string is present in the generated prompt; full suite (42 files / 421 tests) passes with zero regressions; `pnpm typecheck` passes clean under `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true`.
  Phase 20: `src/trust.test.ts` proves `createProjectTrustStore` returns `unknown` for unrecorded directories, `trusted (persisted)` after `set(cwd, "trust")`, `denied (persisted)` after `set(cwd, "deny")`, `trusted/denied (session)` for session-only choices without writing to disk, `trust-parent` persisting to `dirname(cwd)` with child inheritance, ancestor walking (trusting `/a/b` makes `/a/b/c/d` trusted), independent sibling directories, persisted-decision load-on-creation, and missing-file empty-store semantics; `resolveProjectTrust` proves `cliApprove` short-circuits without prompting, `cliNoApprove` short-circuits, `defaultTrust: "always"/"never"` short-circuit, existing persisted decision bypasses prompt, and `defaultTrust: "ask"` with no stored decision calls the prompt and persists the result; `assertProjectTrustedForRead` and `assertProjectTrustedForInstall` prove they do not throw on `trusted` and do throw (with the resource path in the message) on `denied`/`unknown`. `src/cli.test.ts` proves `--approve`/`-a`/`--no-approve`/`-na` flag parsing on fresh/print/resume modes, rejection on login/logout/config/list modes, and both-flags-together throwing `CliUsageError`; `src/config.test.ts` proves `defaultProjectTrust` defaults to `"ask"`, is included in the persisted output of `setConfiguredModel`, and is rejected for values outside the `"ask"/"always"/"never"` set. See ADR-0013.
  Phase 21: `src/security/commandApproval.test.ts` proves hardline blocks for
  `rm -rf /`, `mkfs.*`, fork bombs, and `dd of=/dev/<disk>`, that hardline
  overrides `"off"` and `"smart"` modes, dangerous-pattern detection for
  `rm -r*`/`sudo`/`git push --force`/`curl | sh`, safe command pass-through for
  `ls`/`echo`/`cat`, session-approval bypass (pattern in set → skip), mode
  `"off"` bypass (dangerous but not hardline → skip), and mode `"smart"`
  returning `needs_approval` (LLM call is the caller's responsibility);
  `src/security/commandApproval.test.ts` also covers `stripShellComments` for
  trailing comments, single-quoted and double-quoted `#` preservation, and
  multiline stripping. `src/security/smartApproval.test.ts` proves correct
  verdict mapping (`APPROVE`→`approve`, `DENY`→`deny`, `ESCALATE`→`escalate`),
  fail-safe escalation on garbage output and stream errors, whitespace/case
  tolerance, and comment stripping before the reviewer sees the command.
  `src/tools/runShell.test.ts` adds gate integration tests: `rm -rf /` forbidden
  in `"off"` mode (hardline wins), safe `echo` runs without confirmation in
  `"manual"` mode, `sudo` prompts in `"manual"` mode, `git push --force` skips
  confirmation in `"off"` mode, session-approved `rm_recursive` skips re-prompt,
  and human approval adds `"sudo"` to the session approvals set. `src/config.test.ts`
  covers valid `approvalMode` values, invalid-value rejection, `reviewerModel`
  validation, and round-trip preservation through `mergeConfig`. Manual smoke
  test: set `~/.railgun/config.json` to `{"approvalMode":"manual"}`, ask the
  agent to run `rm -rf /` — blocked immediately, no prompt; ask for `ls` — runs
  immediately, no prompt; ask for `sudo echo hi` — approval prompt fires; approve
  it, then ask for `sudo ls` — runs without re-prompting (session-approved).
  Phase 23: `src/extensions/runner.test.ts` proves `emitToolCall`'s
  fail-closed propagation, first-blocker short-circuit, non-blocking
  passthrough, `emitToolResult`'s per-handler error isolation and
  later-wins content/isError accumulation, `emitInput`'s transform chain and
  `"handled"` short-circuit, and session lifecycle observers that catch throws
  without propagating; `src/extensions/loader.test.ts` proves `.js` file
  loading, subdirectory `index.js` loading, non-ts/js file skipping, per-module
  error isolation with continued loading, `trusted:false` skipping the
  project-local directory, and stub API no-ops; `src/agent/turn.test.ts`
  adds three integration tests: a blocking `tool_call` handler produces a
  `"Blocked by extension"` error tool result, a `tool_result` handler
  that rewrites content changes the tool message seen by the model, and a
  throwing `tool_call` handler produces an error tool result without crashing
  the agent. Manual smoke tests: (1) create `~/.railgun/extensions/latency-logger.js`
  with a `tool_result` handler logging `[latency] <toolName> took <N>ms` to
  stderr — run `pnpm start -p "List the files"` and confirm the latency line
  appears; (2) create `~/.railgun/extensions/no-shell.js` that blocks
  `run_shell_command` — run `pnpm start -p "Run: echo hello"` and confirm the
  tool result contains `"Blocked by extension"`; (3) edit the latency logger
  to throw inside its handler — confirm the tool still executes, stderr shows
  the extension error, and the process does not crash.
  Phase 24: `src/extensions/mcp/naming.test.ts` proves `sanitizeForToolName`
  lowercasing, special-char replacement, consecutive-underscore collapse, and
  leading/trailing strip; `makeUniquePrefixedName` prefix format, deduplication
  suffix, cross-server name independence, and same-sanitized-name collision
  within a server. `src/extensions/mcp/config.test.ts` proves `parseMcpServers`
  returns `{}` for non-objects, parses valid `command`/`args`/`env`, skips
  entries without a string `command`, and filters non-string `env`/`args`
  values. `src/extensions/mcp/connection.test.ts` connects to a real
  subprocess fixture, discovers its tools, calls `echo` and verifies the
  returned string, rejects on a non-existent binary, and rejects pending RPC
  calls when the server exits unexpectedly. `src/extensions/mcp/index.test.ts`
  verifies prefixed tool registration, multi-server fan-out, degraded startup
  when one server fails (others still load), `close()` propagation, and that
  `execute` calls `conn.call` with the original (unprefixed) tool name. Manual
  smoke test: add `{"mcpServers":{"filesystem":{"command":"npx","args":["-y",
  "@modelcontextprotocol/server-filesystem","/tmp"]}}}` to
  `~/.railgun/config.json`, run `pnpm start`, and confirm tools prefixed
  `mcp__filesystem__` appear in the startup tool list; then change the command
  to a typo and confirm the agent still starts with an `[mcp]` error on stderr.

  Phase 25: `src/persistence/memoryStore.test.ts` proves `save` inserts and
  returns a `Memory` with a UUID id and correct fields, `recent` returns
  memories newest-first with stable `rowid DESC` ordering for same-millisecond
  inserts, `search` is case-insensitive, cross-reopen persistence works, and
  `formatMemoriesForPrompt` returns `null` for empty arrays;
  `src/tools/memory.test.ts` (registry integration) proves `memory_write`
  and `memory_search` are exposed under the `"memory"` toolset, `memory_write`
  with valid args returns `"Saved."`, both tools return `isError: true` when
  `memoryStore` is absent from `ToolContext`, and `memory_search` returns the
  `"No matching memories found."` sentinel on misses;
  `src/agent/systemPrompt.test.ts` proves the `# Memories` block appears only
  when `memories` is non-null, is placed after `# Project Context`, and the
  tool rules block contains the `memory_write` instruction;
  `src/persistence/sessionStore.test.ts` proves a v1 database is transparently
  migrated to v2 (memories table created, `user_version` bumped). Manual smoke
  test: tell the agent a fact in session 1, quit, start a new fresh session (no
  `--resume`), ask about the fact — agent answers correctly from memory.
  Phase 32: `src/agent/moa.test.ts` (new) proves `truncateToolResult`
  under/over budget passthrough and head+tail omission,
  `buildReferenceMessages` text extraction for user/assistant/tool messages,
  tool-call rendering, tool-result folding into preceding assistant content,
  synthetic advisory message appended when conversation ends on an assistant
  turn, and empty-conversation fallback; `buildAggregatorGuidance` label
  formatting, per-reference blocks, and advisory framing;
  `injectMoAGuidance` appends without mutating the input array;
  `runOneReference` collects text_delta events, uses
  `REFERENCE_SYSTEM_PROMPT` and no tools, passes temperature from slot,
  returns a labelled failure note on provider error without throwing, breaks
  early at the char budget, and passes `maxTokens` to `streamChat`;
  `runReferences` fans out in parallel and preserves order with mixed
  success/failure. `src/config.test.ts` (extended) proves valid `moaPresets`
  round-trips, missing `referenceModels`/`aggregator.model` and
  non-numeric/non-positive `referenceMaxTokens` reject with `ConfigError`,
  more-than-8 models reject, `parseMoAPreset` ignores unknown extra keys,
  and `activeMoaPreset` pointing to a nonexistent preset rejects at load
  time. `src/agent/turn.test.ts` (extended) proves:
  `moa_reference_start`/`moa_reference_end`/`moa_aggregating` events fire
  before `turn_start`; the aggregator's `streamChat` request messages
  contain the injected guidance user message with "Mixture of Agents"; one
  failed reference still produces `ok: true` with `[failed:` in the
  guidance; the aggregator model override from `preset.aggregator.model`
  is used for the acting `streamChat` call; and no MoA code runs when
  `moaPreset` is not provided. Full suite (49 files / 601 tests) passes;
  `pnpm typecheck` clean.

## Open Questions

- Which later phases (GUIs, messaging gateways) get built, and in what
  order, beyond the replication plan's suggested sequence — deferred
  until each phase is actually started. Interrupt and steering queues shipped
  in Phase 17; the typed event bus replacing `LoopCallbacks` shipped in
  Phase 18; the clarify tool shipped in Phase 19; command risk gate and smart approval shipped in Phase 21; shadow-git checkpoints and `/rollback` shipped in Phase 22; the extension system shipped in Phase 23; MCP client support shipped in Phase 24.
- Project-local extension trust gating: the `trusted` parameter is wired but
  unconditionally `true`; a future phase should gate it on an explicit user
  opt-in (e.g. `railgun trust` command or a `~/.railgun/trusted-projects` list).
