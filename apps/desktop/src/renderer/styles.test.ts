import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

type Hsl = readonly [hue: number, saturation: number, lightness: number];
type Rgb = readonly [red: number, green: number, blue: number];

const darkScheme = css.match(/@media \(prefers-color-scheme: dark\) \{[^{]*:root \{(?<rules>[\s\S]*?)\n  \}\n/u)?.groups?.rules ?? "";
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
    expect(css).toMatch(/\.sidebar-action\s*\{[^}]*color:\s*var\(--color-text\)/u);
    expect(contrastRatio(hslToken("color-tonal-action"), hslToken("material-tonal-action"))).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/prefers-color-scheme:\s*dark[\s\S]*--material-tonal-action-hover:\s*hsl\(154 12% 28%\)[\s\S]*--material-tonal-action-active:\s*hsl\(154 12% 31%\)/u);
  });

  it("reserves translucency for hierarchy surfaces and keeps content surfaces opaque", () => {
    expect(css).toMatch(/--material-toolbar:\s*linear-gradient\(to bottom,\s*hsl\(0 0% 100% \/ 0\.8[0-9]?\)[^;]*transparent 85%\)/u);
    expect(css).toMatch(/prefers-color-scheme:\s*dark[\s\S]*--material-toolbar:\s*linear-gradient\(to bottom,\s*hsl\(0 0% 0% \/ 0\.8[0-9]?\)[^;]*transparent 85%\)/u);
    expect(css).toMatch(/\.ui-card\s*\{[^}]*background:\s*var\(--material-content\)[^}]*\}/u);
    expect(css).not.toMatch(/\.ui-card\s*\{[^}]*backdrop-filter/u);
    expect(css).toMatch(/--material-popover:\s*hsl\(154 12% 94% \/ 0\.38\)/u);
    expect(css).toMatch(/prefers-color-scheme:\s*dark[\s\S]*--material-popover:\s*hsl\(0 0% 12% \/ 0\.72\)/u);
    expect(css).toMatch(/--material-sidebar:\s*hsl\(154 /u);
    expect(css).toMatch(/\.composer\s*\{[^}]*background:\s*var\(--material-content\)[^}]*\}/u);
    expect(css).toMatch(/\.shell-inspector\s*\{[^}]*width:\s*var\(--inspector-width\)[^}]*min-width:\s*var\(--inspector-width\)[^}]*height:\s*100%[^}]*display:\s*flex[^}]*padding:\s*calc\(var\(--titlebar-height\) \+ var\(--space-2\)\) var\(--space-4\) var\(--space-2\) 0[^}]*background:\s*transparent/u);
    expect(css).toMatch(/\.shell-workspace\s*\{[^}]*width:\s*var\(--workspace-width\)[^}]*min-width:\s*var\(--workspace-width\)[^}]*border-left:\s*1px solid var\(--color-border-strong\)/u);
    expect(css).toMatch(/\.activity-dashboard\s*\{[^}]*width:\s*100%[^}]*max-height:\s*calc\(100vh - var\(--titlebar-height\) - var\(--space-6\)\)[^}]*align-self:\s*flex-start[^}]*border:\s*1px solid var\(--color-border\)[^}]*border-radius:\s*var\(--radius-xl\)[^}]*background:\s*var\(--material-content\)[^}]*box-shadow:\s*var\(--shadow-popover\)[^}]*overflow:\s*auto[^}]*pointer-events:\s*auto/u);
    expect(css).not.toMatch(/\.activity-dashboard\s*\{[^}]*height:\s*100%/u);
    expect(css).toMatch(/\.activity-dashboard ol\s*\{[^}]*max-height:\s*min\(12rem, 24vh\)[^}]*overflow:\s*auto/u);
    expect(css).toMatch(/\.activity-dashboard li:last-child\s*\{[^}]*border-bottom:\s*0/u);
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
    expect(css).toMatch(/\.workspace-open \.content-toolbar::before\s*\{[^}]*right:\s*var\(--workspace-width\)/u);
    expect(css).not.toContain("--toolbar-shell-offset");
    expect(css).toMatch(/\.desktop-shell\s*\{[^}]*--toolbar-content-left:\s*var\(--space-7\)/u);
    const title = css.match(/\.content-toolbar-title\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";
    expect(title).not.toContain("position: absolute");
    expect(title).toContain("margin-left: var(--toolbar-content-left)");
    expect(css).toMatch(/\.content-toolbar-actions \.ui-button\s*\{[^}]*color:\s*var\(--color-text\)[^}]*background:\s*var\(--color-surface-control\)[^}]*box-shadow:\s*none[^}]*backdrop-filter:\s*none/u);
    expect(css).toMatch(/\.content-toolbar-actions \.ui-button:not\(:disabled\):hover\s*\{[^}]*transform:\s*none[^}]*box-shadow:\s*none/u);
    expect(css).not.toContain("--shadow-toolbar-control-hover");
    expect(css).toMatch(/\.content-toolbar-actions\s*\{[^}]*z-index:\s*var\(--layer-titlebar-control\)[^}]*-webkit-app-region:\s*no-drag/u);
    expect(css).toMatch(/\.activity-pane-toggle\[aria-pressed="true"\]\s*\{[^}]*color:\s*var\(--color-text\)[^}]*background:\s*var\(--color-surface-control-active\)/u);
    expect(css).toMatch(/\.right-pane-controls\s*\{[^}]*border-radius:\s*var\(--radius-pill\)[^}]*background:\s*var\(--color-surface-control\)[^}]*box-shadow:\s*none[^}]*backdrop-filter:\s*none/u);
    expect(css).toMatch(/\.right-pane-controls::after\s*\{[^}]*width:\s*1px[^}]*background:\s*var\(--color-border-strong\)/u);
    expect(css).toMatch(/\.ui-button-compact-icon\s*\{[^}]*width:\s*1\.5rem[^}]*height:\s*1\.5rem[^}]*border-radius:\s*var\(--radius-xs\)/u);
    expect(css).toMatch(/\.ui-button-sidebar-icon\s*\{[^}]*color:\s*var\(--color-text-secondary\)[^}]*background:\s*transparent[^}]*box-shadow:\s*none/u);
    expect(css).toMatch(/\.ui-button-sidebar-icon:not\(:disabled\):hover\s*\{[^}]*color:\s*var\(--color-text\)[^}]*background:\s*var\(--color-surface-control\)[^}]*box-shadow:\s*none/u);
    expect(css).toMatch(/\.collapsed-sidebar-controls\s*\{[^}]*left:\s*var\(--sidebar-toggle-left\)[^}]*border-radius:\s*var\(--radius-pill\)[^}]*background:\s*var\(--color-surface-control\)[^}]*box-shadow:\s*none[^}]*backdrop-filter:\s*none/u);
    expect(css).toMatch(/\.collapsed-sidebar-controls::after\s*\{[^}]*width:\s*1px[^}]*background:\s*var\(--color-border-strong\)/u);
    expect(css).toMatch(/\.collapsed-sidebar-controls > \.sidebar-toggle\s*\{[^}]*border-radius:\s*var\(--radius-pill\) 0 0 var\(--radius-pill\)/u);
    expect(css).toMatch(/\.collapsed-sidebar-action \.ui-button\s*\{[^}]*border-radius:\s*0 var\(--radius-pill\) var\(--radius-pill\) 0/u);
    expect(css).toMatch(/\.collapsed-sidebar-controls \.ui-button:not\(:disabled\):hover\s*\{[^}]*background:\s*var\(--color-menu-hover\)/u);
    expect(css).toMatch(/\.sidebar-action\s*\{[^}]*justify-content:\s*flex-start[^}]*width:\s*100%[^}]*min-height:\s*2\.25rem/u);
    expect(css).toMatch(/\.sidebar-footer\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center/u);
    expect(css).toMatch(/\.connection-dot\s*\{[^}]*border-radius:\s*50%/u);
    expect(css).toMatch(/\.ui-dialog-content\s*\{[^}]*background:\s*var\(--material-dialog\)[^}]*box-shadow:\s*var\(--shadow-dialog\)/u);
    expect(css).toMatch(/\.ui-dialog-footer\s*\{[^}]*justify-content:\s*flex-end/u);
    expect(css).not.toContain(".ui-popover-arrow");
    expect(css).toContain("transform-origin: var(--radix-dropdown-menu-content-transform-origin)");
  });

  it("renders dropdown with translucent popover surface and no arrow", () => {
    expect(css).toMatch(/\.ui-dropdown-content\s*\{[^}]*background:\s*var\(--material-popover\)/u);
    expect(css).not.toContain(".ui-popover-arrow");
  });

  it("uses a visibly translucent tinted surface for select and popover in light mode", () => {
    expect(css).toMatch(/--material-popover:\s*hsl\(154 12% 94% \/ 0\.38\)/u);
    expect(css).not.toMatch(/--material-popover:\s*hsl\(0 0% 100% \//u);
    expect(css).toMatch(/\.ui-select-content\s*\{[^}]*z-index:\s*var\(--layer-dialog-popover\)/u);
  });

  it("keeps Settings focus and helper treatments contained", () => {
    expect(css).not.toMatch(/\.settings-row:focus\s*\{/u);
    expect(css).toMatch(/\.mcp-form\s*\{[^}]*margin:\s*-6px[^}]*overflow:\s*auto[^}]*padding:\s*6px/u);
    expect(css).toMatch(/\.automation-preview\s*\{[^}]*margin-top:\s*var\(--space-2\)[^}]*padding:\s*var\(--space-1\) 0 0/u);
    expect(css).toMatch(/\.automation-field\s*\{[^}]*margin-top:\s*var\(--space-4\)/u);
    expect(css).toMatch(/\.automation-schedule-input\s*\{[^}]*font-family:\s*var\(--font-mono\)/u);
    expect(css).toMatch(/\.ui-field:disabled\s*\{[^}]*cursor:\s*not-allowed[^}]*opacity:\s*0\.52/u);
  });

  it("aligns forty-pixel titlebar controls to the traffic-light centerline", () => {
    expect(css).toContain("--titlebar-control-height: 2.5rem");
    expect(css).toMatch(/--titlebar-control-center-y:\s*calc\(var\(--traffic-light-top\) \+ \(var\(--traffic-light-size\) \/ 2\)\)/u);
    expect(css).toMatch(/\.sidebar-toggle\s*\{[^}]*width:\s*var\(--titlebar-control-height\)[^}]*min-height:\s*var\(--titlebar-control-height\)[^}]*height:\s*var\(--titlebar-control-height\)/u);
    expect(css).toMatch(/\.content-toolbar-actions > \.ui-button\s*\{[^}]*min-height:\s*var\(--titlebar-control-height\)/u);
    expect(css).toMatch(/\.right-pane-controls\s*\{[^}]*height:\s*var\(--titlebar-control-height\)/u);
    expect(css).toMatch(/\.files-header-actions \.ui-button\s*\{[^}]*min-height:\s*var\(--titlebar-control-height\)/u);
  });

  it("keeps titlebar controls flat", () => {
    expect(css).toMatch(/\.content-toolbar-actions \.ui-button\s*\{[^}]*background:\s*var\(--color-surface-control\)[^}]*box-shadow:\s*none[^}]*backdrop-filter:\s*none/u);
    expect(css).toMatch(/\.content-toolbar-actions \.ui-button:not\(:disabled\):active\s*\{[^}]*transform:\s*none[^}]*box-shadow:\s*none/u);
    expect(css).toMatch(/\.right-pane-controls\s*\{[^}]*background:\s*var\(--color-surface-control\)[^}]*box-shadow:\s*none[^}]*backdrop-filter:\s*none/u);
    expect(css).toMatch(/\.collapsed-sidebar-controls\s*\{[^}]*background:\s*var\(--color-surface-control\)[^}]*box-shadow:\s*none[^}]*backdrop-filter:\s*none/u);
    expect(css).not.toContain("--shadow-toolbar-control:");
    expect(css).not.toContain("--material-toolbar-control:");
  });

  it("uses current design tokens throughout Knowledge settings", () => {
    expect(css).not.toContain("var(--border)");
    expect(css).not.toContain("var(--input)");
    expect(css).not.toContain("var(--card)");
    expect(css).not.toContain("var(--muted-foreground)");
    expect(css).toMatch(/\.knowledge-controls\s*\{[^}]*margin-bottom:\s*var\(--space-4\)/u);
    expect(css).not.toContain(".knowledge-list li > div:last-child");
    expect(css).toMatch(/\.knowledge-row-actions\s*\{[^}]*display:\s*flex[^}]*gap:\s*var\(--space-1\)/u);
    expect(css).toMatch(
      /\.knowledge-search-row input,\s*\.notes-search input,\s*\.knowledge-modal input,\s*\.knowledge-modal textarea\s*\{[^}]*min-height:\s*var\(--control-height\)/u,
    );
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
    expect(css).toMatch(/\.transcript \[data-overlayscrollbars-viewport\]\s*\{[^}]*scrollbar-width:\s*none/u);
    expect(css).toMatch(/\.transcript \[data-overlayscrollbars-viewport\]::-webkit-scrollbar\s*\{[^}]*display:\s*none/u);
    expect(css).toMatch(/\.chat-surface > \.composer-wrap\s*\{[^}]*grid-area:\s*1 \/ 1[^}]*align-self:\s*end/u);
    expect(css).toMatch(/\.composer-wrap\s*\{[^}]*padding:[^;]*var\(--space-2\)/u);
    expect(css).toMatch(/\.composer-hint\s*\{[^}]*margin:\s*-1px auto 0[^}]*border:\s*1px solid var\(--color-border\)[^}]*border-top:\s*0[^}]*border-radius:\s*0 0 var\(--radius-sm\) var\(--radius-sm\)[^}]*background:\s*var\(--material-content\)/u);
  });

  it("reserves the todo side-car when wide and overlays it when constrained", () => {
    expect(css).toContain("--workspace-width: clamp(22.5rem, 42vw, 42rem)");
    expect(css).toMatch(/\.desktop-shell\.inspector-overlay \.shell-inspector\s*\{[^}]*position:\s*absolute[^}]*right:\s*var\(--space-4\)[^}]*height:\s*auto[^}]*padding:\s*0[^}]*pointer-events:\s*none/u);
    expect(css).toMatch(/\.desktop-shell\.inspector-overlay\.workspace-open \.shell-inspector\s*\{[^}]*right:\s*calc\(var\(--workspace-width\) \+ var\(--space-4\)\)/u);
    expect(css).toMatch(/\.files-split\s*\{[^}]*grid-template-columns:\s*minmax\(9rem, 34%\) minmax\(0, 1fr\)/u);
    expect(css).toMatch(/\.files-browser\s*\{[^}]*height:\s*100%[^}]*min-width:\s*0[^}]*\}/u);
    expect(css.match(/\.files-browser\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules).not.toContain("padding-top");
    expect(css).toMatch(/\.files-header\s*\{[^}]*padding:\s*calc\(var\(--titlebar-control-center-y\) - 0\.875rem\) var\(--space-3\) var\(--space-2\)/u);
    expect(css).toMatch(/\.files-header-actions\s*\{[^}]*z-index:\s*var\(--layer-titlebar-control\)[^}]*top:\s*var\(--titlebar-control-center-y\)[^}]*transform:\s*translateY\(-50%\)[^}]*-webkit-app-region:\s*no-drag/u);
    const workspace = css.match(/\.shell-workspace\s*\{(?<rules>[^}]*)\}/u)?.groups?.rules ?? "";
    expect(workspace).not.toContain("z-index");
    expect(css).toMatch(/\.files-header h2\s*\{[^}]*font-size:\s*0\.9375rem[^}]*font-weight:\s*var\(--weight-semibold\)/u);
    expect(css).not.toContain("@media (max-width: 76rem)");
    expect(css).not.toContain("@media (max-width: 60rem)");
  });

  it("stacks portalled selects above dialogs", () => {
    expect(css).toContain("--layer-dialog-popover: 62");
    expect(css).toMatch(/\.ui-select-content\s*\{[^}]*z-index:\s*var\(--layer-dialog-popover\)/u);
  });

  it("retains the failed-run danger presentation", () => {
    expect(css).toMatch(/\.run-error\s*\{[^}]*var\(--color-danger\)[^}]*\}/u);
  });

  it("separates the settings button from the session list with a full-width divider", () => {
    expect(css).toMatch(/\.sidebar-bottom-divider\s*\{[^}]*background:\s*var\(--color-border\)[^}]*\}/u);
    expect(css).not.toMatch(/\.sidebar-settings\s*\{[^}]*border-top:/u);
  });

  it("constrains the standalone knowledge page to viewport height for scrollable content", () => {
    expect(css).toMatch(/\.knowledge-page\s*\{[^}]*height:\s*100%/u);
    expect(css).not.toMatch(/\.knowledge-page\s*\{[^}]*min-height:\s*100vh/u);
  });

  it("wraps note search controls in the embedded settings column", () => {
    expect(css).toMatch(/\.knowledge-settings-content\s+\.notes-search[^{]*\{[^}]*flex-wrap:\s*wrap[^}]*align-items:\s*flex-start/u);
    expect(css).toMatch(/\.knowledge-settings-content\s+\.knowledge-search-controls[^{]*\{[^}]*flex:\s*1 1 100%[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto auto/u);
  });

  it("allows embedded knowledge content to shrink for scroll to work", () => {
    expect(css).toMatch(/\.knowledge-settings-content\s*\{[^}]*min-height:\s*0/u);
  });

  it("fixes the shared settings scroll chain so all pages scroll", () => {
    expect(css).toMatch(/\.settings-detail\s*\{[^}]*min-height:\s*0/u);
    expect(css).toMatch(/\.settings-detail-scroll\s*\{[^}]*min-height:\s*0/u);
  });

  it("separates adjacent settings cards", () => {
    expect(css).toMatch(/\.settings-group \+ \.settings-group\s*\{[^}]*margin-top:\s*var\(--space-3\)/u);
  });

  it("provides a visible hover background for ghost buttons", () => {
    const ghostHover = css.match(/\.ui-button-ghost:not\(:disabled\):hover\s*\{([^}]*)\}/u)?.[1] ?? "";
    expect(ghostHover).not.toContain("background: transparent");
    expect(ghostHover).toContain("background:");
  });

  it("provides a visible hover background for sidebar icon buttons", () => {
    const sidebarIconHover = css.match(/\.ui-button-sidebar-icon:not\(:disabled\):hover\s*\{([^}]*)\}/u)?.[1] ?? "";
    expect(sidebarIconHover).not.toContain("background: transparent");
    expect(sidebarIconHover).toContain("background:");
  });

  it("uses rounded-rect not oval for toolbar icon button hover frame", () => {
    expect(css).toMatch(/\.content-toolbar-actions\s+\.ui-button-icon\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/u);
  });

  it("uses a thin styled scrollbar on the sidebar scroll zone", () => {
    expect(css).toMatch(/\.sidebar-scroll\s*\{[^}]*scrollbar-width:\s*thin[^}]*\}/u);
    expect(css).toMatch(/\.sidebar-scroll\s*\{[^}]*scrollbar-color:\s*var\(--color-text-tertiary\)\s*transparent[^}]*\}/u);
    expect(css).toMatch(/\.sidebar-scroll::-webkit-scrollbar\s*\{[^}]*width:\s*4px[^}]*\}/u);
    expect(css).toMatch(/\.sidebar-scroll::-webkit-scrollbar-thumb\s*\{[^}]*var\(--color-text-tertiary\)[^}]*\}/u);
  });
});
