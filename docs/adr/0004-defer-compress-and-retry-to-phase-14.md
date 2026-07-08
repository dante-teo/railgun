# 0004. Defer `compress_and_retry` to Phase 14; classify HTTP 413 as `fail_immediately` for now

Date: 2026-07-08

## Status

Accepted

## Context

Phase 5 (agent loop internals / harness engineering) ports Hermes Agent's
error-classification idea into `src/agent/recovery.ts`: `classifyError`
maps a thrown error to a `RecoveryAction`, and `callDevinWithRecovery`
retries a step only when the action says to.

The replication plan's Phase 5 pseudocode (`replication_plan.md` lines
619-825) specifies a 4-member `RecoveryAction` union —
`"retry_with_backoff" | "fail_immediately" | "compress_and_retry" |
"reauth_required"` — where an HTTP 413 (payload too large) classifies as
`"compress_and_retry"`, and `callDevinWithRecovery` takes a second
`compress: () => Promise<void>` callback it awaits before looping back
for another attempt when that action is returned.

Railgun has no context-compression mechanism yet — that's the
replication plan's Phase 14, not built as of Phase 5. Implementing
`compress_and_retry` now would mean adding a branch and a callback
parameter with nothing real to call: either a no-op stub (compresses
nothing, retries with the same oversized request, guaranteeing a second
413) or a partial guess at what Phase 14's compression API will look
like, written before that phase's own design work happens.

## Decision

`src/agent/recovery.ts`'s `RecoveryAction` ships with 3 members only —
`"retry_with_backoff" | "fail_immediately" | "reauth_required"` — and
`classifyError` maps HTTP 413 to `"fail_immediately"`, the same as 400.
`callDevinWithRecovery` takes no `compress` parameter.

`"reauth_required"` and `"fail_immediately"` currently produce identical
behavior (rethrow immediately, no retry) — this is intentional, not
redundant. Phase 11 (robust Devin login) will give `"reauth_required"`
its own recovery path (e.g. trigger a re-login flow instead of failing
the turn) without needing to re-derive which errors mean "auth is dead"
versus "the request itself is bad." Keeping them as distinct enum
members now, even though they currently behave the same, avoids a
second classification pass over the same errors later.

## Consequences

- A request that is genuinely too large for Devin's API (HTTP 413) fails
  the turn immediately today instead of being salvaged via compression.
  This is a real capability gap, not a bug — Railgun has no long-running
  conversation compaction yet, so there is nothing to compress into a
  smaller request even if the classification pointed somewhere useful.
- When Phase 14 (context compression) is built, it must revisit
  `src/agent/recovery.ts`: widen `RecoveryAction` to 4 members, change
  the 413 branch in `classifyError` to `"compress_and_retry"`, and give
  `callDevinWithRecovery` a `compress: () => Promise<void>` parameter
  with a new branch that awaits it and continues the retry loop instead
  of throwing. This ADR intentionally does not pre-design that shape —
  if Phase 14 turns out to need compression to happen *before*
  classification rather than as a reaction to a classified 413 (e.g. a
  size check ahead of the request, not an error-driven retry), that
  phase re-derives `recovery.ts`'s shape from scratch instead of being
  constrained by a guess made here.
- Every other Phase 5 mechanism (parallel-safe tool batching, corrupted
  tool-call JSON detection) has no such gap — both are fully implemented
  as specified, with no reduced scope relative to the replication plan.
