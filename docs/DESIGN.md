# Design

The supported product surface is the macOS desktop renderer. The interaction,
appearance, accessibility, and recovery contracts below describe the Railgun
experience and its backend boundary.

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

### Desktop appearance

The macOS renderer follows the system light/dark appearance and uses semantic
CSS tokens rather than component-local colors. Barlow Variable is the offline
interface face; Departure Mono Nerd Font is reserved for code, diagnostics,
and transport logs. Keyboard-shortcut labels remain in Barlow. Font assets,
source records, and SIL Open Font License notices are bundled under
`apps/desktop/src/renderer/public/fonts/` and load only through the packaged
`railgun://app/` origin.

RailgunX packages the same typography under
`apps/macos/Resources/Fonts/`: Barlow Regular, Medium, SemiBold, and Bold are
registered at launch and used for interface text with Dynamic Type scaling.
Departure Mono Nerd Font is registered alongside them and is reserved for
Markdown inline and fenced code. The native app's generated legal notices
include both SIL Open Font License records.

Material communicates hierarchy rather than covering every layer. Glass is
reserved for the inset sidebar, continuous top toolbar, floating composer
shell, anchored popovers, and dialogs. Cards, lists, fields, and prompts use
opaque or lightly tonal content surfaces with hairlines and restrained depth;
the composer's text field remains a stable tonal surface inside its glass
shell. Ordinary action buttons use four flat, shadow-free system-like recipes:
tinted capsule, plain text action, filled accent capsule, or white/tonal
capsule. Destructive actions
reuse the filled geometry with the danger color. Toolbar controls remain a
separate liquid-glass hierarchy, while sidebar navigation stays neutral.
The toolbar material spans the Task canvas behind the inset sidebar; expanding
the sidebar changes only the toolbar content inset. When the separate Files
workspace is open, the toolbar material ends at its divider instead of painting
through the right pane. It has no separator within Task and uses a blurred
vertical fade into the content canvas. Liquid-glass control
effects are contextual to this toolbar hierarchy. Ordinary tonal actions use
dedicated light/dark surface and label tokens whose text contrast must remain
at least WCAG AA (4.5:1).
Dialogs use a dense theme-aware tint, simple rim, restrained scrim, broad soft
shadow, and grouped inset content. The content canvas remains a calm readability
layer. No displacement map, remote imagery, or theme-switcher demo is part of
the product material.

System accessibility preferences take precedence over the visual effect.
Reduce Transparency replaces hierarchical glass with opaque canvas fills and
removes backdrop filters; Increase Contrast strengthens borders and focus
rings; Reduce Motion suppresses decorative transitions. These fallbacks must
be preserved when adding a new shared surface or material variant.

## Interaction

`/settings` provides keyboard-driven AI configuration for the primary model,
the persisted MOA default, and the advisor. Selection interfaces share an
immutable reducer and use Up/Down, Enter, and Escape. Their scroll window is
initialized around the current selection and follows wrapping navigation.
Trust decisions, clarification choices, bare `/moa`, and bare `/branch` follow
the same model; text entry is reserved for free-form answers and preset names.

- The terminal composer submits with Enter and inserts a newline with
  Shift+Enter when enhanced keyboard reporting is available. It grows from one
  to six rows and caps lower in short terminals; paste may contain multiple
  lines.
- Native macOS composer: the Task composer is a `RailgunUI`
  `NSTextView` bridge that grows from one through ten visual lines. Content
  beyond that cap scrolls vertically in the native text view. It preserves
  selection, multiline paste, undo, text services, and VoiceOver editing with
  the accessible name `Message`. Return submits only a nonblank enabled draft;
  Shift-Return inserts a newline. Its empty-state placeholder is rendered by
  that same native text layout, sharing the editor's inset and baseline with
  the caret. SWFT-032 mounts it in the Task shell; its
  SwiftUI owner routes idle Return to `prompt`, active Return to `steer`, and
  active Tab to `follow_up`. Initial prompt responses settle with the full
  agent run, so the shell starts observing them asynchronously and immediately
  re-enables the composer for active-run steering and follow-ups; queue drafts
  clear after their short-lived acknowledgements. Its
  surrounding shell uses the shared 736-point content column, a bordered
  material card, send affordance, queue/error presentation, and an attached
  keyboard-hint pill so the native client retains Railgun's chat hierarchy.
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
  - `/exit`, `/help`, `/clear`, `/model`, `/settings`, `/compact`, `/moa`, `/branch [--summary] [id]`, `/fork`, `/dream`, and `/cron` are the available fixed commands; `/skill:<name> [args]` dynamically expands discovered local skills. `/cron [add <id> <schedule> <prompt> | remove <id>]` lists, creates, and removes scheduled jobs; `schedule` is a 5-field cron expression. `/moa <preset-name>` activates a named preset for subsequent turns and `/moa off` deactivates it; bare `/moa` opens a session-only picker containing Off and every configured preset. The active preset name appears in the status bar. Bare `/branch` opens an arrow-key picker of recent messages, while `/branch [--summary] <id>` remains available for direct selection. `/fork` copies the active branch into a new session. Shell approval remains a `y`/`n`/Escape confirmation rather than a list selection.

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
  and themed fenced-code boxes with language labels. A fenced label is visually
  generated content sourced from `data-language`, not a text node inside the
  code element, so copying a block returns only its source. Streaming fragments
  remain plain until completion.
