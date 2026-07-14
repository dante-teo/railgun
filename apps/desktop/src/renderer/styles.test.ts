import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

type Hsl = readonly [hue: number, saturation: number, lightness: number];
type Rgb = readonly [red: number, green: number, blue: number];

const darkScheme = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{(?<rules>[\s\S]*?)\n  \}\n\}/u)?.groups?.rules ?? "";
const hslToken = (name: string): Hsl => {
  const match = darkScheme.match(new RegExp(`--${name}:\\s*hsl\\((\\d+) (\\d+)% (\\d+)%\\)`, "u"));
  if (match === null) throw new Error(`Missing dark color token: ${name}`);
  return match.slice(1, 4).map(Number) as unknown as Hsl;
};
const hslToRgb = ([hue, saturationPercent, lightnessPercent]: Hsl): Rgb => {
  const saturation = saturationPercent / 100;
  const lightness = lightnessPercent / 100;
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  const channel = (offset: number): number => {
    const position = (offset + hue / 30) % 12;
    return lightness - amplitude * Math.max(-1, Math.min(position - 3, 9 - position, 1));
  };
  return [channel(0), channel(8), channel(4)];
};
const relativeLuminance = (rgb: Rgb): number => rgb
  .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  .reduce((sum, channel, index) => sum + channel * ([0.2126, 0.7152, 0.0722] as const)[index]!, 0);
const contrastRatio = (foreground: Hsl, background: Hsl): number => {
  const luminances = [foreground, background].map(color => relativeLuminance(hslToRgb(color)));
  return (Math.max(...luminances) + 0.05) / (Math.min(...luminances) + 0.05);
};

