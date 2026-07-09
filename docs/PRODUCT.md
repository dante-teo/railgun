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

**Current phase — Phase 10 (project-level context files):**
Phase 10 adds automatic discovery and loading of project-level context
files into the system prompt, plus a personal persistent-identity file.
`src/security/threatPatterns.ts` provides a pure, shared injection
scanner: `CONTEXT_THREAT_PATTERNS` (10 curated regexes ported verbatim
from Hermes's `tools/threat_patterns.py`, covering prompt injection,
system-prompt override, disregard-rules, bypass-restrictions, HTML
comment injection, hidden-div injection, role hijack, role pretend,
leak-system-prompt, and remove-filters — all case-insensitive, with
bounded filler `(?:\w+\s+){0,8}` to prevent catastrophic backtracking)
and `scanForThreats(content)` returning matched pattern ids.
`src/agent/projectContext.ts` owns all filesystem I/O for context
discovery, keeping `buildSystemPrompt` pure and synchronous.
`PROJECT_CONTEXT_CANDIDATES` defines the precedence chain:
`.railgun.md`/`RAILGUN.md` (walking up to the git root via
`findUpToGitRoot`, which `stat`s for a `.git` entry at each level),
then `AGENTS.md`/`agents.md`, `CLAUDE.md`/`claude.md`, and
`.cursorrules` (cwd only, no walk) — first file found wins.
`loadProjectContext(cwd)` reads the first match, truncates it
(70/30 head/tail split at a fixed 20 000-char
cap), then scans the retained head and tail independently for
injection via `scanForThreats` (scanning separately prevents
false positives from patterns spanning the truncation seam) — on a
match, the content is replaced with a
`[BLOCKED: <filename> contained potential prompt injection (<ids>).
Content not loaded.]` placeholder and logged via `console.error`; the
blocked result does NOT fall through to the next precedence candidate,
preventing an attacker from probing which file wins by triggering a
block on the higher-priority one.
A whitespace-only or unreadable file falls through to the next
case-variant alias in the same candidate group (e.g. `AGENTS.md` →
`agents.md`) before moving to the next candidate group; a
missing file silently results in `null`. `SOUL_PATH`
(`~/.railgun/SOUL.md`) is loaded by `loadSoulIdentity()` with the
same truncate-then-scan pipeline (see
`docs/adr/0005-soul-md-persistent-identity.md` for why this is
included in Phase 10 rather than deferred). Both loaders are called in
parallel via `Promise.all` during `initDevinSession`
(`src/session.ts`) and their results passed to `buildSystemPrompt`
(`src/agent/systemPrompt.ts`) as optional `soulIdentity` and
`projectContext` fields; when present, they produce a
`# Persistent Identity` block and a `# Project Context` block
appended after the existing identity/tool-rules/environment blocks.
Both fields are optional with `| null`, so all existing callers and
tests are unaffected. No mid-session subdirectory hints
(`agent/subdirectory_hints.py`'s idea), no `.cursor/rules/*.mdc`
support, no config-driven `context_file_max_chars` override — all
deferred to later phases.

The Phase 5 hardening remains in place. Three independent mechanisms sit

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
  Tab cycles through and Escape dismisses).

## Open Questions

- Which later phases (tool calling, session persistence across restarts,
  GUIs, messaging gateways) get built, and in what order, beyond the
  replication plan's suggested sequence — deferred until each phase is
  actually started.
