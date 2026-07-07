# railgun

A from-scratch TypeScript replication of [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s
core agent loop, built incrementally, phase by phase (see
[`docs/PRODUCT.md`](docs/PRODUCT.md)). Phase 2 is a multi-turn Ink terminal
chat with Devin — conversation memory for the process lifetime, no tools, no
persistence across restarts yet.

## Prerequisites

- Node.js >= 20
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

`--print`/`-p` reproduces Phase 1's exact one-shot behavior: a single
question in, the streamed answer on stdout, status/progress messages (model
selection, login prompt) on stderr, and a non-zero exit code with a one-line
error on failure — nothing else. `pnpm start --print` alone (no question
text) sends the default question `"Hello!"`. Because only the answer goes to
stdout, `pnpm start --print "..." | some-other-tool` pipes just the answer
text.

Any other positional argument without `--print`/`-p` is a usage error:
`pnpm start "no flag"` prints `Usage: railgun [--print|-p <question>]` to
stderr and exits non-zero without launching anything.

## Development

```sh
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest run — covers src/agent/turn.ts's turn logic
pnpm run build       # compile src/ to dist/
```

The Ink REPL UI itself is verified manually (see `docs/PRODUCT.md`'s
Success Metrics); automated tests are scoped to the pure turn/history logic
in `src/agent/turn.ts`.

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
