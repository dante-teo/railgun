# Architecture

## Overview

This document records the intended system architecture for Railgun. Keep it current as major components, deployment boundaries, and integration points are introduced.

## Principles

- Prefer simple, composable modules with explicit boundaries.
- Keep side effects at system edges.
- Capture significant technical decisions as ADRs in `docs/adr/`.
- Favor well-maintained open source dependencies when they materially reduce implementation risk.

## System Context

- Users: the project's own author, via a local terminal
- External systems: Devin/Cascade (via `widevin`'s OAuth + HTTP/streaming API)
- Runtime environments: local developer machine (macOS/Linux/Windows), Node.js >= 20

## Components

| Component | Responsibility | Owner |
| --- | --- | --- |
| CLI (`src/cli.ts`) | One-shot terminal chat with Devin | Solo project — no formal ownership split |

## Data Flow

1. User runs `pnpm start "<question>"`.
2. `src/cli.ts` reads the question from argv (default `"Hello!"`) and checks
   `~/.railgun/devin-token` via `widevin`'s `createFileTokenStore`.
3. If no token is cached, `devin.login()` drives an OAuth flow: it opens the
   system browser (`src/openBrowser.ts`) to a Devin sign-in URL and blocks
   until the token exchange completes, then the token store persists it.
4. `devin.listModels()` fetches available models; the first one is selected.
5. `devin.streamChat(...)` opens a streaming request; `text_delta` events are
   written to stdout as they arrive, and a trailing newline is written on
   `done`. All other event types (`thinking_delta`, `toolcall_*`, `usage`)
   are received but ignored until tool calling is implemented in a later
   phase.
6. Any `DevinAuthError`/`DevinApiError`/`DevinProtocolError`/other error
   short-circuits the flow and prints one line to stderr with a non-zero
   exit code.

## Persistence

A single file, `~/.railgun/devin-token` (mode `0600`), holds the cached
Devin auth token — created and managed entirely by `widevin`'s
`createFileTokenStore`. Railgun itself keeps no other on-disk state (no
conversation history yet; that arrives with multi-turn support in a later
phase).

## Integrations

- Devin, via the `widevin` npm package (OAuth login, model discovery, streaming chat). See
  `docs/adr/0001-single-provider-devin-via-widevin.md`.

## Security

- The Devin token is stored in a single user-owned file (`~/.railgun/devin-token`,
  mode `0600`), not in an env var or shell history, limiting exposure to
  other local users/processes on shared machines.
- Railgun never logs or prints the token itself; only the sign-in URL (which
  is not a secret on its own) is printed during login.
- Compliance is an operational responsibility, not a code-enforced one — see
  `docs/adr/0001-single-provider-devin-via-widevin.md`.

## Observability

TBD

## Deployment

TBD

## Architectural Decision Records

Architecture decisions are tracked in `docs/adr/`. Use short, dated records for decisions that meaningfully affect structure, dependencies, operations, or long-term maintenance.
