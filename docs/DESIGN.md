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
one-shot path is unaffected.

## Key Screens

| Screen | Purpose | Notes |
| --- | --- | --- |
| Ink chat REPL (stdout, interactive) | Scrolling conversation transcript above a single-line input box | Default `pnpm start` surface; shows a bordered startup banner in the active skin's colors before the transcript; user lines prefixed by the skin's prompt symbol (default `❯ `); a cyan in-flight line shows the reply streaming in; red lines are per-turn errors; typing `/` opens a slash-command dropdown below the input |
| One-shot terminal (stdout/stderr) | Show one streamed answer and status messages, then exit; may pause on stderr for shell-command approval | `--print`/`-p` only; `docs/PRODUCT.md`'s later phases add a TUI/Web/Desktop/Mobile front end reusing the same core |

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
  submits) and a cyan line shows the reply streaming in; on completion it
  moves into the permanent scrollback and the input regains focus.
- A per-turn Devin error surfaces as one red line in the transcript (via
  the same three known-error-type classification as the one-shot path,
  plus a generic fallback) and the REPL stays open for the next
  message — errors no longer always exit the process, only the one-shot
  path's top-level failure still does.
- Typing `/` auto-shows a vertical dropdown of available slash commands
  below the input; Tab cycles through the matches with a highlight, and
  Escape dismisses the dropdown without submitting.
- `/skin <name>` changes the prompt symbol and spinner type live (no
  restart) and persists the chosen skin to `~/.railgun/config.json`, so
  the next launch starts in that skin.
- `/clear` clears the terminal screen; the scrolling transcript
  continues below it (no state is discarded, only the visible screen).
- The REPL's agent can read/write files and list directories while
  answering. A live spinner+label line (e.g. a braille frame plus
  "Reading notes.txt") replaces the streaming placeholder while a tool
  runs; once it finishes, a permanent green `✓`/red `✗`-prefixed line
  (e.g. "✓ Reading notes.txt") moves into the scrollback in its place —
  a parallel-safe batch of tool calls collapses to one
  "Running N tools concurrently" line and one "✓ N/N tools completed"
  line rather than a separate pair per call. The one-shot path shows the
  equivalent spinner and final `✓`/`✗` line on stderr only, so a piped
  stdout answer never contains spinner frames or tool labels.
- Before running a shell command, the REPL freezes the text input (loses
  focus) and shows a yellow `Run shell command: <command> [y/n]` line in
  place of normal turn output; pressing `y` runs it and feeds the real
  output back into the conversation, `n` or `Esc` declines and the input
  regains focus — no other key does anything while the prompt is showing.
  The one-shot path shows the equivalent prompt on stderr and blocks
  reading a line from stdin instead (`Type "yes" to run, anything else to
  cancel:`).

## Visual System

- Typography: TBD
- Color: a skin system provides two builtin themes — `default` (gold/bronze)
  and `mono` (grayscale) — selected at runtime via `/skin <name>`. Each
  skin controls the startup banner's border, title, and body text colors,
  the REPL's prompt symbol, and the spinner type used for in-flight/tool
  lines; the rest of the palette (transcript text, error red, tool
  success/failure markers) is unthemed and shared across skins.
- Spacing: TBD
- Icons: TBD
- Components: TBD

## Accessibility

- Keyboard support: TBD
- Screen reader support: TBD
- Color contrast: TBD
- Motion preferences: TBD

## Open Questions

- TBD
