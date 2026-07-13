# Design

## Product experience

Railgun's interactive surface is a dense, full-screen terminal workspace. A
compact branded header anchors a repaintable transcript; sticky todos,
suggestions or approval, the composer, and a slim status bar stay visible at
the bottom. One-shot output, authentication/config commands, and `--list-sessions`
remain ordinary terminal text.

## Appearance

Railgun owns two internal semantic palettes, mint-dark and mint-light. It asks
the terminal for its canvas appearance first, then the OS, then defaults to
dark. Terminal changes apply immediately; OS changes re-query the terminal
before applying the OS value. There is no manual appearance override or
`/skin` command.

The UI never paints a global background, preserving the terminal canvas.
Tinted user, selection, status, approval, todo, tool, and code surfaces always
set an explicit foreground. Text labels and glyphs (`YOU`, `RAILGUN`, `ERROR`,
`APPROVAL`, `[x]`, `✔`, `✘`) preserve meaning independently of color.

## Interaction

`/settings` provides keyboard-driven AI configuration for the primary model,
the persisted MOA default, and the advisor. Selection interfaces share an
immutable reducer and use Up/Down, Enter, and Escape. Their scroll window is
initialized around the current selection and follows wrapping navigation.
Trust decisions, clarification choices, bare `/moa`, and bare `/branch` follow
the same model; text entry is reserved for free-form answers and preset names.

- Enter submits; Shift+Enter inserts a newline when enhanced keyboard reporting
  is available. The composer grows from one to six rows and caps lower in short
  terminals. Paste may contain multiple lines.
- Tab completes an active slash suggestion. Otherwise it is consumed as the
  reserved future enqueue binding. The composer remains editable during
  ordinary model/tool work; Enter queues steering for the next completed
  assistant/tool boundary, with a temporary acknowledgement until its `YOU`
  row is injected in chronological order. Shell approval and model selection
  remain modal. `Ctrl+U` clears the draft.
- The mouse wheel scrolls transcript history by rows. PageUp/PageDown move by
  one viewport. Home/End jump to the beginning/end. New output and resizes
  preserve bottom-follow only when already at the bottom; otherwise an
  unseen-row cue reserves one visible transcript row.
  - `/exit`, `/help`, `/clear`, `/model`, `/settings`, `/compact`, `/rollback`, `/moa`, `/trust`, `/branch [--summary] [id]`, and `/fork` are the available commands. `/cron [add <id> <schedule> <prompt> | remove <id>]` lists, creates, and removes scheduled jobs; `schedule` is a 5-field cron expression. `/moa <preset-name>` activates a named preset for subsequent turns and `/moa off` deactivates it; bare `/moa` opens a session-only picker containing Off and every configured preset. The active preset name appears in the status bar. Bare `/branch` opens an arrow-key picker of recent messages, while `/branch [--summary] <id>` remains available for direct selection. `/trust` opens an arrow-key picker for persisted or session-only trust/deny decisions. `/fork` copies the active branch into a new session, and `/rollback` restores the pre-mutation shadow-git snapshot. Shell approval remains a `y`/`n`/Escape confirmation rather than a list selection.

- Advisor notes are visually separate from user turns. The REPL parses their
  internal advisory envelope and renders an `ADVISOR` role with severity-specific
  foreground and background colors: green for `nit`, amber for `concern`, and
  red for `blocker`. The advisor can steer at most once per user request; silent
  reviews preserve that allowance, while any delivered severity consumes it.
  Internal advisory prompts are normalized out of returned history before
  checkpointing; the assistant response produced after a steer is merged with
  the preceding assistant message to preserve a valid transcript.
  Clarify prompts with choices use Up/Down and Enter, while prompts without
  choices retain free-form text entry. Escape declines either form. During
  choice mode the composer unfocuses so selection input reaches only the
  clarify handler. Both modes show an `❓` prompt box above the composer.
