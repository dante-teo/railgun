# Shared desktop-client lock

Railgun uses one interactive backend for its shared `~/.railgun` data at a time. Production source
launches and the packaged Electron application use the same on-disk exclusion protocol.

## Lock record

The Electron main process atomically creates `~/.railgun/desktop-client.lock` with exclusive
creation and owner-only permissions:

```json
{
  "pid": 12345,
  "bundleId": "io.anvia.railgun",
  "clientName": "Railgun",
  "startTime": "2026-07-18T12:00:00Z"
}
```

`pid` is the Electron main-process ID that owns the backend lifecycle. The remaining fields are
non-empty strings and `startTime` is ISO-8601. Acquire the lock before spawning
`railgun-backend desktop`, keep it through initialization and the complete child-process lifetime,
and remove it only if the file still contains the exact record this process created.

## Conflict and recovery

If exclusive creation reports an existing lock, parse and validate it. An owner is live when a
signal-zero process check succeeds or reports `EPERM`; report the conflict and do not start another
backend.

Only a valid record whose PID is demonstrably absent may be recovered. Recovery uses
`desktop-client.lock.recovery` with the same record shape to serialize stale-lock removal. A live
recovery guard is a conflict; a stale valid guard may be recovered. Malformed or incomplete lock
and recovery files are never deleted automatically because they cannot be proved stale.

## Launch paths

| Launch path                   | Backend and data                                   | Shared lock    |
| ----------------------------- | -------------------------------------------------- | -------------- |
| Packaged `Railgun.app`        | Embedded production backend using `~/.railgun`     | Required       |
| `scripts/run.sh`              | Source-built production backend using `~/.railgun` | Required       |
| `scripts/run-mock.sh`         | Deterministic in-memory fixture backend            | Exempt         |
| `pnpm --dir apps/desktop dev` | Electron shell without a configured backend        | Not applicable |

Temporary-directory lock tests never acquire the user's real lock.
