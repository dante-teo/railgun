# ADR 0016 — ANSI-first shared UI design system (`src/ui/`)

**Phase:** 35  
**Status:** Accepted

## Context

Railgun's terminal UI has historically been Ink-only: the `Theme` interface in
`src/repl/theme.ts` stores raw hex color strings that Ink's `color`/
`backgroundColor` props consume directly. Phase 36 introduces a non-Ink
component tree that renders directly to stdout as ANSI-escaped strings. Phase
37 (Desktop) and Phase 38 (Mobile) need the same color values in a
JSON-serializable form.

Before this ADR, the only ANSI color helper in the codebase was a private `rgb`
function defined inline in `src/repl/markdown.ts` (used to remap `markdansi`'s
generic ANSI codes to Railgun's mint palette). Nothing produced pre-styled ANSI
strings usable outside Ink, and there was no single source of truth for raw
palette values that non-terminal clients could consume.

## Decision

Introduce a new `src/ui/` module with two files:

### `src/ui/palette.ts` — serializable raw tokens

Exports:

- `Palette` interface — the 16 semantic color slots (hex strings only).
- `ThemeMode = "dark" | "light"` — re-exported by `src/ui/theme.ts`.
- `palettes: Readonly<Record<ThemeMode, Palette>>` — values copied verbatim
  from `THEMES` in `src/repl/theme.ts`. Both objects must stay in sync; the
  `src/repl/` copy is authoritative until a future phase unifies them.
- `glyphs` — the nine named glyph characters used in the UI (`⏺ ✔ ✘ ▌ ↓`
  and todo brackets). Single source of truth for all renderers.

No functions, no ANSI, no runtime behavior. Safe to `JSON.stringify`.

### `src/ui/theme.ts` — ANSI styling layer

Exports:

- `rgb(hex, background?)` — the shared truecolor ANSI escape helper, now
  exported so `src/repl/markdown.ts` can import it instead of duplicating it.
- `AnsiTheme` interface — named styling functions `(s: string) => string` for
  each palette slot plus composite helpers.
- `ToolCallState = "running" | "done" | "error"`.
- `createAnsiTheme(mode?)` — constructs an `AnsiTheme` for the given mode
  (default `"dark"`). Each field is a closure over the mode's palette entry.
  `toolCallLabel` and `toolCallPrefix` use a lazy self-reference (`t`) so they
  can call `t.dim()`, `t.error()`, and `t.success()` without circularity.

No chalk, no external color library. The escape format is the same
`\u001b[38;2;R;G;Bm` truecolor pattern `markdown.ts` already used — zero new
dependencies.

### `src/repl/theme.ts` — unchanged

The Ink-based REPL continues consuming raw hex strings via Ink props. The two
theme representations coexist deliberately: `src/repl/theme.ts` for Ink,
`src/ui/theme.ts` for everything else. Unifying them is deferred to Phase 36.

### `src/repl/markdown.ts` — boy-scout cleanup

The local `rgb` definition was removed and replaced with an import from
`src/ui/theme.ts`. The `markdownTheme` factory function was hoisted to a
module-level constant (it returned the same literal every call; `markdansi`
never mutates the theme object it receives).

## Consequences

- Phase 36's non-Ink renderer can `import { createAnsiTheme } from
  "../ui/theme.js"` and get styled strings immediately.
- Desktop/Mobile clients can `import { palettes, glyphs } from
  "../ui/palette.js"` and receive JSON-serializable tokens to pass over any
  transport.
- A single change to a hex value in `src/ui/palette.ts` propagates to every
  renderer that imports from `src/ui/`.
- The `rgb` helper is no longer duplicated between `markdown.ts` and
  `theme.ts`.
- `src/repl/theme.ts` retains its own `THEMES` constant — there are now two
  copies of the hex values. This is accepted tech debt until Phase 36 can
  unify the two.
- No new runtime dependencies; no chalk.
