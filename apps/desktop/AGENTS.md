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
- Prefer `gap-*` over `space-x-*` or `space-y-*`, and `size-*` when width and height match.
- Use the Tailwind spacing scale for margins, padding, and gaps. Reserve arbitrary spacing values
  for fixed product or native-window constraints that cannot use the shared scale.
- Keep shell and topbar controls in normal flex or grid flow. Do not use absolute positioning
  unless a platform constraint cannot be represented correctly in normal flow.
- Keep global CSS limited to Tailwind imports, theme tokens, resets, and genuinely reusable
  utilities such as Electron's `window-drag-region` and `window-no-drag`.
- Do not create page-specific CSS classes merely to hide a Tailwind string. If styling represents
  a reusable or complex purpose, make it a Layout or Component instead.
- Pages pass semantic props to Layouts and Components; they do not pass Tailwind through
  `className` escape hatches.

## Dependency direction

Pages may import Layouts and Components. Layouts may import Components when composition requires
it. Components must not import Pages. Shared style helpers belong in `src/renderer/src/lib`.
