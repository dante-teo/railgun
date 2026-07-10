# Design

## Product Experience

This document captures the interaction model, visual direction, and usability standards for Railgun.

## Audience

- Primary audience: the project's own author, using this as a personal
  terminal tool
- Context of use: a local terminal; either a persistent interactive REPL
  session or a one-shot scripted invocation (`--print`/`-p`)
- Accessibility needs: whatever the user's own terminal/screen reader setup
  already provides — no custom accessibility work in a text-only CLI

## Design Principles

- Optimize common workflows for speed and clarity.
- Prefer dense, scannable layouts for operational interfaces.
- Use consistent controls for repeated actions and state changes.
- Keep visual styling restrained unless the product domain calls for a more expressive experience.

## Information Architecture

Phase 2 has two surfaces: the default Ink chat REPL (`pnpm start`) — a
persistent scrolling transcript plus a single-line text input, no
navigation, no persisted state visible beyond the cached token file — and
the one-shot `--print`/`-p` path, which keeps Phase 1's single
command/single answer shape for scripting. Phase 9 adds a startup banner
(printed once above the transcript when the REPL launches) and a
slash-command system (`/exit`, `/skin <name>`, `/help`, `/clear`) with
tab-completion, plus a persisted skin preference at
`~/.railgun/config.json` — all still local to the REPL surface; the
one-shot path is unaffected. Phase 11 adds a local planning surface: a todo
panel in the REPL and a silent todo tool in one-shot mode. Phase 12 adds local
session persistence plus two startup-only management surfaces: a detailed
session table and a keyboard-driven resume chooser. There are no in-session
new/switch/rename/delete commands.

## Key Screens

| Screen | Purpose | Notes |
| --- | --- | --- |
| Ink chat REPL (stdout, interactive) | Scrolling conversation transcript above a persistent todo panel and a single-line input box, with a status line at the bottom | Default `pnpm start` surface; shows a rounded-corner startup banner in the active skin's color tokens before the transcript; user lines render on a tinted background block prefixed by the skin's prompt symbol (default `❯ `); tool calls render in bordered frames (pending/success/error with state-tinted backgrounds); an accent-colored in-flight line shows the reply streaming in; error lines use the skin's `error` color; a persistent status line shows model id, `~`-shortened cwd, and git branch; typing `/` opens a skin-themed slash-command dropdown below the input |
| One-shot terminal (stdout/stderr) | Show one streamed answer and status messages, then exit; may pause on stderr for shell-command approval | `--print`/`-p` only; `docs/PRODUCT.md`'s later phases add a TUI/Web/Desktop/Mobile front end reusing the same core |
| Saved-session list/chooser | Inspect newest-first saved sessions or select one to resume | Rows show local start time, message count, model, full ID, and collapsed first-user preview; Up/Down moves the highlight, Enter resumes, and Escape/Ctrl-C cancels |

## Interaction Patterns

- Status/progress messages (login prompt, "Using model: ...") print to
  stderr in both surfaces; in the one-shot path only the model's streamed
  answer prints to stdout, so output can be piped without status noise
  mixed in.
- First-run login is a single interruption (opens the system's default
  browser); every subsequent run is silent and immediate.
- In the REPL, submitting a blank line does nothing (no turn run, no
  transcript entry); typing a recognized slash command runs it —
  `/exit` (or `Ctrl+C`) quits, `/skin <name>` switches skins, `/help`
  lists commands, `/clear` clears the terminal.
- While a turn is in flight, the input box loses focus (no concurrent
  submits) and an accent-colored line shows the reply streaming in; on completion it
  moves into the permanent scrollback and the input regains focus.
- A per-turn Devin error surfaces as one red line in the transcript (via
  the same three known-error-type classification as the one-shot path,
  plus a generic fallback) and the REPL stays open for the next
  message — errors no longer always exit the process, only the one-shot
  path's top-level failure still does.
- Typing `/` auto-shows a vertical dropdown of available slash commands
  below the input; Tab cycles through the matches with a highlight, and
  Escape dismisses the dropdown without submitting.
- `/skin <name>` changes the prompt symbol and color tokens live (no
  restart) and persists the chosen skin to `~/.railgun/config.json`, so
  the next launch starts in that skin.
- `/clear` clears the terminal screen; the scrolling transcript
  continues below it (no state is discarded, only the visible screen).
- The REPL's agent can read/write files and list directories while
  answering. A live spinner+label line (e.g. a braille frame plus
  "Reading notes.txt") replaces the streaming placeholder while a tool
  runs; once it finishes, a permanent `✔`-prefixed (success) or
  `✘`-prefixed (error) line moves into the scrollback in its place —
  a parallel-safe batch of tool calls collapses to one
  "Running N tools concurrently" line and one "✔ N/N tools completed"
  line rather than a separate pair per call. The one-shot path shows the
  equivalent spinner and final `✔`/`✘` line on stderr only, so a piped
  stdout answer never contains spinner frames or tool labels.
