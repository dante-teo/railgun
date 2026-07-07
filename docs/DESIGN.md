# Design

## Product Experience

This document captures the interaction model, visual direction, and usability standards for Railgun.

## Audience

- Primary audience: the project's own author, using this as a personal
  terminal tool
- Context of use: a local terminal, one-shot invocation per run
- Accessibility needs: whatever the user's own terminal/screen reader setup
  already provides — no custom accessibility work in a text-only CLI

## Design Principles

- Optimize common workflows for speed and clarity.
- Prefer dense, scannable layouts for operational interfaces.
- Use consistent controls for repeated actions and state changes.
- Keep visual styling restrained unless the product domain calls for a more expressive experience.

## Information Architecture

Phase 1 has a single flat surface: one command (`pnpm start "<question>"`)
that produces one streamed answer per invocation. No screens, no navigation,
no persisted state visible to the user beyond the cached token file.

## Key Screens

| Screen | Purpose | Notes |
| --- | --- | --- |
| Terminal (stdout/stderr) | Show the streamed answer and status messages | No GUI in Phase 1; `docs/PRODUCT.md`'s later phases add a TUI/Web/Desktop/Mobile front end reusing the same core |

## Interaction Patterns

- Status/progress messages (login prompt, "Using model: ...") print to
  stderr; only the model's streamed answer prints to stdout — so output can
  be piped without status noise mixed in.
- First-run login is a single interruption (opens the system's default
  browser); every subsequent run is silent and immediate.
- Errors surface as one plain-language line on stderr plus a non-zero exit
  code — never a raw stack trace — per the three known Devin error types
  (auth, API, protocol) plus a generic fallback.

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
