# Desktop UI Architecture

The renderer UI has three layers: **Page**, **Layout**, and **Component**.

Use `Page` for route-level screens. Reserve `feature` for domain modules if the app later needs
them; a feature is not a synonym for a routed screen.

## Layer responsibilities

### Page

- Lives in `src/renderer/src/pages`.
- Owns route-level orchestration, data dependencies, state coordination, and composition.
- Composes Layouts and Components.
- Must not contain Tailwind utility classes, page-specific CSS selectors, or inline visual styles.
- If styling in a Page is genuinely unavoidable, keep it minimal and explain why the requirement
  cannot live behind a Layout or Component API.

### Layout

- Lives in `src/renderer/src/layouts`.
- Owns spatial behavior such as stacks, grids, split views, shells, scrolling, padding, gaps,
  alignment, sizing, and window chrome.
- Encapsulates its Tailwind classes internally.
- Exposes semantic props for supported behavior, such as `gap`, `padding`, `alignment`,
  `orientation`, or named size variants. Do not make callers rebuild layouts with raw classes.
- Uses `cva` for finite variants and `cn` for internal conditional composition when needed.

### Component

- Lives in `src/renderer/src/components`.
- Owns reusable visual or interactive UI and encapsulates its Tailwind classes internally.
- Prefers an existing shadcn component before introducing a custom primitive.
- Exposes explicit props and named variants for appearance, size, and state.
- Does not expose arbitrary styling as the primary customization API. Add a semantic variant when
  a customization is part of the supported design.

## Styling rules

- Tailwind belongs in Layouts and Components, not Pages.
- Prefer semantic theme utilities such as `bg-background` and `text-muted-foreground` over raw
  colors.
- Use the semantic spacing scale consistently: `2` for close relationships, `3` for related
  subgroups, `4` for major separation, and `6` for broad section boundaries. Prefer the closest
  built-in Tailwind utility over arbitrary spacing values.
- Prefer `gap-*` over `space-x-*` or `space-y-*`, and `size-*` when width and height match.
- Use the Tailwind spacing scale for margins, padding, and gaps. Reserve arbitrary spacing values
  for fixed product or platform-window constraints that cannot use the shared scale.
- Keep shell and topbar controls in normal flex or grid flow. Do not use absolute positioning
  unless a platform constraint cannot be represented correctly in normal flow.
- Keep global CSS limited to Tailwind imports, theme tokens, resets, and genuinely reusable
  utilities such as Electron's `window-drag-region` and `window-no-drag`.
- Do not create page-specific CSS classes merely to hide a Tailwind string. If styling represents
  a reusable or complex purpose, make it a Layout or Component instead.
- Pages pass semantic props to Layouts and Components; they do not pass Tailwind through
  `className` escape hatches.

## Motion rules

- Add motion only when it communicates feedback, state, or spatial continuity. Keep frequent
  navigation, keyboard flows, streaming content, disclosure height, and pane geometry immediate.
- Reuse the shared `--duration-feedback` and `--ease-out` tokens for routine feedback. Prefer
  Tailwind's built-in duration and translation utilities over arbitrary values, and do not create a
  parallel motion scale for one component.
- Animate compositor-friendly `opacity` and `transform` properties. Enter and exit along the same
  path, and use `usePresence` when an exit must finish before unmounting.
- Make exiting interactive content inert and hidden from assistive technology immediately, then
  unmount it on its own opacity transition. A new active state must remain usable while it enters.
- Reduced-motion behavior keeps short opacity feedback while removing translation, scaling,
  scrolling, and other spatial motion.
- For FLIP/WAAPI list motion, keep position bookkeeping current, but read computed timing styles and
  start animations only when an explicit mutation revision produces actual row movement. Filtering,
  dialog state changes, and zero-delta mutations must not perform animation timing work.

## Dependency direction

Pages may import Layouts and Components. Layouts may import Components when composition requires
it. Components must not import Pages. Shared style helpers belong in `src/renderer/src/lib`.
