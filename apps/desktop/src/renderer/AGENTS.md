# Renderer Design-System Rules

- Use Tailwind v4 utilities in renderer components. Do not add feature selectors to `styles.css`.
- Use semantic theme utilities (`bg-surface`, `text-foreground-secondary`, `border-border`, `text-destructive`) instead of raw colors or palette-number utilities.
- Do not use `@apply`, raw hex/RGB/HSL values in TSX, or inline styles for appearance. Inline styles are reserved for runtime structure such as pane width, tree depth, and transcript indicator count.
- Reuse primitives in `components/ui`, product components in `components/ui/product.tsx`, and structural layouts in `components/layouts.tsx` before inventing a local treatment.
- Use `SearchField`, `StatusBadge`, `InlineAlert`, and shared loading/empty/error states. Palettes must use `components/palette.tsx` and `useListboxNavigation`.
- Initialize selection-driven palette navigation from the current value. Keep loading, empty, error, and retry states outside `role="listbox"`.
- Use Radix-backed dialogs, menus, selects, checkboxes, switches, and radio groups. Never use `window.confirm`, `window.alert`, or a manually implemented modal.
- Mark the active navigation destination with `aria-current="page"` and its semantic active treatment.
- Put `-webkit-app-region: no-drag` on every interactive wrapper nested in a draggable Electron region.
- Keep visual fenced-code language labels outside copied text; use generated content from `data-language`, not a text child inside `<code>`.
- Keep glass and blur on hierarchy surfaces (sidebars, toolbar fades, the floating composer shell, popovers, dialogs, sheets, overlay panels). Content and ordinary controls remain opaque enough for readability; the composer text field stays tonal inside its shell. Every glass surface must honor reduced transparency.
- Keep transcript and composer content `w-full` up to the shared 46rem maximum so panes can reduce the available width without overlaying or clipping it. Files overlays only when reserving it would leave less than 20rem of usable Task width.
- Preserve focus-visible treatment, reduced motion, increased contrast, system light/dark mode, the 760×520 floor, IPC contracts, persistence keys, and shortcuts.
- Add focused interaction and accessibility tests for new states and keyboard behavior. Run renderer typecheck, tests, and the renderer build before handoff.
