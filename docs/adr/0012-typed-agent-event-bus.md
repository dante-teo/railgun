# 0012. Typed agent event bus

Date: 2026-07-12

## Status

Accepted

## Context

Phase 17's `LoopCallbacks` (`onDelta`/`onToolStart`/`onToolComplete`/
`onCompact`/`onQueueInjected`/`onAbort`) served exactly one consumer at a
time: `src/oneShot.ts`'s spinner or `src/repl/App.tsx`'s streaming/tool-label
rendering, each constructing its own callback object and passing it straight
into `runTurn`. Phase 18 needs several independent, decoupled consumers to
observe the same running turn — a CLI logger, an in-memory test collector,
and later a TUI/JSONL forwarder — without any of them knowing about each
other or being able to interfere with each other's state. A single-slot
callback object cannot fan out to more than one listener, and the parallel
tool-batch path collapsed every call in a batch into one synthetic
`"__batch__"` name+args pair because the old callback shape carried no
per-call id to correlate real starts with real ends.

## Decision

Replace `LoopCallbacks` with a typed, two-layer event stream:

- `src/agent/events.ts` defines the shared `AgentEvent` union —
  `agent_start`/`agent_end`, `turn_start`/`turn_end`,
  `message_start`/`message_update`/`message_end`,
  `tool_execution_start`/`tool_execution_end`,
  `compaction_start`/`compaction_end` — plus the `ToolResult` shape
  (`toolCallId`, `content`, `isError`) both `turn.ts` and `agentSession.ts`
  depend on.
- `src/agent/turn.ts`'s `runTurn`/`runStep` take an `emit?: (event:
  AgentEvent) => Promise<void>` sink (defaulted to a no-op) instead of
  `callbacks?: LoopCallbacks`, and call it unconditionally at every event
  point instead of scattering optional chaining.
- `src/agent/agent.ts`'s low-level `Agent` gains `subscribe: (listener:
  AgentEventListener) => () => void`; `createAgent` fans each raw
  `AgentEvent` out to every registered listener, catching and
  `console.error`-ing a failing listener so one bad subscriber cannot break
  another or the run itself.
- `src/agent/agentSession.ts` (new) is a session wrapper: `createAgentSession`
  wraps `createAgent` and re-emits the raw `AgentEvent` stream plus two
  session-only additions — `agent_settled` (fires exactly once per completed
  `run()` call regardless of outcome: `ok`, `aborted`, or fatal `error`) and
  `queue_update` (`{ steering, followUp }`, a session-local mirror of the
  queues that `createAgent`'s own queue module exposes no read accessor for,
  updated on `steer`/`followUp` enqueue and again when the injected message's
  `message_start` passes through and is matched off the mirror). Both
  `Agent.subscribe` and `AgentSession.subscribe` use the same
  add-to-`Set`/return-remove-closure shape.
- `__batch__` is gone. A parallel batch now emits one real
  `tool_execution_start`/`tool_execution_end` pair per call, correlated by
  its actual `toolCallId`. The `Promise.all` barrier is preserved
  structurally: every call's `tool_execution_start` fires before the batch
  awaits, and every `tool_execution_end` fires only after the whole batch
  settles — starts and ends are still batched, just individually
  identified, never truly interleaved.
- `message_start`/`message_end` bracket every message `turn.ts` pushes, not
  just the streamed assistant reply: the initial user prompt, steer/follow-up
  injections, and every tool-role result each get their own
  `message_start`/`message_end` pair. This is what lets `agentSession.ts`
  detect a steer/follow-up dequeue (a subsequent user-role `message_start`)
  without a dedicated "queue drained" event from `turn.ts` itself.
- `compaction_start`/`compaction_end` are raw `AgentEvent` variants with
  `reason: "threshold" | "overflow"`, constructed inside `turn.ts`'s
  `compress` closure — not something `agentSession.ts` reshapes.
  `AgentSessionEvent` is a strict superset of `AgentEvent` via a `|
  AgentEvent` union member, so both pass through unchanged.
- Abort emits a full `turn_end`+`agent_end` pair via a `turnEndedThisAttempt`
  guard: if `runStep` already returned a real assistant message this attempt
  (e.g. tool dispatch hit `signal.aborted` mid-batch without throwing),
  `turn_end` already fired for that attempt and is never emitted twice; only
  when `runStep` itself threw without ever returning does the abort path
  synthesize a closing `turn_end`.
- A fatal, non-recoverable error (e.g. HTTP 401) emits no terminal `AgentEvent`
  at all. The rejected `{ ok: false, error }` `TurnOutcome` return is itself
  the terminal signal; `agent_settled` still fires at the session layer
  because it wraps `run()`'s `finally`, independent of whether `agent_end`
  fired.
- `src/oneShot.ts` and `src/repl/App.tsx` both migrated from constructing a
  `LoopCallbacks` object to calling `subscribe` on a `createAgentSession`
  result. `App.tsx`'s single `toolLabel` string became a `toolLabels: Map<
  toolCallId, label>` so concurrent calls each render their own ephemeral
  tool line instead of collapsing into one. `oneShot.ts`'s single spinner
  slot is now explicitly tracked (`animatedCallId`) since real per-call
  events can now fire concurrently; any call beyond the one animated slot
  falls back to a static, non-animated log line plus a manually written
  `✔`/`✘` line.

## Consequences

- Multiple independent consumers (CLI logger, in-memory test collector, a
  future TUI/JSONL forwarder) can observe the same running turn simultaneously
  without coordinating with each other — a failing or slow listener cannot
  block or corrupt another listener's view of the stream.
- `tool_execution_update` (a variant for partial per-tool-call output) is
  deferred: none of the five registered tools stream partial results today.
- A session-level `"manual"` compaction reason is deferred: `/compact` in
  `App.tsx` still calls `runCompaction` directly, unrouted through any
  session, since it runs between turns with no session in scope.
- Session lifetime stays per-submission — a fresh `createAgentSession` per
  `handleSubmit`/`runOneShot` call, not shared across turns. A future phase
  that wants subscribers to persist across multiple user turns (e.g. a
  long-lived TUI process) must restructure `App.tsx`'s state model to hold
  one session for the REPL's lifetime.