- Generic thinking and live tool states use animated mint activity rows — one
  row per in-flight tool call, so a concurrent batch renders as that many
  simultaneous rows rather than a single collapsed count. Agent
  narration is committed before a following compact tool row, preserving the
  chronological event sequence instead of pinning active text below tools.
  Short transcript slices bottom-align against the composer; full pages remain
  top-aligned for stable scrolling.

- The desktop transcript uses the same chronological contract for assistant
  messages, tools, and MoA references/aggregation. Tool rows are native,
  button-backed expanders: an icon plus a concise action and target (for example,
  `Edited scheduler.ts`) is shown by default, while sanitized live input/output
  remains available on expansion. The full summary row, including its chevron,
  is the pointer and keyboard activation target. Restored file-tool rows retain
  only a safe basename target; they never receive raw arguments or results.
  Consecutive **settled** uses of the same tool merge into an outer,
  parameter-free expander (for example, `Edited files`) that expands to the
  original rows. Concurrent or otherwise live calls always remain individual
  rows so their target and status remain visible. Collapsed tool, merged-tool,
  and `Worked` rows are visually muted until hover; any expanded row returns to
  full contrast and exposes its expanded accessibility state. Settled turn
  activity lives in a `Worked` expander with a horizontal divider beneath its
  summary. Tool state remains part of the expander's accessible name and error
  or interrupted icons use the matching semantic color. Activity is withheld
  entirely when no valid task is selected. The non-resizable, responsive
  **Activity Dashboard** keeps advisor notes out of the transcript.
  It orders its current-run sections as Advisor, Todos, then Subagents. The
  single Advisor row uses a distinct icon and exposes severity-styled `nit`,
  `concern`, and `blocker` notes in a hover- and focus-accessible popover;
  subagent rows expose their full goal, lifecycle status, and final result in
  the same way. Final results render sanitized GFM Markdown, matching completed
  assistant replies. The card wraps its content, independently caps its Todo and
  Subagent lists, and is controlled from the native sidebar toolbar. When
  requested with at least 900pt of detail width, it docks as a leading glass
  panel beside the sidebar and reserves 376pt of transcript width. At narrower
  widths, it becomes a 320×360 floating popover and reserves no transcript
  width. Its own scroll content stays transparent so the glass surface remains
  visible, and the toolbar toggle is the sole visibility control. Todo progress
  is textual and status glyphs are supplemental. These surfaces retain Reduce
  Transparency, Increase Contrast, and Reduce Motion behavior through the
  existing semantic tokens.
  The separate Files pane uses an opaque split tree/preview surface with a
  clear divider. Its header aligns to the toolbar centerline without inheriting
  the toolbar's extra visual depth: the open action stays in the Task toolbar
  while collapsed, where it shares one divided glass capsule with the Activity
  Dashboard toggle, and the collapse action moves into the pane header while open.
  Files reserves width while the expanded-sidebar layout leaves at least 20rem
  for Task. Below that threshold it becomes a right overlay rather than
  silently clipping transcript or composer content. Collapsing the sidebar can
  release enough width to restore the reserved layout.
  Tool-call IDs identify only active invocations; a later turn that reuses an
  ID still receives a distinct chronological row. Failed prompt submission or
  backend interruption remains a danger-styled inline row with its Retry or
  Restart action rather than degrading to unstyled text.

