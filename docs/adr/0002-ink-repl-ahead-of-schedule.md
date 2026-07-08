# 0002. Adopt Ink for the multi-turn REPL ahead of the replication plan's schedule

Date: 2026-07-07

## Status

Accepted

## Context

The replication plan places a polished terminal UI at Phase 26, well after
tools, memory, and safety are built; Phase 2 itself only calls for a plain
`readline` loop with multi-turn `messages` history. The user wants a
component-based, visually distinct chat UI starting now, not a bare
`readline` loop later reskinned.

## Decision

Adopt Ink (`^6.8.0`) + React (`^19.2.0`) + `ink-text-input` (`^6.0.0`) for
the REPL now, kept minimal (scrolling history + input box only — no
markdown rendering, spinners, or themed chrome, which stay deferred to
Phase 26). Pinned to Ink 6, not 7, because Ink 7 requires Node `>=22` and
this project's floor is `>=20`. Phase 1's one-shot `pnpm start "<question>"`
mode is preserved behind an explicit `--print`/`-p` flag for CI/scripting
use, so bare `pnpm start` can launch the REPL instead without breaking
scriptable callers.

## Consequences

- Phase 26's "component-based scrolling chat" goal is substantially met
  early; live tool-activity spinners landed in Phase 7 on top of this same
  `ChatApp` component (see `src/tools/toolLabel.ts`, `src/repl/App.tsx`'s
  `ink-spinner` wiring); remaining Phase 26 polish (`thinking_delta`
  display, themed chrome) still lands when that phase is actually built.
- Railgun's terminal surface now depends on React's reconciler and Ink's
  raw-mode stdin handling instead of a plain `readline` loop — more moving
  parts than the replication plan's own pseudocode, in exchange for a
  reusable, testable-boundary chat component sooner.
- `ink-text-input`'s last published release targets Ink 5; its `useInput`
  and `Text` usage was confirmed stable against Ink 6 (`build/index.js`
  inspected directly). If a real incompatibility surfaces later, a small
  hand-rolled controlled input using `useInput` directly is the fallback,
  not blocking on an upstream release.
- Raising the Node floor to `>=22` (to use Ink 7) is deliberately deferred
  to its own future decision, not bundled into this REPL work.
