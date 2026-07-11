# 0015. Skills system

Date: 2026-07-12

## Status

Accepted

## Context

The agent can already load project context from `.railgun.md` and persistent identity from `~/.railgun/SOUL.md` as free-form text blocks in the system prompt. But there is no structured way to give the agent optional, task-specific instruction sets that:

- the model should know *exist* without always reading all of them,
- the model can load *on demand* when a task matches,
- the user can invoke *directly* from the REPL, bypassing model judgement for explicit workflows.

Adding everything to the system prompt or SOUL.md would inflate context on every turn. A pull-based model — the agent knows what's available, loads what it needs — keeps context small and the agent's judgment in the loop.

## Decision

Add a skills system backed by `~/.railgun/skills/`. Skills are Markdown files with YAML frontmatter. The system has two surfaces: an automatic context surface (the model sees skill names and descriptions, calls `skill_view` to load bodies) and a manual slash-command surface (`/skill:<name>` expands the body directly into the user turn).

**File format.** A skill is either:
- A bare `.md` file anywhere under `~/.railgun/skills/`. Its name defaults to the filename without `.md`.
- A directory containing `SKILL.md`. Its name defaults to the directory name.

In both cases, `name` can be overridden in frontmatter. Three frontmatter fields are recognized:

| Field | Type | Required | Default |
|---|---|---|---|
| `name` | string matching `/^[a-z0-9-]{1,64}$/` | No | inferred from filename/dir |
| `description` | string ≤ 1024 chars | Yes | — |
| `disable-model-invocation` | boolean | No | `false` |

Files that fail validation (missing description, invalid name) are skipped with a `[skills]`-prefixed warning to stderr; they do not abort startup.

**Discovery (`src/skills.ts`).** `discoverSkills(dir)` is synchronous (`readdirSync`): skill discovery runs once at session build time, before any async work begins. The scan is recursive but terminates at directories containing `SKILL.md` — a skill root does not expose its subdirectory contents as further skills. This keeps the structure predictable and avoids accidental nested skill leakage.

`buildSkillIndex` deduplicates by first-loaded-wins (DFS order). Collisions are logged as warnings; the second occurrence is silently dropped.

**System prompt injection.** `formatSkillsForPrompt` renders skills with `disableModelInvocation: false` as `<available_skills>` XML appended to the system prompt at session build time. Skills with `disableModelInvocation: true` are excluded — they are invisible to the model and only reachable via `/skill:<name>`. Description and path strings interpolated into XML attributes are escaped (`&`, `"`, `<`, `>`) to prevent malformed prompt output.

**`skill_view` tool (`src/tools/skillView.ts`).** A new `"skills"`-toolset tool that returns a named skill's full body when called by the model. The tool holds a module-level index set once per session via `setSkillIndex(index)` — called inside `buildSessionCore` immediately after discovery. This pattern (mutable module-level singleton, injected at startup) matches how other tool-adjacent state is handled in the project; it avoids threading the index through every call site.

**`/skill:<name> [args]` slash command (`src/repl/App.tsx`).** Lets the user invoke a skill directly without waiting for the model to call `skill_view`. `expandSkillCommand` returns a discriminated union `{ kind: "expanded"; content: string } | { kind: "error"; message: string } | null` — `null` for non-matching input, `"error"` for unknown names, `"expanded"` for a successful expansion. The expanded content becomes the user message for the normal agent turn; no separate entry point is needed. The discriminated union (rather than a string-prefix check on the content) is the typed contract between the parser and the REPL handler.

**`SKILLS_PATH` (`src/paths.ts`).** `~/.railgun/skills` added to `pathsForHome` and exported as a named constant following the pattern of `EXTENSIONS_PATH`. Missing directory returns an empty index without error.

**`yaml` npm package.** Added as a production dependency for frontmatter parsing. The `yaml` package (v2+) is ESM-compatible, well-maintained, and widely used (50M+ weekly downloads). The frontmatter schema is flat (three fields), so a hand-rolled parser would be tractable but adds maintenance risk for edge cases (quoted strings, multiline values, CRLF). The package is the right tradeoff.

## Consequences

- The agent sees available skills in every session's system prompt and can load any skill's body with a single `skill_view` call. Skills with `disable-model-invocation: true` are completely invisible to the model.
- `/skill:<name>` lets the user force-load any skill (including hidden ones) and hand it directly to the agent as a user message, bypassing model selection. Trailing arguments are appended after the `</skill>` tag.
- Skills are discovered synchronously at session build time. The scan is cheap (small personal directory, not a registry), and synchronous I/O avoids complicating `buildSessionCore`'s async return path. If the skills directory is absent, `ENOENT` is caught and an empty index is returned — no error surface.
- First-loaded-wins dedup means skill load order (DFS, depth-first by directory entry order) determines which wins on name collision. This is predictable and consistent; a warning flags the collision.
- Project-local skills (e.g., `.railgun/skills/`) are not yet supported. The `SKILLS_PATH` constant points only to the global directory. Project-local skill loading, like project-local extensions, is a future phase gated on the trust system.
- The `skill_view` tool is always registered and always enabled (in `ENABLED_TOOLSETS`). When no skills exist the `<available_skills>` block is omitted from the system prompt and the model has no reason to call `skill_view`, but the tool remains available.
- CRLF skill files are supported: `splitFrontmatter` uses a dynamic fence-end offset (4 for LF, 5 for CRLF) rather than a hardcoded 4, so CRLF files produce correct frontmatter without a leading `\n`.
