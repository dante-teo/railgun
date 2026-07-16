# 0038. Task-session archiving and Dream-based retention

Date: 2026-07-16

## Status

Accepted

## Context

Long-lived desktop task history makes active navigation noisy, but immediate
deletion removes useful context and is difficult to recover from. Railgun
already has a durable SQLite session store and Dream is a periodic maintenance
operation available from the desktop, CLI, and the hidden midnight daemon job.

## Decision

- Add nullable `sessions.archived_at` metadata, indexed by archive time. Active
  listings exclude archived rows; archived listings are newest-first by archive
  timestamp.
- Archive and restore are reversible state transitions. Archiving the active
  desktop task activates a fresh unsaved task. Archived sessions cannot be
  loaded or forked until restored.
- Add `archiveRetentionDays` to persisted configuration. The only accepted
  values are 1, 7, 30, and 90 days; the default is 7.
- Every started CLI or RPC Dream invocation runs archive pruning in a `finally`
  path, including skipped and failed Dreams. An archive expires when its archive
  timestamp is at or before `now - archiveRetentionDays`; deleting its session
  uses SQLite foreign-key cascading to delete associated messages.
- Desktop exposes archive, archived-list, and restore operations through fixed
  validated IPC/preload contracts. Settings owns retention selection, archived
  search, and restore; the task sidebar owns the archive affordance.

## Consequences

- Archiving declutters active history without a confirmation step, but it is
  only reversible before the next qualifying Dream cleanup after expiry.
- Retention cleanup is event-driven rather than a continuously running delete
  timer. An expired archive remains visible until a Dream begins and finalizes.
- The existing 500-session desktop summary limit bounds both active and
  archived lists independently.
- The archive timestamp is durable metadata; no duplicate message storage or
  separate archive database is introduced.
