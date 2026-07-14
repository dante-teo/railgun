# 0033. Bounded agent research and verifiable cron completion

Date: 2026-07-14

## Status

Accepted

## Context

Unattended agents could spend their entire iteration budget repeating searches
or identical tool calls, then return a static limit message without producing
the requested artifact. Cron treated any model-level success as job success,
did not verify declared files, and advanced scheduling only on success. A failed
daily job could therefore retry every scheduler tick, while operators had no
durable per-attempt report explaining what happened.

## Decision

All agent turns use an immutable progress reducer. It tracks consecutive tool
categories plus stable call and result fingerprints. Railgun warns after six
consecutive web searches, warns when an identical idempotent call returns the
same result twice, and blocks that call after five completed non-progressing
attempts. Cron additionally closes web search after ten consecutive searches.
Allowed independent calls may still run concurrently, with results restored to
declared call order.

Cron retains a 30-step budget but reserves its final five steps for delivery.
Finalization removes `web_search` while retaining source fetch, file, and
verification tools, and privately instructs the model to use existing evidence,
write every required artifact, verify it, and report unavailable data honestly.
When any agent budget expires, Railgun makes exactly one additional tool-free
synthesis call. The successful outcome carries `stopReason: "iteration_limit"`;
abort during synthesis remains a cancelled outcome, and unrelated synthesis
failure uses the static fallback message.

Cron jobs may declare up to ten unique absolute `requiredOutputs`. Before a run,
Railgun fingerprints each path. Completion requires every declared output to be
a changed, non-empty regular file. Model completion with missing/stale outputs,
an empty final response, or iteration exhaustion is `incomplete`; uncaught
provider/runtime and report-write exceptions are `failed`.

`lastRun` records every scheduled attempt and controls due-time calculation.
`lastSuccess` advances only for `completed` runs; `lastStatus` and `lastError`
record the latest outcome. Legacy non-null `lastRun` values normalize as prior
successful completion. Every attempt writes an atomic Markdown report beneath a
sanitized, hashed per-job directory in `~/.railgun/cron/output/`, retaining the
newest 50 reports.

## Consequences

- Search and repeated-call loops consume a bounded portion of the run while
  leaving time for synthesis and artifact delivery.
- Iteration-limited text remains deliverable, but callers and cron can
  distinguish it from normal completion.
- Cron success is an observable artifact contract rather than a model claim.
- Incomplete and failed jobs wait for their next scheduled window instead of
  retrying every minute.
- Operators gain a durable audit report for completed, incomplete, and failed
  attempts; inability to persist that report is itself a failed run.
- Existing jobs remain valid and may omit `requiredOutputs`.
