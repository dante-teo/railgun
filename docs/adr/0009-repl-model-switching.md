# 0009. REPL `/model` command for live model switching

Date: 2026-07-11

## Status

Accepted

## Context

Railgun's Phase 14 established `~/.railgun/config.json` as the configuration
source and added interactive model recovery when a configured model becomes
unavailable, but offered no way to switch models during a running conversation.
Hermes Agent's own architecture places model switching in the chat surface
(REPL), not as a CLI subcommand — a `railgun model <name> --session` that exits
immediately would be meaningless.

## Decision

- `/model` is a REPL-only slash command. No `railgun model` top-level CLI
  subcommand is added.
- `buildSessionCore` (exported from `session.ts`) rebuilds the session — system
  prompt, context, identity — without `console.error` logging, making it safe to
  call under Ink's alternate-screen buffer.
- `resolveModelCommand` (exported from `ModelChooser.tsx`) is pure logic: given
  the user's argument string, the list of available models, and the current model
  id, it returns a discriminated union — show listing, switch (with persist
  flag), or error. This keeps all model-formatting/selection logic colocated with
  `modelMetadata`.
- Bare `/model` opens an inline interactive picker within the running REPL,
  reusing the shared selection mechanics (`moveSelection`, `selectionListWindow`)
  and `ModelRow` component from the startup model chooser. Up/Down navigates,
  Enter switches, Escape cancels.
- `/model <name-or-index>` switches directly without the picker and persists the
  choice to `config.json` as the default for all future sessions.
- `/model <name-or-index> --session` switches for the current REPL run only,
  without touching the persisted default. `/model --session` opens the picker in
  session-only mode.
- Conversation history, todos, and iteration budget are untouched by a switch.
- Resumed sessions stay pinned to their originally recorded model. The
  checkpoint closure in `cli.ts` captures the persisted model at mount time;
  `sessionStore.ts`'s corruption guard enforces the invariant. Neither module is
  modified by this phase.

## Consequences

- Users can explore models without restarting the REPL or losing context.
- The persist-by-default semantic matches Hermes: a switch sticks unless
  explicitly scoped to the session.
- `buildSessionCore` is a reusable building block for any future caller that
  needs a fresh session outside the startup path.
- The pure `resolveModelCommand` function is independently testable and
  decoupled from React.
