# 0016. delegate_task — bounded subagent spawning

Date: 2026-07-12

## Status

Accepted

## Context

The top-level agent loop is single-threaded: every tool call blocks the turn
until it completes, and the model's context window is a shared resource that
grows with every tool exchange. For wide or decomposable tasks — summarise
five files, investigate three independent hypotheses, run a test suite in
parallel while reading documentation — blocking sequentially is both slow and
wasteful. Hermes Agent handles this via a `delegate_task` tool that spawns
independent child agent loops; Phase 31 brings an equivalent to Railgun.

The implementation must satisfy three safety properties:

1. **Depth cap.** A child agent must not be able to fan out unboundedly.
   Rogue or confused orchestrators produce finite trees, never infinite
   recursion.
2. **Concurrency cap.** Multiple sibling children must not saturate the
   Devin API concurrently beyond a known bound.
3. **Abort propagation.** Aborting the parent (user Ctrl-C, `/abort`) must
   cancel all running children promptly.

## Decision

**New tool.** `src/tools/delegate.ts` registers `delegate_task` in the
`"delegation"` toolset. The tool accepts either a single `goal` string or a
`tasks` array of `{ goal, context?, role? }` objects and runs them via a
`runBatched` helper that fans them out in groups of `MAX_CONCURRENT_CHILDREN`
(3) using `Promise.all`. Each child is a full `runTurn` call with its own
`IterationBudget` (50 steps), its own `AbortController`, and its own message
history starting empty.

**Toolset filtering.** `RunTurnOptions` gains an optional `enabledToolsets`
field. When provided, `runStep` uses it instead of the module-level
`ENABLED_TOOLSETS` constant. Children use this to restrict their tool surface:
leaf children (the default) receive every standard toolset except
`"delegation"`, so they cannot call `delegate_task`; orchestrator children at
depth below the cap receive `"delegation"` and may delegate further.

**Depth tracking.** `ToolContext` gains an optional `delegationDepth` field
(defaulting to `0` at the top-level agent). Each child is spawned at
`parentDepth + 1`. `delegate_task` rejects calls where `delegationDepth >= 2`
(`MAX_SPAWN_DEPTH`) with an explicit error rather than silently succeeding.

**Context threading.** `ToolContext` and `RunTurnOptions` also gain optional
`model` and `contextWindow` fields so the delegate handler can pass the
parent's model/context-window through to child `runTurn` calls without
reaching outside its handler. `runTurn` always populates these in the context
it constructs; all existing callers that omit them get safe defaults (`model`
from the `runTurn` parameter, `contextWindow` from the `runTurn` parameter,
`delegationDepth: 0`).

**Emit threading.** `ToolContext` gains an optional `emit` field that receives
the parent turn's `doEmit` sink. The delegate handler calls
`emit?.({ type: "subagent_start", ... })` and `emit?.({ type:
"subagent_end", ... })` around each child run, giving the parent's event
stream visibility into delegation activity. Children do not forward their own
internal events (tool calls, compaction, etc.) to the parent's sink — only the
start/end boundary events are propagated.

**Abort propagation.** The handler passes `parentSignal` to each child's
`runOneChild` helper. On every child, a `"abort"` event listener on
`parentSignal` calls `childController.abort(reason)`. The listener is removed
in a `finally` block so it does not leak when children complete normally.

**Serialization.** `delegate_task` is added to `NEVER_PARALLEL_TOOLS` in
`toolDispatch.ts`. If the model emits two `delegate_task` calls in one step,
the turn loop runs them sequentially, preventing the caller from doubling the
effective concurrency cap.

**Child system prompt.** Children receive a short, standalone system prompt:
they are told to complete the task and summarise what they did. They do not
inherit the parent's full system prompt, which is session-specific and may
contain identity or trust context that should not be re-asserted in a
sub-context. The parent passes task-specific background via the `context`
field in delegation args.

**Shell approval.** Children use `commandApprovalMode: "off"` — the parent
agent is already operating under the user's session trust decision, and no
interactive prompt can be answered while the parent is blocked waiting for
child results. This matches Hermes's behaviour.

## Consequences

- The top-level agent can decompose wide tasks into concurrent subagents
  without any new abstractions in the core loop — `runTurn` is called
  directly.
- Children have no access to the parent's conversation history, todo store,
  extension runner, or advisory context — they start from a clean slate. If
  a child needs project context, the caller must pass it explicitly via the
  `context` arg.
- Child tool calls, text deltas, and compaction events are not forwarded to
  the parent's UI. The REPL shows a single "Delegating" spinner for the
  `delegate_task` call; per-child progress requires a follow-up phase.
- The depth cap (2) and concurrency cap (3) are module-level constants.
  Changing them is a one-line edit; making them runtime-configurable is
  deferred.
- `ToolContext` now imports `AgentEvent` from `../agent/events.ts`, reversing
  the natural `agent → tools` dependency direction. This is a pragmatic
  shortcut; a cleaner resolution (shared types module, or an opaque callback
  type) is deferred to avoid scope creep in this phase.
