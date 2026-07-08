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
command/single answer shape for scripting.

## Key Screens

| Screen | Purpose | Notes |
| --- | --- | --- |
| Ink chat REPL (stdout, interactive) | Scrolling conversation transcript above a single-line input box | Default `pnpm start` surface; user lines prefixed `> `, a cyan in-flight line shows the reply streaming in, red lines are per-turn errors |
| One-shot terminal (stdout/stderr) | Show one streamed answer and status messages, then exit | `--print`/`-p` only; `docs/PRODUCT.md`'s later phases add a TUI/Web/Desktop/Mobile front end reusing the same core |

## Interaction Patterns

- Status/progress messages (login prompt, "Using model: ...") print to
  stderr in both surfaces; in the one-shot path only the model's streamed
  answer prints to stdout, so output can be piped without status noise
  mixed in.
- First-run login is a single interruption (opens the system's default
  browser); every subsequent run is silent and immediate.
- In the REPL, submitting a blank line does nothing (no turn run, no
  transcript entry); typing `/exit` or pressing `Ctrl+C` quits.
- While a turn is in flight, the input box loses focus (no concurrent
  submits) and a cyan line shows the reply streaming in; on completion it
  moves into the permanent scrollback and the input regains focus.
- A per-turn Devin error surfaces as one red line in the transcript (via
  the same three known-error-type classification as the one-shot path,
  plus a generic fallback) and the REPL stays open for the next
  message — errors no longer always exit the process, only the one-shot
  path's top-level failure still does.
- The REPL's agent can call a `read_file` tool to read files from disk
  while answering; tool-call rounds show no distinct UI (the streaming
  line stays at its empty placeholder during a pure tool-call round) — a
  later phase adds live tool activity feedback.

## Visual System

- Typography: TBD
- Color: TBD
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
