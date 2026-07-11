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

 **Current phase — Phase 22 (shadow-git checkpoints and `/rollback`):**
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

## Open Questions

- Which later phases (GUIs, messaging gateways) get built, and in what
  order, beyond the replication plan's suggested sequence — deferred
  until each phase is actually started. Interrupt and steering queues shipped
  in Phase 17; the typed event bus replacing `LoopCallbacks` shipped in
  Phase 18; the clarify tool shipped in Phase 19; shadow-git checkpoints and `/rollback` shipped in Phase 22.
