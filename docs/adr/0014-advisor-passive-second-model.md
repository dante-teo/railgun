# 0014. Advisor: passive second model

Date: 2026-07-12

## Status

Accepted

## Context

Phase 17 introduced a steering queue (`agent.steer`) that lets a human operator
push short corrections into the primary agent between turns. The mechanism is
proven, but it only fires when a human is watching and chooses to intervene.
Long-running or unattended sessions can drift: the primary model misses a
requirement, picks a risky shortcut, or misreads a file it just wrote. A second
model that observes the same transcript can catch these errors earlier, but only
if it is genuinely passive — it must never execute commands, never approve
actions, and never speak for the human.

The constraints are strict:

- **Never mutates**: the advisor has no write access to the workspace or the
  conversation state other than injecting advice.
- **Never approves**: it cannot authorise shell commands, file edits, or any
  other primary-agent action.
- **Never replaces the human**: its output is advice the primary agent may
  consider, not instructions it must obey.
- **Never chatters**: an advisor that comments on every turn is worse than no
  advisor.

The goal is a lightweight, read-only reviewer that runs after every completed
primary turn, inspects the new transcript delta, and optionally emits a single
concise note back into the primary conversation.

## Decision

Add an optional `AdvisorRuntime` created inside `createAgent` when
`dependencies.advisor` is supplied. The runtime is implemented in
`src/advisor/advisor.ts` and exposed to the primary agent through a new
`onTurnEnd` callback on `RunTurnOptions`. The runtime's job is to review the
delta since its last cursor position, run a short read-only tool-use loop, and
surface advice through the existing steering mechanisms.

### Advisor lifecycle

`createAdvisorRuntime(devin, config)` is called once at agent construction and
stored on the agent. Before each `runTurn` the agent calls `seedFrom(history)`,
which advances the runtime's cursor to the end of the pre-existing history. This
ensures the first delta the advisor sees is only the messages produced by the
current primary turn, not the entire conversation. When the primary turn ends,
`agent.ts` wires `onTurnEnd` to an async function that awaits
`advisor.onPrimaryTurnEnd(messages, queues.enqueueSteer, pushMessage)`.

`onPrimaryTurnEnd` is **awaited**, not fire-and-forget. This serialises the
advisor's access to its shared history and cursor: the next primary turn cannot
begin until the advisor has finished reading and writing. As a consequence,
`agent.run()` does not return until the advisor finishes.

### Severity routing

The advisor emits notes through a dedicated `advise` tool
(`src/tools/advise.ts`) registered under the `"advisory"` toolset. The tool
accepts a `note` string and an optional `severity` string with values `nit`,
`concern`, or `blocker`:

- **`concern`** or **`blocker`** — routed through `steer()`, placing the wrapped
  note in the primary agent's steering queue. The note is picked up at the next
  turn boundary when `takeSteer()` drains the queue.
- **`nit`** — appended directly to `primaryMessages` via `appendToPrimary()`.
  The note is picked up on the next model call within the same turn or the next
  turn.

The XML wrapper is:

```xml
<advisory severity="SEVERITY" guidance="weigh, don't blindly obey">
ESCAPED NOTE
</advisory>
```

### Emission guards

The `advise` tool applies three guards to keep the advisor quiet:

1. **Content-free suppression**: a static set of six phrases (`"stop"`,
   `"done"`, `"complete"`, `"no issue continue"`, `"lgtm"`,
   `"nothing to add"`) is matched against the normalised note. If the note is
   just noise, the tool returns `{ content: "Recorded.", isError: false }`
   without delivering anything.
2. **Per-runtime dedupe**: the note is normalised to lowercase, NFKC, with all
   non-alphanumeric runs collapsed to a single space. The resulting key is
   stored in a `Set<string>` on `AdvisoryContext`; a matching key is dropped.