describe("desktop activity styles", () => {
  it("uses the four Apple-style button treatments outside the toolbar", () => {
    const base = css.match(/\.ui-button\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";
    const primary = css.match(/\.ui-button-primary\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";
    const tonal = css.match(/\.ui-button-tonal\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";
    const tonalHover = css.match(/\.ui-button-tonal:not\(:disabled\):hover\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";
    const tonalActive = css.match(/\.ui-button-tonal:not\(:disabled\):active\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";
    const ghost = css.match(/\.ui-button-ghost\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";
    const destructive = css.match(/\.ui-button-destructive\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";
    const capsule = css.match(/\.ui-button-capsule\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";

    expect(base).toContain("border-radius: var(--radius-pill)");
    expect(base).toContain("box-shadow: none");
    expect(primary).toContain("color: var(--color-on-accent)");
    expect(primary).toContain("background: var(--color-accent)");
    expect(tonal).toContain("color: var(--color-tonal-action)");
    expect(tonal).toContain("background: var(--material-tonal-action)");
    expect(tonalHover).toContain("background: var(--material-tonal-action-hover)");
    expect(tonalActive).toContain("background: var(--material-tonal-action-active)");
    expect(ghost).toContain("color: var(--color-accent)");
    expect(ghost).toContain("background: transparent");
    expect(capsule).toContain("color: var(--color-accent)");
    expect(capsule).toContain("background: var(--material-control)");
    const ordinaryButtons = [primary, tonal, ghost, destructive, capsule];
    expect(ordinaryButtons.every(rules => !rules.includes("backdrop-filter"))).toBe(true);
    expect(css).not.toContain(".ui-button-glass");
    expect(css).not.toMatch(/\.ui-button-group \.ui-button\s*\{[^}]*border-radius/u);
    expect(css).toMatch(/nav \.ui-button\s*\{[^}]*color:\s*var\(--color-text\)/u);
    expect(contrastRatio(hslToken("color-tonal-action"), hslToken("material-tonal-action"))).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/prefers-color-scheme:\s*dark[\s\S]*--material-tonal-action-hover:\s*hsl\(154 12% 28%\)[\s\S]*--material-tonal-action-active:\s*hsl\(154 12% 31%\)/u);
  });

  it("reserves translucency for hierarchy surfaces and keeps content surfaces opaque", () => {
    expect(css).toMatch(/--material-toolbar:\s*linear-gradient\(to bottom,\s*hsl\(0 0% 100% \/ 0\.8[0-9]?\)[^;]*transparent 85%\)/u);
    expect(css).toMatch(/prefers-color-scheme:\s*dark[\s\S]*--material-toolbar:\s*linear-gradient\(to bottom,\s*hsl\(0 0% 0% \/ 0\.8[0-9]?\)[^;]*transparent 85%\)/u);
    expect(css).toMatch(/\.ui-card\s*\{[^}]*background:\s*var\(--material-content\)[^}]*\}/u);
    expect(css).not.toMatch(/\.ui-card\s*\{[^}]*backdrop-filter/u);
    expect(css).toMatch(/\.composer\s*\{[^}]*background:\s*var\(--material-content\)[^}]*\}/u);
  });

  it("uses dense dialog and anchored popover recipes with a blurred seamless toolbar", () => {
    const toolbar = css.match(/\.content-toolbar\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";
    expect(toolbar).not.toContain("border");
    expect(toolbar).toContain("display: flex");
    expect(toolbar).toContain("min-height: 0");
    expect(toolbar).toContain("width: 100%");
    expect(toolbar).not.toContain("margin-left");
    expect(toolbar).toContain("z-index: calc(var(--layer-sidebar) - 1)");
    expect(toolbar).toContain("background: transparent");
    expect(toolbar).not.toContain("backdrop-filter");
    expect(css).toMatch(/\.content-toolbar::before\s*\{[^}]*position:\s*fixed[^}]*top:\s*0[^}]*right:\s*0[^}]*left:\s*0[^}]*height:\s*var\(--toolbar-surface-height\)[^}]*background:\s*var\(--material-toolbar\)[^}]*backdrop-filter:\s*var\(--material-blur-toolbar\)[^}]*mask-image:\s*linear-gradient/u);
    expect(css).not.toContain("--toolbar-shell-offset");
    expect(css).toMatch(/\.desktop-shell\s*\{[^}]*--toolbar-content-left:\s*var\(--space-7\)/u);
    const title = css.match(/\.content-toolbar-title\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";
    expect(title).not.toContain("position: absolute");
    expect(title).toContain("margin-left: var(--toolbar-content-left)");
    expect(css).toMatch(/\.content-toolbar-actions \.ui-button, \.sidebar-collapsed \.sidebar-toggle\s*\{[^}]*color:\s*var\(--color-text\)[^}]*background:\s*var\(--material-toolbar-control\)[^}]*box-shadow:\s*var\(--shadow-toolbar-control\)[^}]*backdrop-filter:\s*var\(--material-blur-control\)/u);
    expect(css).toMatch(/\.content-toolbar-actions \.ui-button:not\(:disabled\):hover\s*\{[^}]*transform:\s*translateY\(-1px\) scale\(1\.025\)[^}]*box-shadow:\s*var\(--shadow-toolbar-control-hover\)/u);
    expect(css).toMatch(/\.sidebar-collapsed \.sidebar-toggle:not\(:disabled\):hover\s*\{[^}]*transform:\s*translateY\(-50%\) scale\(1\.04\)/u);
    expect(css).toMatch(/\.desktop-shell:not\(\.sidebar-collapsed\) \.sidebar-toggle\s*\{[^}]*border-color:\s*transparent[^}]*color:\s*var\(--color-text\)[^}]*background:\s*transparent[^}]*box-shadow:\s*none/u);
    expect(css).toMatch(/\.desktop-shell:not\(\.sidebar-collapsed\) \.sidebar-toggle:not\(:disabled\):hover\s*\{[^}]*border-color:\s*transparent[^}]*background:\s*var\(--material-sidebar-control-hover\)[^}]*transform:\s*translateY\(-50%\) scale\(1\.04\)[^}]*box-shadow:\s*var\(--shadow-sidebar-control-hover\)/u);
    expect(css).toMatch(/\.ui-dialog-content\s*\{[^}]*background:\s*var\(--material-dialog\)[^}]*box-shadow:\s*var\(--shadow-dialog\)/u);
    expect(css).toMatch(/\.ui-dialog-footer\s*\{[^}]*justify-content:\s*flex-end/u);
    expect(css).toMatch(/\.ui-popover-arrow\s*\{[^}]*fill:\s*var\(--material-popover\)/u);
    expect(css).toContain("transform-origin: var(--radix-dropdown-menu-content-transform-origin)");
  });

  it("preserves accessibility fallbacks for transparency, contrast, and motion", () => {
    expect(css).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(css).toContain("@media (prefers-contrast: more)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]*\.ui-popover[^}]*animation:\s*none/u);
  });

  it("uses one full-height chat canvas with floating top and bottom chrome", () => {
    expect(css).toMatch(/\.chat-surface\s*\{[^}]*position:\s*relative[^}]*display:\s*grid[^}]*overflow:\s*hidden/u);
    expect(css).toMatch(/\.chat-surface > \.transcript-stage\s*\{[^}]*position:\s*relative[^}]*grid-area:\s*1 \/ 1[^}]*height:\s*100%/u);
    expect(css).toMatch(/\.chat-surface > \.shell-error\s*\{[^}]*z-index:\s*3[^}]*grid-area:\s*1 \/ 1[^}]*align-self:\s*start[^}]*margin-top:\s*var\(--transcript-top-inset\)[^}]*margin-left:\s*max\(calc\(var\(--active-sidebar-inset\) \+ var\(--space-7\)\), calc\(\(100% - var\(--content-width\)\) \/ 2\)\)/u);
    expect(css).toMatch(/\.transcript-content\s*\{[^}]*min-height:\s*100%[^}]*padding-top:\s*var\(--transcript-top-inset\)[^}]*padding-bottom:\s*var\(--transcript-bottom-inset\)/u);
    expect(css).toContain("--transcript-indicator-max-height: 30rem");
    expect(css).not.toContain("--transcript-scrollbar-max-height");
    expect(css).toMatch(/\.transcript-scroll-indicator\s*\{[^}]*position:\s*absolute[^}]*top:\s*50%[^}]*height:\s*min\(var\(--transcript-indicator-max-height\), 42vh, calc\(var\(--transcript-indicator-dash-count\) \* var\(--space-5\)\)\)[^}]*grid-auto-rows:\s*1fr[^}]*transform:\s*translateY\(-50%\)/u);
    expect(css).toMatch(/\.transcript-scroll-indicator span\s*\{[^}]*background:\s*var\(--color-transcript-dash-muted\)/u);
    expect(css).toMatch(/\.transcript-scroll-indicator span\.active\s*\{[^}]*background:\s*var\(--color-transcript-dash-active\)/u);
    expect(css).toMatch(/\.transcript > \.os-scrollbar\s*\{[^}]*display:\s*none/u);
    expect(css).toMatch(/\.chat-surface > \.composer-wrap\s*\{[^}]*grid-area:\s*1 \/ 1[^}]*align-self:\s*end/u);
    expect(css).toMatch(/\.composer-wrap\s*\{[^}]*padding:[^;]*var\(--space-2\)/u);
    expect(css).toMatch(/\.composer-hint\s*\{[^}]*margin:\s*-1px auto 0[^}]*border:\s*1px solid var\(--color-border\)[^}]*border-top:\s*0[^}]*border-radius:\s*0 0 var\(--radius-sm\) var\(--radius-sm\)[^}]*background:\s*var\(--material-content\)/u);
  });

  it("stacks portalled selects above dialogs", () => {
    expect(css).toContain("--layer-dialog-popover: 62");
    expect(css).toMatch(/\.ui-select-content\s*\{[^}]*z-index:\s*var\(--layer-dialog-popover\)/u);
  });

  it("retains the failed-run danger presentation", () => {
    expect(css).toMatch(/\.run-error\s*\{[^}]*var\(--color-danger\)[^}]*\}/u);
  });
});
