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

**Current phase — Phase 7 (live tool activity feedback):**
`runTurn` (`src/agent/turn.ts`) now accepts an optional trailing
`LoopCallbacks` object — `onDelta`, `onToolStart`, `onToolComplete` —
alongside the required `confirmShellCommand` gate. `onToolStart`/
`onToolComplete` fire around each of `runStep`'s three existing dispatch
branches: a sequential call reports itself individually
(`name`, real parsed `arguments`); a corrupted call reports itself with
empty `{}` args and `isError: true`; a parallel-safe batch collapses to
one `"__batch__"` sentinel pair reporting only a completion count, never
per-call detail or a pass/fail state — matching Hermes'
`agent/tool_executor.py` spinner behavior rather than firing N separate
pairs. `buildToolLabel` (`src/tools/toolLabel.ts`) turns a tool's
name+args into a verb-based label (`"Reading <path>"`,
`"Running <command>"`, etc.) using each tool's new `verb`/`previewArgKey`
registry fields (`src/tools/registry.ts`), falling back to raw
name+JSON-args for unlabeled or unregistered tools, with whitespace
collapsed and the result truncated to 60 characters. The REPL
(`src/repl/App.tsx`) shows a live `ink-spinner`-driven line in place of
the streaming placeholder while a tool runs, then appends a permanent
green `✓`/red `✗`-prefixed scrollback line once it finishes. The one-shot
`--print`/`-p` path's new `src/spinner.ts` renders the plain-terminal
equivalent (a cycling braille frame, then a final `✓`/`✗` line) on
`process.stderr`, keeping stdout limited to the streamed answer text per
the existing contract.

The Phase 5 hardening remains in place. Three independent mechanisms sit
between `src/agent/turn.ts`'s per-round `streamChat` call and the tool
registry: (1) **parallel-safe tool batching** — a round's tool calls run
concurrently via `Promise.all` only when `shouldParallelizeToolBatch`
(`src/agent/toolDispatch.ts`) proves it's safe (no interactive tool like
the not-yet-built `clarify`, no overlapping file paths across
`read_file`/`write_file` calls, every other tool on an explicit read-only
allow-list), otherwise the round's calls run sequentially, one at a time,
exactly as before; (2) **corrupted tool-call JSON self-healing** —
`turn.ts` now buffers each tool call's raw JSON itself from
`toolcall_delta` events and parses that buffer at `toolcall_end`
(ignoring widevin's own pre-parsed `.arguments`, which silently returns
`{}` on a parse failure instead of surfacing it), so a tool call whose
arguments never parse pushes a labeled corruption message instead of
running with empty/wrong arguments or crashing the turn; (3)
**classified API-failure recovery** — each round is retried up to 3 times
with linear backoff only for failures classified as transient (rate
limits, 502/503, or an unrecognized error type), while a malformed-request
error (400/413) or an auth failure fails the turn immediately instead of
retrying pointlessly. Four tools are registered:
`read_file`, `write_file`,
`list_directory` (toolset `"file"`), and `run_shell_command` (toolset
`"terminal"`, gated behind an interactive y/n approval prompt in both the
REPL and one-shot mode). Both toolsets are hardcoded on for every turn —
no per-profile config yet. Session bootstrap builds one cached Phase 8
system prompt naming the agent "Railgun", setting concise tool-use rules,
and recording the cwd/platform/date/model/provider environment. The date
uses the local calendar day for the process, and environment fields are
quoted as serialized data before they enter the prompt. Every Devin
request reuses that prompt because Devin's Claude-family models reject a
request that declares tools with an empty system prompt.
Phase 1's one-shot mode (`--print`/`-p`) now runs through the same
tool-calling turn loop as the REPL — it is no longer tools-free, but keeps
Phase 1's stdout/stderr contract. No persistence across restarts, no GUI
beyond the terminal.

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
   no interactive REPL, no conversation memory — but, since Phase 4, can
   call the same tools as the REPL, including a stdin-blocking approval
   prompt if the model calls `run_shell_command`.

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
  formatting for all four registered tools plus its unregistered-tool,
  missing/non-string-preview-arg, whitespace-collapsing, and
  60-character-truncation fallback paths; `src/spinner.test.ts` proves
  the one-shot terminal spinner's frame cadence and final `✓`/`✗` line
  under fake timers — plus a manual REPL smoke test (a spinner+label line
  during a tool call, a permanent `✓`/`✗` scrollback line after, and one
  collapsed `"Running N tools concurrently"` line for a concurrent batch
  instead of N separate ones) and a manual one-shot smoke test confirming
  the spinner writes only to stderr, never stdout).

## Open Questions

- Which later phases (tool calling, session persistence across restarts,
  GUIs, messaging gateways) get built, and in what order, beyond the
  replication plan's suggested sequence — deferred until each phase is
  actually started.
