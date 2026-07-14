# 0035. Desktop settings and authentication boundary

Date: 2026-07-15

## Status

Accepted

## Context

Desktop Settings must edit a small supported subset of Railgun configuration
without giving the sandboxed renderer access to the full configuration file,
unknown future keys, credentials, OAuth URLs, helper output, or process APIs.
Browser OAuth is interactive and can outlive a renderer route, while successful
credential changes require a backend restart. A task starting during that
interval would be terminated by the restart.

## Decision

- Preload exposes only validated `getSettings`, `updateSettings`,
  `signInDevin`, and `signOutDevin` operations. Settings snapshots contain the
  supported model, timeout, agent, trust, provider-status, and bounded redacted
  diagnostics fields; raw configuration and secrets remain in main/backend.
- Section saves send strict `config_update` patches through RPC. The existing
  validated atomic writer preserves unknown top-level keys. Settings and Task
  control mutations share one main-process queue.
- Main launches `railgun login` or `railgun logout` as a supervised helper using
  development or packaged runtime paths. Stdout and stderr are consumed only in
  main and never cross IPC. Failure retains the existing backend; success
  restarts it; app shutdown terminates an outstanding helper.
- One authentication coordinator owns the complete interval from helper launch
  through backend readiness. It rejects concurrent authentication and blocks
  prompts, session changes, backend restart, model changes, agent controls, and
  compaction for that interval. Authentication itself is rejected while an
  agent is running.
- `DEVIN_TOKEN` remains process-local and takes precedence over cached
  credentials. Cached logout cannot disable an environment-managed credential.
- The renderer refreshes Settings when backend phase, mock scenario, or agent
  run state changes. Sequence checks discard stale responses and refreshes do
  not overwrite dirty drafts.

## Consequences

- Settings can evolve only by extending the shared strict schemas and fixed
  preload API; it cannot become a generic configuration editor.
- Authentication does not change RPC v1 and cannot expose browser or helper
  internals to renderer code.
- A browser sign-in may temporarily reject Task actions even after the user
  navigates back to Task, preventing a later credential restart from killing
  newly started work.
- Packaged authentication depends on the bundled CLI and Electron's retained
  `RunAsNode` fuse, matching the packaged backend runtime decision.
