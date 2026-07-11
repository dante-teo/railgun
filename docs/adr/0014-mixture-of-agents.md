# 0014. Mixture of Agents (MoA) turn pre-processing

Date: 2026-07-12

## Status

Accepted

## Context

Phase 32 implements Hermes's `_REFERENCE_SYSTEM_PROMPT` / `_attach_reference_guidance` strategy: before the acting model decides its next step, several reference models are asked in parallel for advisory analysis of the same conversation state. Their responses are collected and prepended to the aggregator's context as a private guidance message, trading latency and cost for multi-perspective reasoning on hard decisions.

The design must:
- Be opt-in per session and per config (no cost for users who don't enable it).
- Never crash the turn when a reference model fails.
- Keep the aggregator's KV-cache prefix (system prompt + task history + tools) stable across iterations.
- Support one-shot mode as well as the interactive REPL.
- Run all reference calls concurrently to minimize latency.

## Decision

**Fan-out scope:** References run once per user turn (`"user_turn"` strategy), after building the initial `messages` array and before the `while (iterationBudget.consume())` tool loop. The `"per_iteration"` variant (re-running references on every tool round) is deferred — it adds significant cost with unclear benefit for the single-provider case.

**Reference message view:** `buildReferenceMessages` converts the full conversation to a tool-free advisory view. Tool results are folded into the preceding assistant message as `[tool result: ...]` notes (head+tail-truncated at 4000 chars to avoid context blowout). When the conversation ends on an assistant turn, a synthetic user message is appended requesting judgement — this satisfies models that require the conversation to end on a user turn.

**Guidance injection:** The aggregator guidance is appended as `{ role: "user", content: guidance }` — matching Hermes's `_attach_reference_guidance` shape. It is pushed directly with `messages.push` (not `pushMessage`) to avoid emitting spurious `message_start`/`message_end` events for private context.

**Aggregator model:** If the preset specifies a different aggregator model than the session default, `effectiveModel = preset.aggregator.model` is used for all `runStep` calls inside the turn. Compaction continues to use the session's original model — it is an infrastructure concern and mixing in the aggregator model would create an asymmetry without clear benefit.

**Failure resilience:** `runOneReference` catches all errors and returns `{ label, text: "[failed: ...]"}`. Failed references degrade to labelled notes in the guidance; the aggregator still runs. A preset with all references failing produces guidance that reads entirely as failure notes — the aggregator can reason around this.

**Real-time progress events:** `ReferenceCallbacks` (`onStart`/`onEnd`) are passed into `runReferences` and fire around each individual reference call inside the `Promise.all` fan-out, enabling the UI to display per-reference progress as each one starts and completes — not just a post-completion summary.

**Config validation:** `parseMoAPreset` is exported from `src/config.ts` (not `src/agent/moa.ts`) because validation belongs at the config boundary. The `validateConfig` function calls it eagerly so malformed presets fail at load time with the real config file path in the error message. `activeMoaPreset` is cross-validated against `moaPresets` keys to catch typos at load time.

**One-shot mode:** `runOneShot` reads `activeMoaPreset` from config, parses the named preset, and passes it through `AgentDependencies`. MoA events (`moa_reference_start`/`moa_reference_end`/`moa_aggregating`) are printed to stderr, matching the tool-spinner's stdout/stderr contract.

**Concurrency cap:** At most 8 reference models per preset. Enforced at config validation time (`parseMoAPreset` rejects `referenceModels.length > 8`).

## Consequences

- Every MoA turn makes `N + 1` `streamChat` calls (N references + 1 aggregator). Latency is bounded by the slowest reference, not their sum, because they run concurrently. Cost scales linearly with N and with conversation length.
- The guidance user message is permanent in the `messages` array for the rest of the turn's tool loop iterations. If the aggregator calls tools and loops, the guidance is in every subsequent context window. This matches Hermes's behavior and is intentional — the guidance remains relevant throughout the turn.
- The guidance message is not persisted in the session checkpoint. The next turn starts fresh without the prior turn's guidance, which keeps session history clean.
- If a future phase adds `"per_iteration"` fan-out, the `runReferences` call site in `runTurn` is the natural extension point — move it inside the `while` loop and pass fresh messages each iteration.
