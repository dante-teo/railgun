# 0037. Raise IPC frame and buffer ceiling

## Status

Accepted

## Context

ADR 0032 set `maxFrameLength` to 64 KiB and `maxBufferLength` to 128 KiB in
`BackendSupervisor`. These limits were chosen conservatively for the initial
desktop RPC surface, which handled only small JSON commands and short agent
events.

In practice, several workloads now produce frames that legitimately exceed those
limits: large tool-call results, long transcript pages, and provider payloads
from extended sessions. The supervisor was silently truncating or rejecting
frames rather than surfacing a recoverable error, causing data loss that was
hard to diagnose.

## Decision

Raise the defaults in `BackendSupervisor`:

| Parameter         | Before   | After  |
|-------------------|----------|--------|
| `maxFrameLength`  | 64 KiB   | 4 MiB  |
| `maxBufferLength` | 128 KiB  | 8 MiB  |

Both values remain configurable via the `options` argument so tests can
exercise boundary conditions without allocating large buffers.

The 8,000-character cron prompt cap (ADR 0032) is intentionally preserved. It
is a product-level guard against user input, not a transport constraint, and
remains valid regardless of the frame ceiling.

## Consequences

Large frames that were previously truncated now pass through intact. The
supervisor still bounds buffers — unbounded growth is not possible — but the
ceiling is high enough that no realistic RPC payload should reach it in normal
operation. Memory overhead per live backend child increases by at most ~8 MiB
in the pathological case of a maximal partially-delivered frame.
