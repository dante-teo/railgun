# 0007. Adopt an adaptive full-screen terminal UI

Date: 2026-07-10

## Status

Accepted

## Context

The original Ink REPL used append-only scrolling output, a single-line input,
and manually selected persisted skins. It could not keep controls visible,
navigate long wrapped replies reliably, follow terminal appearance changes, or
present interleaved assistant/tool activity in chronological order. A polished
terminal agent also needs reliable cleanup because raw terminal modes can
otherwise leak into the user's shell.

## Decision

- Interactive TTY sessions use Ink's full-height layout in the alternate screen.
  Non-TTY commands and screen-reader mode retain ordinary output.
- Internal immutable mint-light and mint-dark palettes replace manual skins.
  `os-theme` resolves terminal appearance before OS appearance, watches both,
  deduplicates changes, and falls back to dark. Legacy config is ignored and
  left untouched.
- The transcript is reduced to physical rendered rows before viewporting.
  Mouse wheel, PageUp/PageDown, and Home/End navigate it. New content and resize
  follow the bottom only when already there; otherwise a visible row is reserved
  for the unseen-output cue.
- Streaming assistant narration is flushed before a following tool starts.
  Generic thinking and live tools use animated rows; completed tools use compact
  labeled rows. Successful todo activity remains in the sticky todo panel.
- `ink-multiline-input` provides wrapping, cursor editing, and multiline paste.
  Enter submits, enhanced Shift+Enter inserts a newline where supported, Tab
  completes suggestions, and Ctrl+U clears the draft. Known terminal protocol
  replies are filtered before they reach the editor.
- Completed replies render through `markdansi` with wrapped GFM structures and
  themed code boxes; partial streaming text remains plain.
- Alternate-screen, SGR mouse, theme listener, and native appearance resources
  are released through guaranteed cleanup boundaries. The resume chooser shares
  the theme, lifecycle, resize behavior, and compact full-screen layout.
- The status bar shows `ready` while idle and the active phase plus elapsed time
  while working, including parallel tool counts. A responsive operation stall is
  shown prominently with the stable local diagnostics path; diagnostics failure is
  degraded to `logs unavailable` without taking down or cancelling the session.
  Elapsed time resets when the first operation starts after idle, and child provider,
  tool, compaction, MoA, or advisor phases take precedence over their parent turn.
  Slash-command phases are fixed categories rather than user-provided command or
  skill tokens. See `docs/INTERACTIVE_DIAGNOSTICS.md`.

## Consequences

- Interactive sessions gain sticky controls, live adaptive appearance,
  chronological activity, Markdown, and mouse/keyboard history navigation.
- Terminal integration is more complex: OSC/theme replies, enhanced keyboard
  reporting, mouse tracking, raw stdin, and alternate-screen state must be
  coordinated and tested as lifecycle resources.
- There is no manual theme override or external theme configuration. Meaning is
  retained through labels and glyphs rather than color alone.
- One-shot printing and `--list-sessions` remain plain, pipe-friendly output.
- The REPL now depends on `os-theme`, `ink-multiline-input`, and `markdansi` in
  addition to Ink, React, and the existing spinner package.