- Completed replies use GFM Markdown with wrapped prose, lists, links, tables,
  and themed fenced-code boxes with language labels. Streaming fragments remain
  plain until completion.
- Generic thinking and live tool states use animated mint activity rows — one
  row per in-flight tool call, so a concurrent batch renders as that many
  simultaneous rows rather than a single collapsed count. Agent
  narration is committed before a following compact tool row, preserving the
  chronological event sequence instead of pinning active text below tools.
  Short transcript slices bottom-align against the composer; full pages remain
  top-aligned for stable scrolling.

## UI states

Seven observable states drive the visual treatment of the transcript and composer area.

| State | Treatment |
|---|---|
| Empty session (no messages) | Header with `RAILGUN · adaptive agent console` and the status bar are visible. The transcript area is empty; short content bottom-aligns against the composer (existing behavior in `transcriptJustification`). No placeholder text — the composer's prompt is invitation enough. |
| Waiting for first token | An animated `dots2` spinner row with `theme.dim` styling and "Thinking…" label. Uses the existing `ink-spinner` in the Ink REPL; the Phase 36 non-Ink tree uses `theme.thinkingIndicator()`. |
| Tool awaiting approval | A `theme.warning`-surface inline row with the command text and `y/n` prompt. The composer freezes (input disabled) until the approval resolves. Not a native OS dialog. Existing behavior in `App.tsx`'s approval modal state. |
| Clarify question with choices | An `❓` prompt box above the composer. Up/Down moves the highlight, Enter selects it, and Escape declines with `[user declined to answer]`. Numeric shortcuts and free-form entry are disabled while choices are displayed. |
| Connection lost (stdio pipe closes) | A `theme.error`-styled inline transcript line (`"Connection lost"`). The composer remains editable but submissions fail until the agent process is restarted. In RPC mode, the client detects EOF on the child's stdout. |
| Error from model/API | A red (`theme.error`) transcript row with role label `ERROR`. The raw error is mapped through `src/errors.ts` to a one-line human message. The composer returns to interactive state. Existing behavior. |
| Long tool output / long reply | Tool output is collapsed to a one-line label (`toolCallLabel`). Completed assistant replies render as Markdown; streaming fragments are plain text. No explicit truncation of assistant replies — the viewport scrolls. |

## Lifecycle and accessibility

Interactive TTY sessions and the resume/model choosers enter the alternate
screen and restore it on every exit path. Non-TTY output and
`INK_SCREEN_READER=true` skip the alternate screen. The screen-reader path uses
Ink's accessible rendering; all controls remain keyboard-only and all status
meaning has a textual cue.

Ctrl+C cancels an active agent, shell approval, or clarify prompt rather than exiting. Cancellation retains streamed assistant text and completed tools/todos, displays the stop as UI metadata, and returns to the same session. Cancelling a clarify prompt resolves it with `[user declined to answer]` and aborts the agent turn. With no cancellable target, Ctrl+C exits normally. Shell approval freezes composer input; approved POSIX shell work is terminated as a process group on cancellation.

## Session chooser

The chooser shares the live automatic theme, header, selected surface, compact
metadata, and status bar. Up/Down wraps, Enter resumes, and Escape/Ctrl-C
cancels. Its newest-first list viewport tracks selection across terminal
resizes. Input state advances synchronously, so rapid navigation followed by
Enter confirms the latest highlight even before React repaints it.

## Configuration and model recovery

`~/.railgun/config.json` is active as the single configuration source. Its
effective defaults include `{ "model": null, "defaultProjectTrust": "ask",
"operationTimeoutMs": 600000 }`: fresh REPL and one-shot sessions use Devin's
first returned model, and each non-interactive asynchronous operation has a
ten-minute deadline. `railgun config` renders the recursively merged,
pretty JSON without crossing authentication, SQLite, file-creation, or TUI
boundaries. Unknown fields remain visible and preserved; invalid configuration
fails in place rather than being repaired.

