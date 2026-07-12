# 0011. Run-scoped cancellation and boundary-based input queues

Date: 2026-07-12

## Status

Accepted

## Context

Before Phase 17, the REPL called `runTurn` directly and treated a submitted
turn as indivisible. Ctrl+C exited Ink, input was disabled while the model or a
tool worked, provider cancellation did not reach approvals or tool handlers,
and an approved shell could leave descendants alive. Retaining arbitrary
partial history on interruption also risks violating Devin and SQLite's strict
assistant/tool pairing rules.

Steering and follow-up have different timing requirements. Steering should
influence the next model call without preempting the current response or tool
batch. Follow-up work should begin only after the agent would otherwise stop.

## Decision

`createAgent` owns exactly one `AbortController` per `run` and exposes readonly
`run`, `abort`, `steer`, `followUp`, and `isRunning` operations. Concurrent runs
and queueing while idle are rejected.

- Steering is FIFO and injects one plain-text user message after each complete
  assistant/tool boundary. A tool batch always finishes as a batch first.
- Follow-ups become eligible only at settlement. They are then injected FIFO,
  one per assistant boundary, and continue inside the same run and iteration
  budget. A batch is never appended as consecutive user messages because Devin
  and SQLite both require an assistant response between user messages.
- The signal is passed to Devin streaming, compaction, approval waits, the tool
  registry, and every handler through required `ToolContext.signal`.
- Sequential dispatch stops scheduling work after abort. Parallel calls settle
  together; unfinished calls and required unmatched results become error tool
  messages containing `[stopped by user]`.
- POSIX shell work uses a detached process group. Abort sends `SIGTERM` to the
  group and escalates to `SIGKILL` after two seconds if it has not exited.

An abort returns an explicit outcome rather than a generic error. History keeps
the submitted user message, partial assistant text, completed tool messages and
side effects, and completed todo mutations. Empty assistant boundaries or
stopped tool results are added only where needed to keep the retained prefix
protocol-valid. Interruption notices remain UI metadata, not Devin messages.
Both queues are cleared on settlement; abort reports how many queued messages
were cancelled. The original batch-oriented `takeFollowUps` callback remains a
deprecated compatibility adapter; new integrations consume `takeFollowUp`.

In Ink, the composer remains active during ordinary agent work and Enter queues
steering. Approval remains modal. A queued acknowledgement is temporary; the
normal `YOU` row appears only when injection occurs. Ctrl+C aborts when an
agent or approval target exists and exits otherwise.

## Consequences

- Railgun can cancel a run and accept another prompt in the same session
  without replaying completed work or persisting malformed history.
- Cancellation cannot roll back filesystem, shell, or todo side effects that
  completed before the signal arrived.
- Shell-tree termination is guaranteed only on macOS/Linux; Windows remains
  unsupported for this behavior because Railgun already depends on `bash`.
- Queue callbacks remain narrow Phase 17 integration points. A general typed
  event bus is deferred.
