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

**Current phase — Phase 11 (planning todos):**
Phase 11 adds a planning tool and REPL panel for multi-step work. The
`todo` tool is registered under the always-enabled `"planning"` toolset
and operates on a caller-owned in-memory store: the REPL keeps one store
for the process lifetime, while each `--print`/`-p` invocation gets a
fresh store. There is intentionally no persistence or history hydration
yet. `src/tools/todo.ts` owns the reducer/store boundary and hardening:
nested todos, globally unique ids, a 256-node cap, 4000-character content
cap with truncation marker, invalid-status normalization to `pending`,
blank-content rejection, deterministic duplicate-id collapse, derived
parent progress, and active-work formatting for prompt injection.
`src/repl/App.tsx` renders nonempty todo state in a persistent panel above
the input, shows a `Crafting todos` spinner while an empty todo update is
in flight, suppresses normal transcript tool-completion lines for `todo`,
and keeps one store in a React ref. `--print` mode keeps todo activity
silent so stdout remains the final answer. `src/repl/markdownTodos.ts`
provides a narrow fallback for explicit markdown checkbox lists when the
model ignores the tool; ordinary bullet and numbered lists remain visible
as normal transcript text.

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
   streamed replies from the scrollback, with each turn remembering the
   whole conversation for the process's lifetime.
2. Run `pnpm start --print "<question>"` (or `-p`) for a one-shot,
   scriptable/CI invocation that keeps Phase 1's stdout/stderr contract —
   no interactive REPL, no conversation memory — but can call the same
   tools as the REPL, including silent todo planning and a stdin-blocking
   approval prompt if the model calls `run_shell_command`.

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
  the spinner writes only to stderr, never stdout); Phase 9:
  `src/skins.test.ts` proves `resolveSkin` returns the matching
  `SkinConfig` for both builtin skin names and `undefined` for an
  unrecognized one, and that `BUILTIN_SKINS` exposes exactly the
  `default`/`mono` keys; `src/config.test.ts` (mocking
  `node:fs/promises`) proves `loadConfig` falls back to the default skin
  on a missing file (ENOENT), invalid JSON, and a recognized-but-unknown
  skin name, and that `saveConfig` calls `mkdir` with
  `{ recursive: true }` before `writeFile`-ing the serialized config;
  `src/commands.test.ts` proves `matchCommand`'s unique-prefix
  resolution (including its ambiguous-`/`-and-no-match undefined cases),
  `findMatches`'s full candidate list, `parseSlashCommand`'s
  command/arg split, and `nextCompletionState`'s state transitions across
  Tab (freeze-then-cycle through multiple matches, auto-complete a single
  match with a trailing space) and Escape (reset to empty) — plus a
  manual REPL smoke test confirming a bordered banner in the active
  skin's colors appears once above the input on launch, `/help` prints
  the command list, `/skin mono` swaps the prompt symbol and banner
  colors live and persists the choice to `~/.railgun/config.json` across
  a restart, `/clear` visibly clears the terminal without disturbing
  `<Static>` scrollback, and typing `/` shows a suggestions dropdown that
  Tab cycles through and Escape dismisses; Phase 11:
  `src/tools/todo.test.ts` proves todo normalization, nested replace
  writes, global-id merge, duplicate collapse, bad-status normalization,
  blank-content rejection, truncation, 256-node cap, derived parent
  progress, and active-work injection formatting;
  `src/tools/todo.integration.test.ts` proves the planning schema is
  exposed and caller-owned stores do not leak; `src/agent/turn.test.ts`
  proves `todo` is available to Devin and updates the injected store;
  `src/repl/App.test.tsx` and `src/repl/markdownTodos.test.ts` cover the
  panel's empty/loading/nonempty behavior, transcript suppression for
  todo completions, checkbox-list fallback, and the regression guard that
  ordinary bullet/numbered markdown lists are not converted into todos).

## Open Questions

- Which later phases (tool calling, session persistence across restarts,
  GUIs, messaging gateways) get built, and in what order, beyond the
  replication plan's suggested sequence — deferred until each phase is
  actually started.