`operationTimeoutMs` must be a positive integer and applies independently to
provider work, tools, extension hooks, event listeners, compaction, advisor and
delegated-model work. Approval and clarification prompts have no automatic
deadline, but settle when the run is cancelled. A timeout aborts the scoped
operation signal; late events from a provider that ignores cancellation are
discarded. Shell cancellation terminates the process group with `SIGTERM`, then
`SIGKILL` after two seconds if necessary. These guards bound asynchronous work;
synchronous extension code that blocks Node's thread requires worker or process
isolation and cannot be preempted by an `AbortSignal`.

The optional `mcpServers` object configures MCP (Model Context Protocol) servers.
Each key is a server name; each value is `{ command: string, args?: string[],
env?: Record<string, string> }`. Railgun spawns each configured server at
session startup (stdio transport only), discovers its tools, and registers them
as `mcp__<server>__<tool>` in the tool registry. One failing server logs an error
but does not block startup. Example:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

The optional `defaultProjectTrust` field controls the project trust gate:
`"ask"` (default) prompts interactively before each new untrusted project's
first session; `"always"` trusts every project without prompting; `"never"`
denies every project without prompting. Per-project decisions are persisted
in `~/.railgun/trust.json`; `--approve`/`-a` and `--no-approve`/`-na`
override for a single invocation.

The optional `moaPresets` key defines named Mixture of Agents presets, each with a `referenceModels` array (up to 8 entries, each `{model, temperature?}`), an `aggregator` `{model, temperature?}`, and an optional positive `referenceMaxTokens`. The optional `activeMoaPreset` key names the default preset for both one-shot and interactive REPL sessions; `/moa` can override it for the current REPL session. Preset validation at config load time rejects missing required fields, non-positive token caps, and `activeMoaPreset` pointing to an unknown preset name. Unknown extra keys inside a preset are preserved (forward-compatible).

A configured string requests that exact model for fresh sessions. When it is
missing, interactive TTY launches show a model chooser using the resume
chooser's theme, lifecycle, wrapping navigation, and resize-aware viewport.
Rows lead with the model name and follow with ID and capabilities. Enter saves
the replacement atomically before session construction; Escape/Ctrl-C leaves
the file unchanged and exits successfully. Non-interactive launches fail with
the missing and available IDs plus interactive recovery instructions. Resumes
remain pinned to their stored model because changing it would alter conversation
semantics. Proactive/general model switching remains Phase 15.

## Authentication and recovery

`login` and `logout` are startup subcommands, not in-REPL slash commands. They
produce short plain-text status or warning lines and never enter the alternate
screen. `login` always opens fresh browser OAuth, keeps the previous cache until
OAuth returns a replacement, and verifies the replacement through model
discovery. `logout` removes only the cached credential and succeeds even when
no cache exists.

A trimmed nonempty `DEVIN_TOKEN` is process-local and takes precedence over the
cache. Login warns that it will override the newly saved credential; logout
warns that authentication remains active. Token contents never appear in
status, warning, or error text.

Credential rejection is source-specific. A rejected cached credential is
removed and the user is directed to `railgun login`; a rejected environment
credential is left alone and the user is directed to update or unset
`DEVIN_TOKEN`. In the REPL, either failure becomes a red transcript line while
the composer returns to an interactive state. The failed message and any tool
calls are never replayed automatically. After file-backed login succeeds in
another terminal, the user manually resubmits the message in the still-open
REPL.

## Context compaction

