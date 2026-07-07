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

**Current phase — Phase 2 (multi-turn Ink REPL):** an Ink (React-for-CLI)
terminal chat that logs into Devin once, caches the token, lists available
models, and keeps a scrolling conversation alive for the process lifetime —
every turn's `history` is sent as context on the next turn. Phase 1's
one-shot behavior is preserved behind an explicit `--print`/`-p` flag for
CI/scripting use. No tools, no persistence across restarts, no GUI beyond
the terminal.

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
   scriptable/CI invocation that reproduces Phase 1's exact stdout/stderr
   contract — no interactive REPL, no conversation memory.

## Success Metrics

- Each phase's own "Definition of Usable" from the replication plan is met
  and manually verified (e.g. Phase 2: a second REPL turn correctly
  references information from the first turn, proving conversation memory;
  `/exit` and a per-turn Devin error both leave the process in a clean
  state; the `--print`/`-p` path reproduces Phase 1's one-shot contract
  byte-for-byte).

## Open Questions

- Which later phases (tool calling, session persistence across restarts,
  GUIs, messaging gateways) get built, and in what order, beyond the
  replication plan's suggested sequence — deferred until each phase is
  actually started.
