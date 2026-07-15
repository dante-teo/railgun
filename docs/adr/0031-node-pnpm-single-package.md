# 0031. Node and pnpm package boundary

Date: 2026-07-13

## Status

Accepted (amended for DESK-001)

## Context

Railgun's maintained interfaces all run through the same local agent core:
the Ink terminal REPL, one-shot CLI output, JSONL RPC over stdio, and ACP over
stdio. Keeping additional runtime or package boundaries without a maintained
interface increases dependency, build, test, and documentation cost without
improving those workflows.

## Decision

Maintain the publishable Railgun CLI as the root Node.js package and add one
private Electron package at `apps/desktop`. Use the pinned pnpm version for
installation, script execution, dependency resolution, and the sole lockfile.
The desktop main process communicates with the unchanged root CLI RPC surface
over JSONL stdio; it does not import CLI internals into the renderer.

Development launches the root CLI through the workspace toolchain. Forge
packages a production-only deployment of the compiled root CLI and a bundled
mock backend as application resources, then launches them with Electron's
embedded Node runtime. A packaged desktop app therefore does not require the
repository checkout or a separately installed pnpm/Node.js runtime.

The production deployment has its own `node_modules` tree under Forge's extra
resources, outside the application dependency tree handled by Forge's automatic
native-module rebuild. After deployment, the desktop build therefore rebuilds
`better-sqlite3` explicitly for the installed Electron version and current
architecture, then opens an in-memory database with Electron in Node mode. A
native ABI mismatch fails staging before signing or publication.

`pnpm-workspace.yaml` declares private applications and retains repository-wide
pnpm policy. Forge's Electron rebuild dependency is overridden to the
registry-hosted rebuild 4 line so the default exotic-transitive-dependency
guard remains enabled. The workspace uses the hoisted node linker for Forge's
packaging preflight and injects workspace packages so `pnpm deploy --prod` can
assemble a self-contained CLI deployment.

## Consequences

- CLI source and tests remain under `src/`; desktop source and tests live under
  `apps/desktop/src/` with a desktop-local TypeScript/Vite toolchain.
- `pnpm-lock.yaml` contains the root CLI and private desktop importers.
- The supported runtime is Node.js 22.19.0 or newer.
- The root package's published files, CLI scripts, binary, and package metadata
  remain independent of the private workspace.
- Desktop builds go through Forge so its Vite runtime constants and production
  renderer paths are generated consistently; the deployed backend is a Forge
  resource rather than part of the root package's published files.
- Each desktop artifact is staged on a runner matching its target architecture;
  the explicit backend rebuild and smoke test therefore validate the same
  architecture that Forge packages.
- Forge packaging keeps dependency pruning disabled. Pruning a hoisted
  workspace can remove desktop development dependencies from the shared
  installation, and it is unnecessary because the Vite plugin already includes
  only bundled application output in the ASAR.
- Additional runtime or package boundaries require an explicit architecture
  decision and an actively maintained user workflow.