- Before running a shell command, the REPL freezes the text input (loses
  focus) and shows an accent-colored `Run shell command: <command> [y/n]` line in
  place of normal turn output; pressing `y` runs it and feeds the real
  output back into the conversation, `n` or `Esc` declines and the input
  regains focus — no other key does anything while the prompt is showing.
  The one-shot path shows the equivalent prompt on stderr and blocks
  reading a line from stdin instead (`Type "yes" to run, anything else to
  cancel:`).
- Multi-step planning appears in a dedicated todo panel above the input,
  not as normal tool-completion scrollback. The panel is hidden while empty,
  shows `Crafting todos` with a spinner while an empty todo update is in
  flight, then renders `Todos · completed/total` plus flat rows with status
  glyphs (`[ ]`/`[>]`/`[x]`/`[-]`). The panel is checkpointed with an
  interactive conversation and hydrated on resume.
- A saved session's short ID appears in the status line. A failed checkpoint
  adds an `unsaved` marker and warning without discarding the completed turn;
  the marker clears after a later full-snapshot retry succeeds.
- Resumed scrollback contains historical user blocks and the assistant text
  associated with each turn. Old tool execution frames are not replayed.

## Visual System

- Typography: inherits the user's terminal font and size. Hierarchy uses Ink
  `bold`, `dimColor`, and inverse selection rather than bundled fonts or text
  scaling.
- Color: a skin system provides two builtin themes — `default` (OMP
  dark-theme palette) and `mono` (OMP dark-monochrome palette) — selected at
  runtime via `/skin <name>`. Each skin defines color-role tokens mirroring
  OMP's theme vocabulary: `accent` (headings, prompt symbol, highlights,
  in-flight/attention color), `border` (box chrome, input frame, pending
  tool frame), `muted` (secondary body text), `dim` (tertiary/de-emphasized
  UI such as unselected dropdown rows), `success`/`error` (tool completion
  status and tool-frame borders), `selectedBg` (dropdown selection
  background), `userMessageBg` (user-message background block),
  `toolPendingBg`/`toolSuccessBg`/`toolErrorBg` (tool-frame background
  tints), `statusLineBg`/`statusLineModel`/`statusLinePath`/
  `statusLineGitClean`/`statusLineGitDirty` (bottom status bar segments).
  The startup banner uses rounded-corner Unicode box-drawing (`╭╮╰╯─│`)
  with border chrome colored `border`, agent name colored `accent` bold,
  and welcome text colored `muted`. Tool completion lines render inside
  bordered `Box` frames using OMP's `✔`/`✘` glyphs colored by
  `success`/`error`, with state-dependent background tints and border
  colors. The in-flight tool spinner also renders in a bordered pending
  frame using the `dots2` braille set (OMP's "status" spinner) colored
  `accent`. The text input sits inside a rounded bordered frame colored
  `border`. User messages in the scrollback render on a `userMessageBg`
  background block. The slash-command dropdown highlights the selected row
  with `accent`-colored text on a `selectedBg` background; unselected rows
  use `dim`. A persistent status line at the bottom shows the model id
  (`statusLineModel`), `~`-shortened working directory (`statusLinePath`),
  and — when inside a git repo — the current branch name
  (`statusLineGitClean`/`statusLineGitDirty`, with a `*` suffix when dirty).
- Spacing: bordered panels use one-column horizontal padding; transcript,
  chooser, and todo content stack vertically with a single blank row or
  bottom margin between distinct items.
- Icons: `✔` (success), `✘` (error), `❯` (default prompt), `>` (mono
  prompt); OMP's 8-frame braille "status" spinner
  (`⣾⣽⣻⢿⡿⣟⣯⣷`) for tool calls; plain streaming text uses no spinner.
- Components: transcript (with user-message background blocks and bordered
  tool-execution frames), streaming line, bordered input frame, slash-command
  suggestions, shell approval prompt, todo panel, and status line.

## Accessibility

- Keyboard support: all interactive paths are keyboard-only. The session
  chooser supports Up/Down, Enter, Escape, and Ctrl-C; the REPL supports text
  entry, Tab completion, Escape dismissal/decline, y/n shell approval, slash
  commands, and Ctrl-C exit.
- Screen reader support: no dedicated screen-reader mode has been tested.
  Dynamic Ink repainting, spinners, and ANSI styling may be announced
  inconsistently by terminal accessibility tools.
- Color contrast: no formal contrast audit has been performed. The `mono`
  skin provides a low-color alternative, but meaning is also conveyed with
  text and glyphs rather than color alone.
- Motion preferences: there is no reduced-motion setting; in-flight tools and
  todo creation use terminal spinners.

## Open Questions

- Should the all-sessions chooser gain viewporting or paging when saved
  session counts exceed the terminal height?
- Is a static-output/screen-reader mode needed for the Ink surfaces?