- The desktop chat is one full-height canvas. Toolbar, transcript, operation
  errors, and composer occupy the same overlay grid cell instead of creating
  disconnected vertical regions. Operation errors align below the toolbar fade,
  remain above transcript/composer content, and follow the live sidebar inset.
  The root transcript scroll view remains mounted across loading, empty,
  selection-required, selected, and stale-selection states, but only a valid
  selected task contributes message rows. Retained messages from a previous
  task must not remain visible, scrollable, or accessibility-exposed behind a
  state overlay. Session-operation failures remain visible in a non-scrolling
  danger-styled banner.
  RailgunX retains the native transcript scrollbar so macOS 26 can render its
  soft top-edge effect; it must not hide, replace, or mutate that scroller. The
  transcript initializes at the newest content and follows content and layout
  growth while it remains at the bottom. Any scroll away from the automatic
  destination—whether caused by wheel, touch, keyboard, selection, browser
  find, or accessibility tooling—disengages following and preserves the current
  position. Returning within 4px of the bottom re-engages immediate following
  for subsequent updates. The implementation and cold-launch verification
  invariants are defined in
  [`native-ui-policy.md`](native-ui-policy.md#transcript-soft-top-edge-invariant).
  Transcript rows use a 32pt inter-message gap, with 32pt leading and 24pt
  trailing content insets, so multi-turn conversations retain a comfortable
  reading rhythm.

- The desktop composer gives message entry its own full-width row. Its quiet
  footer shows the active model, one combined Agent settings trigger, exact
  context usage, and Send/Stop without turning every action into a separate
  glass pill. The searchable model dialog provides explicit `This task` and
  `Make default` choices and initializes keyboard navigation on the active
  model. Agent settings contains MoA, advisor, advisor model,
  and manual Compact controls; portalled select menus stack above the dialog.
  Dialogs omit a decorative close control by default and use explicit trailing
  footer actions such as Done; the selection-driven command palette is the
  intentional close-less exception. Anchored dropdowns include a material arrow
  and share the dense readable menu recipe with selects.
  Compact is disabled during runs/control mutations and for empty history.
  Context usage is the latest provider-reported input plus output total against
  the active model's context window and reads `Not measured yet` after model
  changes, compaction, restart, or New Task until another provider turn reports
  usage. Loading and mutation failures stay inline and retryable. Transcript
  rows and the composer fill the available Task column up to the shared 46rem
  maximum and retain minimum side gutters as Files or the sidebar changes the
  available width. The text area begins at one line, grows with input to ten
  lines, never exposes a mouse resize handle, and reports the composer's live
  height so the transcript bottom inset follows it.

- Desktop Settings replaces the Task shell while open and restores the same
  active task on Back. Its softly tinted sidebar groups General, Agent, and
  Trust under Railgun; Memories, Notes, Instructions, and Skills under
  Knowledge; Provider and MCP under Connections; and Diagnostics under System.
  Knowledge is not a separate top-level area or tab strip. Every destination
  uses the same page heading, opaque inset groups, hairline row separators,
  spacing, and compact controls as General and Trust. Search includes setting
  descriptions and moves focus to the result row. Navigation—including native
  Task and New Task commands—confirms before discarding dirty edits. Confirmed
  instruction discards clear the editor and unload guard. Knowledge store views
  mount only after backend readiness; live backend/run refreshes preserve other
  drafts. The Settings destination remains marked as the current sidebar page.
  Its sidebar is an Electron drag region only around passive material: search,
  navigation, and other interactive wrappers explicitly opt out with
  `-webkit-app-region: no-drag`.
- Settings owns persisted defaults, not active work. Default-model changes apply
  to new tasks; agent and trust changes apply to the next run. Mutations are
  disabled during a run or authentication operation. Provider sign-in/out uses
  explicit confirmation and explains that cached logout cannot override
  `DEVIN_TOKEN`. Diagnostics show bounded redacted backend details and mock
  scenario controls only in mock mode.

- Topbar actions and left/right pane controls share a 40px minimum height and
  the traffic-light centerline. They are flat bordered controls without drop
  shadows, raised gradients, backdrop blur, or active-scale effects. The inset
  left sidebar is the only app glass surface tinted by the active theme;
  popovers and other translucent materials remain neutral.

## UI states

Seven observable states drive the visual treatment of the transcript and composer area.

| State | Treatment |
|---|---|
| Empty session (no messages) | Header with `RAILGUN · adaptive agent console` and the status bar are visible. The transcript area is empty; short content bottom-aligns against the composer (existing behavior in `transcriptJustification`). No placeholder text — the composer's prompt is invitation enough. |
| Waiting for first token | An animated `dots2` spinner row with `theme.dim` styling and a "Thinking…" label. The desktop renderer uses the shared thinking-indicator token. |
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
effective defaults include `{ "model": null,
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

Railgun always uses the current user's home directory as its working directory.
Project selection, project-local extensions, and per-project trust settings are
not part of the product.

The optional `moaPresets` key defines named Mixture of Agents presets, each with a `referenceModels` array (up to 8 entries, each `{model, temperature?}`), an `aggregator` `{model, temperature?}`, and an optional positive `referenceMaxTokens`. The optional `activeMoaPreset` key names the default preset for both one-shot and interactive REPL sessions; `/moa` can override it for the current REPL session. Preset validation at config load time rejects missing required fields, non-positive token caps, and `activeMoaPreset` pointing to an unknown preset name. Unknown extra keys inside a preset are preserved (forward-compatible).

A configured string requests that exact model for fresh sessions. When it is
missing, interactive TTY launches show a model chooser using the resume
chooser's theme, lifecycle, wrapping navigation, and resize-aware viewport.
Rows lead with the model name and follow with ID and capabilities. Enter saves
the replacement atomically before session construction; Escape/Ctrl-C leaves
the file unchanged and exits successfully. Non-interactive launches fail with
the missing and available IDs plus interactive recovery instructions. Resumes
remain pinned to their stored model because changing it would alter conversation
semantics. Proactive/general model switching is available from the model controls.

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

Electron real-backend children use a desktop-only non-interactive startup mode.
Missing or rejected file credentials show authentication-required and recover
through the supervised helper in Settings → Provider. Successful sign-in or
cached logout restarts the backend; helper failure preserves the existing
credential and backend, and Task mutations remain blocked until recovery
settles. A rejected `DEVIN_TOKEN` instead shows source-specific guidance to
update or unset the variable and relaunch Railgun; cached sign-in/logout and
Retry cannot change the environment inherited by the running desktop process.
Ordinary terminal and non-desktop RPC authentication retain the behavior above.

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
