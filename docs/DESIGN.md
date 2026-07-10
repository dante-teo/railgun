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

- Enter submits; Shift+Enter inserts a newline when enhanced keyboard reporting
  is available. The composer grows from one to six rows and caps lower in short
  terminals. Paste may contain multiple lines.
- Tab completes an active slash suggestion. Otherwise it is consumed as the
  reserved future enqueue binding. Busy and approval states disable editing
  without deleting the draft. `Ctrl+U` clears the draft.
- The mouse wheel scrolls transcript history by rows. PageUp/PageDown move by
  one viewport. Home/End jump to the beginning/end. New output and resizes
  preserve bottom-follow only when already at the bottom; otherwise an
  unseen-row cue reserves one visible transcript row.
- `/exit`, `/help`, and `/clear` are the available commands. Shell approval uses
  `y`, `n`, or Escape.
- Completed replies use GFM Markdown with wrapped prose, lists, links, tables,
  and themed fenced-code boxes with language labels. Streaming fragments remain
  plain until completion.
- Generic thinking and live tool states use animated mint activity rows. Agent
  narration is committed before a following compact tool row, preserving the
  chronological event sequence instead of pinning active text below tools.

## Lifecycle and accessibility

Interactive TTY sessions and the resume/model choosers enter the alternate
screen and restore it on every exit path. Non-TTY output and
`INK_SCREEN_READER=true` skip the alternate screen. The screen-reader path uses
Ink's accessible rendering; all controls remain keyboard-only and all status
meaning has a textual cue.

## Session chooser

The chooser shares the live automatic theme, header, selected surface, compact
metadata, and status bar. Up/Down wraps, Enter resumes, and Escape/Ctrl-C
cancels. Its newest-first list viewport tracks selection across terminal
resizes. Input state advances synchronously, so rapid navigation followed by
Enter confirms the latest highlight even before React repaints it.

## Configuration and model recovery

`~/.railgun/config.json` is active as the single configuration source. Its
effective default is `{ "model": null }`: fresh REPL and one-shot sessions use
Devin's first returned model. `railgun config` renders the recursively merged,
pretty JSON without crossing authentication, SQLite, file-creation, or TUI
boundaries. Unknown fields remain visible and preserved; invalid configuration
fails in place rather than being repaired.

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
