# Railgun Renderer Design System

Railgun uses Tailwind CSS v4 with a semantic token catalog in `styles.css`. The renderer follows the macOS system color scheme; it does not persist a separate theme setting.

## Layers

1. `styles.css` owns fonts, semantic token values, system accessibility variants, and documented Electron/browser exceptions.
2. `components/ui` owns Radix-backed controls and small visual primitives.
3. `components/ui/product.tsx` owns recurring Railgun patterns such as page headers, toolbars, settings sections, settings rows, and glass hierarchy surfaces.
4. `components/layouts.tsx` owns structure only: sizing, composition, scrolling, gaps, and breakpoints.
5. Product surfaces compose those layers with Tailwind utilities. They must not create a competing palette, field, badge, dialog, or status language.

## Semantic tokens

Use foreground tiers, canvas/surface levels, primary/secondary actions, destructive/success/warning/info feedback, border/focus tokens, typography tiers, named radii, control heights, elevations, and motion tokens exposed through `@theme inline`.

Raw colors are limited to light/dark token declarations. Regular text and action labels target WCAG 2.1 AA contrast (4.5:1); meaningful large text and UI indicators target 3:1.

## Liquid glass

Glass is a hierarchy signal, not a universal material. Sidebars, the titlebar fade, the floating composer shell, popovers, dialogs, sheets, and floating overlay panels use the semantic material and blur recipes. Cards, editors, fields, and ordinary buttons use stable semantic surfaces so dense information remains legible; the composer text field remains tonal inside its glass shell. Add `data-glass-surface` to new glass primitives so reduced-transparency and increased-contrast variants apply automatically.

## Interaction contracts

- Destructive and dirty-state decisions use `ConfirmDialog`.
- Search inputs use `SearchField`.
- Command, task, and model palettes use the shared palette shell and listbox-navigation hook. A picker with a current value passes that value as its initial active key; status, loading, empty, and retry content stays outside the listbox.
- Trees use roving focus with arrows, Home/End, Enter/Space, expansion, selection, and visible focus.
- Selection controls use the Radix-backed `Checkbox`, `Switch`, `RadioGroup`, or `SegmentedControl`.
- Loading, empty, error, and inline feedback use shared state components.
- Task-history rows communicate the active agent lifecycle at their trailing edge: the running task shows a reduced-motion-safe spinner, a completed run shows a green checkmark for five seconds, and idle tasks show no status indicator. These indicators retain accessible names.
- Navigation destinations expose `aria-current="page"` and use the same semantic active treatment.
- Every interactive descendant of an Electron drag region must establish `-webkit-app-region: no-drag` on its interactive wrapper.
- Fenced-code language badges are generated visually from `data-language`; they must not add text nodes to `<code>` or alter copied source.

## Shell and content geometry

Transcript rows and the composer use `w-full max-w-content` inside minimum viewport gutters. They grow to the 46rem content cap and shrink with the available Task column; do not derive both outer gutters and child width from the same fixed cap.

Files participates in the shell flex layout whenever at least 20rem remains for Task content with the expanded sidebar. It becomes an explicit right overlay only below that usable-width threshold. The toolbar fade and actions end at the reserved Files divider; overlay mode is a visible constrained-width layer rather than a hidden width reservation.

Only runtime structural values—pane widths, tree indentation, and transcript indicator counts—may use inline styles.
