# railgun

A from-scratch TypeScript replication of [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s
core agent loop, built incrementally, phase by phase (see
[`docs/PRODUCT.md`](docs/PRODUCT.md)). Phase 1 is a one-shot terminal chat with
Devin — no multi-turn memory, no tools, no GUI yet.

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
pnpm start "What is the capital of France?"
```

- **First run**: no cached credentials exist yet, so a browser window opens for
  Devin sign-in. After you complete login, the token is cached to
  `~/.railgun/devin-token` (mode `0600`) and the answer streams to stdout.
- **Later runs**: the cached token is reused — no browser prompt — and the
  answer streams immediately.
- **No argument**: `pnpm start` alone sends the default question `"Hello!"`.
- **Bad or expired token**: the CLI exits non-zero with a one-line
  `Devin API request failed (401): ...` message on stderr. Fix with
  `rm ~/.railgun/devin-token` and rerun `pnpm start` to log in again.

Status/progress messages (which model is in use, the login prompt) print to
stderr; only the model's answer is written to stdout, so `pnpm start "..." |
some-other-tool` pipes just the answer text.

## Development

```sh
pnpm run typecheck   # tsc --noEmit
pnpm run build       # compile src/ to dist/
```

No test suite exists yet — Phase 1 defers automated tests to whichever later
phase first needs them (see [`docs/PRODUCT.md`](docs/PRODUCT.md)).

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