Two triggers summarize and shrink conversation history into a single
compacted message: automatic (checked after every turn step once
input+output token usage reaches 90% of the model's context window) and
manual (`/compact`, on demand). Both share the same underlying
summarization call and produce the same on-wire shape — recent user turns
plus an LLM-generated handoff summary, joined into one `role: "user"`
message — so the REPL shows the identical confirmation line,
`Compacted conversation history to stay under the context limit.`, either
way. `/compact` additionally appends a synthetic assistant
acknowledgement to close the conversation's `user → assistant` pairing
before checkpointing; the automatic path never needs this because the
turn's loop always issues at least one more real reply afterward. A
too-large request (HTTP 413) triggers the same compaction reactively and
retries, invisibly to the user unless compaction itself is exhausted
after 3 attempts, in which case the turn fails with a normal red
transcript error line.

## Desktop app

The desktop app (`apps/desktop/`) is a browser-based surface that exposes the same agent features as the Ink REPL. It is not a port — it is a separate renderer that consumes the same `AgentSession` event stream via a WebSocket gateway.

### Visual identity

The mint palette is unchanged. `apps/desktop/renderer/styles/tokens.css` mirrors every field in `src/ui/palette.ts` 1:1 for dark and light themes, plus one CSS-only token:

| CSS variable | Dark | Light | `Palette` field |
|---|---|---|---|
| `--color-accent` | `#5EE6B8` | `#087F5B` | `accent` |
| `--color-strong` | `#35D6A0` | `#056548` | `strong` |
| `--color-text` | `#E6FFF7` | `#163C31` | `text` |
| `--color-muted` | `#A6C9BD` | `#486D61` | `muted` |
| `--color-dim` | `#78988E` | `#67877D` | `dim` |
| `--color-border` | `#3F6F60` | `#8ABDAC` | `border` |
| `--color-surface` | `#14362C` | `#E7F7F1` | `surface` |
| `--color-selection` | `#1E5A47` | `#C9F1E3` | `selection` |
| `--color-success` | `#52D89C` | `#087A52` | `success` |
| `--color-warning` | `#F4C95D` | `#8A5A00` | `warning` |
| `--color-error` | `#FF7B86` | `#B42335` | `error` |
| `--color-success-surface` | `#123C2B` | `#DDF5E9` | `successSurface` |
| `--color-warning-surface` | `#3E341A` | `#FFF3CC` | `warningSurface` |
| `--color-error-surface` | `#421F26` | `#FDE2E5` | `errorSurface` |
| `--color-status-surface` | `#153B30` | `#DDF3EA` | `statusSurface` |
| `--color-code-surface` | `#102D26` | `#EAF5F1` | `codeSurface` |
| `--color-page-bg` | `#0A1F18` | `#F0F9F5` | CSS-only (no `Palette` counterpart) |

Additional tokens: `--font-mono`, `--font-sans`, `--radius-sm/md/lg`, `--spacing-xs/sm/md/lg`, and `--transition-theme` (`color 120ms ease, background-color 120ms ease, border-color 120ms ease`). The transition fires on every `--color-*` property so dark↔light flips are smooth with no additional CSS.

`apps/desktop/renderer/styles/layout.css` provides all structural classes (app shell, transcript, composer, status bar, message bubbles, tool-call rows, todo panel, overlays, slash suggestions, skeleton loading). `apps/desktop/renderer/styles/markdown.css` scopes Markdown typography inside `.message--assistant .message__body`.

The page background (`--color-page-bg`, darker than `--color-surface`) provides depth; surface tokens are used for message cards and panels, not the canvas. The layout is three zones stacked in a flex column: a fixed 48 px header with the `RAILGUN` wordmark in accent mint, a scrollable transcript, and a bottom stack (todo panel → overlay zone → composer → status bar).

### Theme switching

`apps/desktop/renderer/lib/theme.ts` drives OS-preference detection and application:

- `getInitialTheme(): ThemeMode` — reads `matchMedia('(prefers-color-scheme: dark)')` synchronously; call once before first paint.
- `applyTheme(mode: ThemeMode): void` — **dark is the CSS default** (`:root` block). For dark, removes the `data-theme` attribute; for light, sets `data-theme="light"` on `<html>`, activating the `[data-theme="light"]` override block.
- `subscribeThemeChanges(callback): () => void` — wires a `change` listener on the same `MediaQueryList`; returns the cleanup function for `useEffect` teardown.

`main.tsx` calls all three at startup: `applyTheme(getInitialTheme())` before the React root is created, then `subscribeThemeChanges(applyTheme)` to keep the page in sync with OS changes. There is no manual toggle in Sprint 1.

### Interaction parity with the TUI

The composer mirrors the TUI's key bindings: Enter submits, Shift+Enter inserts a newline, Tab cycles slash-command suggestions, Escape clears the completion or draft, Ctrl+U clears the draft, Ctrl+C aborts. The textarea grows from 1 to 6 rows (the same cap as the TUI). Slash-command suggestions appear as an inline dropdown above the composer, driven by the same `findMatches`/`nextCompletionState` logic from `src/commands.ts`.

#### `useComposer` hook

`apps/desktop/renderer/hooks/useComposer.ts` manages all composer state and returns a `ComposerState` object:

| Field | Type | Purpose |
|---|---|---|
| `draft` | `string` | Current textarea value |
| `completionIndex` | `number \| null` | Index into the frozen completion list; `null` when no Tab cycle is active |
| `completionMatches` | `readonly string[]` | Frozen match list locked in by `handleTab`; distinct from `liveMatches` |
| `liveMatches` | `readonly string[]` | Dynamic matches computed from `draft` when it starts with `/` and has no space |
| `setDraft(value)` | `void` | Updates `draft` and clears any active completion state |
| `handleTab()` | `void` | Advances Tab-completion via `nextCompletionState` |
| `handleEscape()` | `void` | Clears active completion if present; otherwise clears `draft` |
| `handleCtrlU()` | `void` | Clears `draft` and all completion state |
| `handleSubmit(onSubmit)` | `void` | Trims `draft`; if non-empty, calls `onSubmit(text)` then resets |

Overlays (shell approval, clarify prompt, model picker, trust picker, session chooser, action picker) are rendered inside the bottom stack's overlay zone and follow the same keyboard contracts as the TUI's Ink-based selectors. At most one overlay is active at a time.

#### `useOverlayKeyNav` hook

`apps/desktop/renderer/hooks/useOverlayKeyNav.ts` is the shared keyboard-navigation primitive for all list-based overlays:

```ts
interface UseOverlayKeyNavOptions {
  length: number;        // number of list items
  selectedIndex: number; // current selection
  onSelect: (index: number) => void;
  onCancel: () => void;
  wrap?: boolean;        // default false (clamp)
}
```

**Escape is always handled** — unconditionally calls `onCancel()` regardless of `length`. Arrow keys and Enter are gated on `length > 0` to prevent index arithmetic on empty lists. With `wrap: false` (default), ArrowDown/Up clamp to `[0, length-1]`; with `wrap: true`, they wrap around.

### Overlay keyboard conventions

| Overlay | Navigation | Extra bindings |
|---|---|---|
| `ActionPicker` | Clamp (default) | — |
| `ModelPicker` | Clamp (default) | — |
| `TrustPicker` | Wrap | — |
| `SessionChooser` | Wrap | Ctrl+C cancels (matches TUI convention) |
| `ClarifyPrompt` | Clamp (own handler) | Enter confirms choice or submits free text; Escape dismisses; free-text `<input>` handles Enter/Escape inline |
| `ShellApproval` | N/A | `y`/`Y` approves; `n`/`N` or Escape denies |

`ClarifyPrompt` and `ShellApproval` do not use `useOverlayKeyNav` because their key contracts are not list navigation. The free-text input in `ClarifyPrompt` receives a `:focus-visible` accent ring for keyboard users.

### What the browser renderer does not do

- No virtual scrolling — the transcript uses `overflow-y: auto` on a DOM list. Virtualization is deferred.
- No alternate-screen management — irrelevant in a browser context.
- No Electron shell — the renderer is a plain web app served by Vite. Electron wrapping is a later sprint.
- `/moa`, `/trust`, `/branch`, `/fork`, `/rollback`, `/dream`, `/cron` are not yet implemented in the desktop app (they return an error line); `/clear`, `/help`, `/model`, `/compact`, and `/settings` are fully wired.
