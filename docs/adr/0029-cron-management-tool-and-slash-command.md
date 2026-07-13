# 0029. Cron job management: agent tool and /cron slash command

Date: 2026-07-13

## Status

Accepted

## Context

The cron subsystem (`src/cron/`) can persist and run scheduled agent tasks, but jobs can only be created by manually editing `~/.railgun/cron/jobs.json`. Two in-session management surfaces were needed: one so the LLM can manage jobs on the user's behalf with natural language, and one so the user can manage jobs directly from the REPL without going through the agent.

## Decision

### `cron` agent tool (`src/tools/cron.ts`)

Single tool registered under the `"cron"` toolset with a single `action` discriminator (`list`, `add`, `remove`, `update`). Calls `loadJobs`/`saveJobs`/`validateJob` from `src/cron/jobs.ts` directly — no new persistence layer. `CronJobsError` (schedule parse failures, validation errors) is caught and returned as `{ isError: true, content: error.message }` without re-throwing, so the LLM receives a human-readable error it can act on.

Added to both `ENABLED_TOOLSETS` in `src/agent/turn.ts` (root agent) and `LEAF_TOOLSETS` in `src/tools/delegate.ts` (subagents), so delegated subagents can also manage cron jobs.

One tool with an `action` discriminator rather than four separate tools matches the `todo` tool's single-entry pattern and keeps the toolset surface small.

### `/cron` REPL slash command (`src/repl/App.tsx`)

Three subcommands handled before agent dispatch:

- Bare `/cron` — calls `loadJobs()` and lists all jobs as `[id] schedule — prompt` lines.
- `/cron add <id> <f1> <f2> <f3> <f4> <f5> <...prompt>` — parses the id, consumes the next 5 whitespace-delimited tokens as the cron expression, takes the remainder as the prompt. Validates via `validateJob`, rejects duplicate ids.
- `/cron remove <id>` — filters the job out and writes back.

`/cron update` is intentionally omitted from the slash command — updating a schedule or prompt is complex enough to warrant natural language through the agent tool.

The handler wraps all `await` calls in `setBusy(true)` / `finally { setBusy(false) }`, consistent with `/dream` and `/branch`, preventing concurrent command submissions during async I/O.

### Shared `extractString` helper (`src/tools/args.ts`)

The `extractString(args, key)` helper was copy-pasted into four tool files (`memory.ts`, `noteSearch.ts`, `noteSearchSemantic.ts`, and the new `cron.ts`). Extracted to `src/tools/args.ts` and imported by all four. No behavioral change — the implementations were identical.

### Vitest workspace config (`vitest.config.ts`)

Running `npx vitest run` from the repo root discovered `apps/desktop/gateway/wsServer.test.ts` but processed it without the `@railgun/core → ../../src` path alias defined in `apps/desktop/vite.config.ts`, causing a module-not-found failure. Added `vitest.config.ts` at the repo root using vitest 4's `projects` array (replacing the removed `defineWorkspace` API), with two entries: an inline `core` project covering `src/**/*.test.ts` and a reference to `apps/desktop/vite.config.ts` that carries the alias.

## Consequences

- Jobs previously required direct file editing; they can now be managed from within a session via the agent or the slash command.
- The slash command does not support `update` — users who need to update an existing job's schedule or prompt must use the agent tool or edit the file directly.
- `"cron"` in `LEAF_TOOLSETS` means subagents spawned via `delegate_task` can manage cron jobs. This is intentional (no security concern since the tool only touches the user's own job file) but can be removed from `LEAF_TOOLSETS` without affecting the root agent if undesirable.
- The 5-token fixed cron parse in the slash command works naturally for unquoted expressions (`0 9 * * *`). Quoted expressions are not supported in the slash command — use the agent tool for those.
