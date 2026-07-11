# 0010. Context compaction: single merged-message replacement history and synthetic ack pair

Date: 2026-07-11

## Status

Accepted

## Context

Phase 16 (context compression) ports Codex's `codex-rs/core/src/compact.rs`
compaction algorithm into `src/agent/compaction.ts`, closing the gap
ADR-0004 deferred: `recovery.ts`'s `RecoveryAction` gains `compress_and_retry`
for HTTP 413, and a proactive check in `runTurn` compacts history when usage
crosses 90% of the model's context window.

Codex's `build_compacted_history` (`compact.rs:585-596`) replaces history with
one `ResponseItem::Message` per selected user text, followed by one more
message holding the summary — multiple consecutive `role: "user"` items. This
is valid under the Responses API's relaxed sequencing.

Railgun's `sessionStore.ts::validateTranscript` (`src/persistence/sessionStore.ts:189-225`)
enforces strict `user → assistant → tool*` alternation across the whole
persisted history. Multiple consecutive `user` messages, or a persisted
history ending on `user` with no reply, both fail that validator.

## Decision

Two points intentionally diverge from a literal Codex port:

1. **`buildCompactedMessage` merges every selected user text and the summary
   into a single `role: "user"` message**, joined with `"\n\n---\n\n"`
   between texts and the summary appended last behind `SUMMARY_PREFIX`. The
   token-budgeted selection logic (`selectRecentUserTexts`) is otherwise a
   byte-for-byte port of Codex's `collect_user_messages` +
   `build_compacted_history_with_limit` loop; only the on-wire packaging
   (one message vs. many) changes.

2. **The manual `/compact` REPL command appends a fixed synthetic
   `role: "assistant"` acknowledgement message** (`COMPACTION_ACK_MESSAGE`)
   after the compacted summary message, closing the `user → assistant` pair
   `validateTranscript` requires at zero extra API cost. Codex's equivalent
   manual `CompactTask` ends replacement history on the summary's `user`
   message with no paired reply — invalid under Railgun's stricter
   invariant.

   The proactive (mid-turn, usage-triggered) and reactive-413 compaction
   paths never need this: both fire inside `runTurn`'s loop, which always
   issues at least one more real `streamChat` call afterward, supplying a
   genuine assistant reply and closing the pair naturally.

## Consequences

- `validateTranscript` itself is unmodified; every compaction path is
  constrained to already produce output that satisfies it.
- If Railgun's alternation invariant is ever relaxed, both adaptations
  should be revisited to more closely match Codex's actual multi-message
  replacement-history shape (one message per user text, summary appended
  separately).
- No other part of the ported algorithm (token budgeting, truncation
  marker format, the 413 front-trim retry loop, the 90% auto-compact
  threshold) diverges from Codex; this ADR covers only the two persistence-
  driven packaging changes.
