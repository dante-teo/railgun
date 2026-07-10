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

**Current phase — Phase 12 (persistent sessions and resume chooser):**
Phase 12 makes successful interactive conversations and their todo snapshots
durable in `~/.railgun/state.db`. Fresh sessions are created lazily on their
first successful checkpoint. `--resume <id>`/`-r <id>` restores one exact session,
bare `--resume`/`-r` provides a newest-first Up/Down keyboard chooser, and
`--list-sessions` reports saved sessions without Devin authentication.
Resumes require their stored model, rebuild launch-specific prompt context,
and hydrate user/assistant text plus todos while omitting historical tool UI
frames. Failed Devin turns roll todos back and save nothing. Failed SQLite
checkpoints retain the completed turn in memory, mark it unsaved, and retry
the full snapshot after the next successful turn. One-shot mode remains
stateless and never opens SQLite.

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
parallel-safe tool batching, corrupted tool-call JSON self-healing,
transient API retry, and the shared iteration-budget behavior still apply
to both the REPL and one-shot paths.

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

1. Run `pnpm start` from a terminal; on first use, complete a one-time
   browser sign-in to Devin; type messages into the Ink chat REPL and read
   streamed replies from the scrollback. Each successful turn checkpoints the
   whole conversation and todos so they can be resumed in a later process.
2. Run `pnpm start --print "<question>"` (or `-p`) for a one-shot,
   scriptable/CI invocation that keeps Phase 1's stdout/stderr contract —
   no interactive REPL, no conversation memory — but can call the same
   tools as the REPL, including silent todo planning and a stdin-blocking
   approval prompt if the model calls `run_shell_command`.
3. Run `pnpm start --resume [session-id]` (or `pnpm start -r [session-id]`) to continue saved work, or
   `pnpm start --list-sessions` to inspect local sessions without logging in.

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
  three new callback tests prove `onToolStart`/`onToolComplete` fire in
  order for a sequential call, fire once with empty args and
  `isError: true` for a corrupted call, and collapse to a single
  `"__batch__"` pair — never firing per-call — for a parallel batch;
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
  `/exit`, `/help`, and `/clear`; there is no `/skin` command and legacy
  `~/.railgun/config.json` is ignored without deletion. Phase 11:
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
  unsaved retry, and recovery clearing.

## Open Questions

- Which later phases (context compression, GUIs, messaging gateways) get
  built, and in what order, beyond the
  replication plan's suggested sequence — deferred until each phase is
  actually started.
