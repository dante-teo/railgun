# railgun

A from-scratch TypeScript replication of [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s
core agent loop, built incrementally, phase by phase (see
[`docs/PRODUCT.md`](docs/PRODUCT.md)). The REPL's agent can read and write
files, list directories, and run shell commands (the last gated behind an
interactive y/n approval prompt) before answering, looping the conversation
with Devin until it has a final text answer. The loop is hardened with
parallel-safe tool batching, corrupted tool-call JSON self-healing,
transient API retry, and a 90-step iteration budget. In the REPL that
budget is shared for the process lifetime; in one-shot mode each invocation
gets a fresh budget. Exhausting it is a graceful stop, not a failure.
Conversation memory lasts for the process lifetime; no persistence across
restarts yet.

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

`pnpm start` with no arguments opens a scrolling Ink chat REPL:

- **First run**: no cached credentials exist yet, so a browser window opens for
  Devin sign-in. After you complete login, the token is cached to
  `~/.railgun/devin-token` (mode `0600`).
- **Later runs**: the cached token is reused — no browser prompt.
- Type a message and press Enter to send it; the reply streams into the
  scrollback. Every prior turn in the session is sent as context on the next
  turn, so the REPL remembers the whole conversation for the process's
  lifetime (not across restarts — see `docs/ARCHITECTURE.md`).
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
- Type `/exit` (or `Ctrl+C`) to quit.
- **Per-turn error**: a failed turn (e.g. an expired token) prints a red
  one-line error into the transcript and the REPL stays open for the next
  message — it does not exit the process. Fix a bad token with
  `rm ~/.railgun/devin-token` and rerun `pnpm start` to log in again.

### One-shot / scripting mode

```sh
pnpm start --print "What is the capital of France?"
pnpm start -p "What is the capital of France?"
```

`--print`/`-p` now runs the same tool-calling turn loop as the REPL (file
read/write, directory listing, shell commands) instead of Phase 1's plain
no-tools stream, but keeps Phase 1's stdout/stderr contract: a single
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

If the model calls `run_shell_command`, `--print`/`-p` prompts on stderr
with `Run shell command: <command>` and blocks reading a line from stdin —
type `yes` to run it, anything else (including EOF) declines. This is a
blocking, interactive prompt: piping stdin closed or non-interactive
(e.g. `< /dev/null`) resolves immediately to "declined" rather than
hanging, but leaving stdin open and unanswered (e.g. a backgrounded process
with no controlling terminal) blocks indefinitely until answered.

Any other positional argument without `--print`/`-p` is a usage error:
`pnpm start "no flag"` prints `Usage: railgun [--print|-p <question>]` to
stderr and exits non-zero without launching anything.

## Development

```sh
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest run — covers src/agent/*.ts's turn/dispatch/recovery logic and src/tools/*
pnpm run build       # compile src/ to dist/
```

The Ink REPL UI itself is verified manually (see `docs/PRODUCT.md`'s
Success Metrics); automated tests are scoped to the pure logic in
`src/agent/turn.ts` (turn/history loop), `src/agent/toolDispatch.ts`
(parallel-batch safety, corrupted-JSON detection), `src/agent/recovery.ts`
(API failure classification and retry), and each tool's own handler logic
in `src/tools/`.

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
