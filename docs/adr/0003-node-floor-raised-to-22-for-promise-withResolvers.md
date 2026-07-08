# 0003. Raise the Node floor to >=22 for `Promise.withResolvers()`

Date: 2026-07-08

## Status

Accepted

## Context

Phase 4 (tool registry) adds a `run_shell_command` tool gated behind a
human approval prompt, threaded through both entry points:
`src/repl/App.tsx`'s Ink `useInput`-driven y/n gate and
`src/tools/runShell.ts`'s child-process wrapper. Both express "pause here
until the user answers, then resume" as a stored resolver pattern, which
`Promise.withResolvers()` expresses without a callback-nested `new
Promise((resolve) => ...)` executor.

`Promise.withResolvers()` is an ES2024 runtime API, not just a TypeScript
`lib` addition — it ships unflagged only on Node >=22 (flagged behind
`--harmony-promise-with-resolvers` on 21.7+, absent before that). ADR 0002
deliberately kept this project's floor at `>=20` (pinning Ink 6 instead of
7 specifically to avoid requiring Node 22) and explicitly deferred raising
it to "its own future decision, not bundled into this REPL work."

Phase 4 is that future decision: `package.json`'s `engines.node` was
bumped to `>=22` and `tsconfig.json`'s `lib` to `["ES2024", "DOM",
"DOM.Iterable"]` (target stays `ES2022`) to match.

## Decision

Raise the Node floor from `>=20` to `>=22`. This makes Ink 7 available as
well (ADR 0002 tied the `>=22` floor to Ink 7 specifically), but Phase 4
does not adopt Ink 7 — that stays a separate, not-yet-made decision. The
floor is raised only because `Promise.withResolvers()` needs it, not to
pull in Ink 7 opportunistically.

## Consequences

- `package.json`'s `engines.node` is now `>=22`; any install on Node 20/21
  is no longer supported (previously such installs worked, since nothing
  before Phase 4 used a Node-22-only runtime API).
- ADR 0002's own stated tradeoff for staying on Ink 6 (avoiding Node 22)
  no longer holds — a future phase could revisit adopting Ink 7 without
  that specific objection, though this ADR does not itself make that
  change.
- `tsconfig.json`'s `lib` bump to `ES2024` only affects what TypeScript
  type-checks against; it was necessary but not sufficient on its own —
  the `engines.node` bump is what actually enforces the new runtime floor
  for anyone installing the package (`tsc`/`vitest` do not fail on an
  engines mismatch; only `npm`/`pnpm install --engine-strict` or the
  runtime itself would).
