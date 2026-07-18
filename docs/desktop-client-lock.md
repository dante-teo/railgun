# Shared desktop-client lock

RailgunX and Railgun Classic use the same `~/.railgun` data in place. Only one
interactive desktop client may use it at a time. This document defines the
on-disk protocol that both clients must preserve.

## Lock record

The owner atomically creates `~/.railgun/desktop-client.lock` with exclusive
creation and owner-only permissions. Its JSON object requires these fields:

```json
{
  "pid": 12345,
  "bundleId": "io.anvia.railgun",
  "clientName": "RailgunX",
  "startTime": "2026-07-18T12:00:00Z"
}
```

`pid` is a positive process ID. `bundleId`, `clientName`, and `startTime` must
be non-empty strings; clients emit `startTime` as an ISO-8601 timestamp.
RailgunX identifies itself as `io.anvia.railgun` / `RailgunX`; Classic uses
`sh.railgun.desktop` / `Railgun Classic`.

Acquire this lock before starting an interactive backend. Keep it until backend
shutdown and remove it only when the file still contains the exact record that
the current process created. This prevents a stale owner from deleting a newer
client's lock.

## Conflict and recovery rules

If exclusive creation reports an existing lock, parse and validate its record.
The owner is live when a signal-zero process check succeeds or access is denied
with `EPERM`; show the conflict UI and do not start a second backend.

Only a valid record whose PID is demonstrably absent may be recovered. Recovery
uses the transient `desktop-client.lock.recovery` file, containing the same
record shape, to serialize stale-lock removal between clients. A live recovery
guard is a conflict; a stale valid guard can be recovered. Malformed or
incomplete lock and recovery files are never removed automatically because they
cannot be proved stale; present the safe unavailable/conflict state instead.

Mock, preview, and test runs use isolated temporary homes and must not acquire
the user's real lock.
