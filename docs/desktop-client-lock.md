# Shared desktop-client lock

Railgun uses one interactive backend for its shared `~/.railgun` data at a
time. The native app and the production Electron development shell implement
the same on-disk exclusion protocol.

## Lock record

The owner atomically creates `~/.railgun/desktop-client.lock` with exclusive
creation and owner-only permissions. Its JSON object requires these fields:

```json
{
  "pid": 12345,
  "bundleId": "io.anvia.railgun",
  "clientName": "Railgun",
  "startTime": "2026-07-18T12:00:00Z"
}
```

`pid` is a positive process ID. `bundleId`, `clientName`, and `startTime` must
be non-empty strings; clients emit `startTime` as an ISO-8601 timestamp.
Railgun identifies itself as `io.anvia.railgun` / `Railgun`. The PID belongs to
the desktop process that owns the backend lifecycle—the native app or Electron
main process—not to the backend child.

Acquire this lock before starting an interactive backend. Keep it until backend
shutdown and remove it only when the file still contains the exact record that
the current process created. This prevents a stale owner from deleting a newer
client's lock.

## Conflict and recovery rules

If exclusive creation reports an existing lock, parse and validate its record.
The owner is live when a signal-zero process check succeeds or access is denied
with `EPERM`; report the conflict and do not start a second backend.

Only a valid record whose PID is demonstrably absent may be recovered. Recovery
uses the transient `desktop-client.lock.recovery` file, containing the same
record shape, to serialize stale-lock removal between clients. A live recovery
guard is a conflict; a stale valid guard can be recovered. Malformed or
incomplete lock and recovery files are never removed automatically because they
cannot be proved stale; present the safe unavailable/conflict state instead.

## Client participation

| Launch path                   | Backend and data                                   | Shared lock    |
| ----------------------------- | -------------------------------------------------- | -------------- |
| Native bundled or source mode | Production backend using `~/.railgun`              | Required       |
| `scripts/run.sh`              | Source-built production backend using `~/.railgun` | Required       |
| `scripts/run-mock.sh`         | Deterministic in-memory fixture backend            | Exempt         |
| `pnpm --dir apps/desktop dev` | Electron shell without a backend                   | Not applicable |

Electron acquires the lock before spawning `railgun-backend desktop` and keeps
it through initialization and the complete child-process lifetime. It releases
its exact record after normal shutdown, launch failure, or unexpected child
termination. Mock mode never receives a lock directory and cannot block a real
desktop client.

Native previews and tests use isolated temporary homes. Electron lock tests use
temporary directories; neither test path acquires the user's real lock.