3. **One-note-per-update rate limit**: `AdvisoryContext.notesThisUpdate` starts
   at `0` for each primary turn and is incremented when a note is delivered.
   Any `advise` call after the first in the same update returns
   `"Recorded."` without delivery.

### Read-only enforcement

The advisor is restricted to three tools: `read_file`, `list_directory`, and
`advise`. This is enforced at two levels:

- **Schema level**: `getAdvisorTools()` maps `ADVISOR_ALLOWED_TOOLS` through the
  registry and only returns the schemas for those three names.
- **Execution level**: inside the mini tool-use loop, the runtime checks
  `ADVISOR_ALLOWED_TOOLS.includes(name)` before calling `registry.run`. Any
  other tool name returns an error result.

The `ADVISOR_SYSTEM_PROMPT` reinforces this: the advisor is told it has
read-only access, should verify claims with `read_file` and `list_directory`,
may call `advise` at most once if it spots an issue, and must otherwise do
nothing.

### Mini tool-use loop

The advisor runs a simplified tool loop with a hard limit of three iterations,
controlled by `IterationBudget.create(3)`. It calls `devin.streamChat` with the
advisor model, collects text and tool-call parts, pushes the assistant message
into its local history, executes allowed tools, and pushes tool results back.
If the model returns no tool calls, the loop ends. If it keeps returning tool
calls beyond the budget, the loop stops after the third iteration.

### Error isolation

The entire `onPrimaryTurnEnd` function is wrapped in a try/catch. Any error is
logged with `console.error("Advisor error:", err)` and the function returns.
Advisor failure is never fatal to the primary turn.

### Tool context and registration

`ToolContext` gains an optional field `advisoryContext?: AdvisoryContext` in
`src/tools/registry.ts`. Existing tools never see it; the `advise` tool checks
its presence and returns an error if it is missing. The tool is imported in
`src/tools/index.ts` so it self-registers.

### Configuration

`AppConfig` in `src/config.ts` gains an optional `advisor` object with two
fields:

- `enabled?: boolean`
- `model?: string`

`validateConfig` enforces:

- `advisor` must be an object when present.
- `advisor.enabled` must be a boolean when present.
- `advisor.model` must be a non-empty string without whitespace when present.
- If `advisor.enabled === true` and no model is assigned, validation throws.

`isAdvisorActive(config)` returns `true` only when `advisor.enabled === true`
and `advisor.model` is a non-empty string. `src/oneShot.ts` and
`src/repl/App.tsx` read this helper and spread `{ advisor: { model } }` into
`createAgentSession` only when active. `src/repl/App.tsx` stores the advisor
model in React state, loaded from config on mount, and passes it per submitted
message so each REPL message starts a correctly configured session.

## Consequences

- When `advisor.enabled` is `true` and `advisor.model` is set, a second model
  reviews every completed primary turn. If it has a concern, the primary agent
  sees it as a steer or inline message and can adjust.
- The operator must add `advisor` to `~/.railgun/config.json`, set `enabled` to
  `true`, and provide a valid model name. Disabling the advisor (`enabled: false`)
  requires no model and incurs no runtime cost.
- The advisor cannot write files, run shell commands, or call any mutating tool.
  It can only read files and directories and emit advice.
- The advisor cannot approve anything. Its notes are wrapped with
  `guidance="weigh, don't blindly obey"`; the primary agent is responsible for
  deciding whether to act on them.
- Because `onPrimaryTurnEnd` is awaited, `agent.run()` does not return until the
  advisor finishes. A slow advisor model slows the session.
- The one-note-per-update limit and dedupe keep the advisor from spamming the
  primary conversation or repeating itself.
- The 3-iteration budget caps the advisor's work; it will not recurse
  indefinitely even if the model keeps emitting tool calls.
- Errors inside the advisor are logged but never crash the primary turn. A
  failing advisor is equivalent to a silent one.
- `ToolContext` now carries an optional `advisoryContext`. Tests that construct
  `ToolContext` are unaffected unless they exercise the `advise` tool.
