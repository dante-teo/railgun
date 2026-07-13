# 0031. Node and pnpm single-package boundary

Date: 2026-07-13

## Status

Accepted

## Context

Railgun's maintained interfaces all run through the same local agent core:
the Ink terminal REPL, one-shot CLI output, JSONL RPC over stdio, and ACP over
stdio. Keeping additional runtime or package boundaries without a maintained
interface increases dependency, build, test, and documentation cost without
improving those workflows.

## Decision

Maintain Railgun as one Node.js package described by the root `package.json`.
Use the pinned pnpm version for installation, script execution, dependency
resolution, and the sole lockfile. Keep supported user-facing processes local
and terminal- or stdio-based.

`pnpm-workspace.yaml` remains only for repository-wide pnpm policy: approved
native dependency builds and the explicit supply-chain age exception. It does
not declare additional packages.

## Consequences

- Source code and tests live under `src/` and share one TypeScript toolchain.
- `pnpm-lock.yaml` contains one importer.
- The supported runtime is Node.js 22.19.0 or newer.
- New runtime or package boundaries require a new explicit architecture
  decision and an actively maintained user workflow.
