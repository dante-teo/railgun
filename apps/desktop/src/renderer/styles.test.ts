import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");
type Hsl = readonly [number, number, number];

const schemeRules = (dark: boolean): string => dark
  ? css.match(/@media \(prefers-color-scheme: dark\) \{[\s\S]*?:root \{(?<rules>[\s\S]*?)\n  \}/u)?.groups?.rules ?? ""
  : css.match(/:root \{(?<rules>[\s\S]*?)\n\}/u)?.groups?.rules ?? "";
const token = (rules: string, name: string): Hsl => {
  const value = rules.match(new RegExp(`--${name}:\\s*hsl\\((\\d+) (\\d+)% (\\d+)%`, "u"));
  if (value === null) throw new Error(`Missing HSL token ${name}`);
  return value.slice(1, 4).map(Number) as unknown as Hsl;
};
const remToken = (name: string): number => {
  const value = css.match(new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)rem`, "u"));
  if (value === null) throw new Error(`Missing rem token ${name}`);
  return Number(value[1]);
};
const luminance = ([hue, saturationPercent, lightnessPercent]: Hsl): number => {
  const saturation = saturationPercent / 100;
  const lightness = lightnessPercent / 100;
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  const channel = (offset: number): number => {
    const position = (offset + hue / 30) % 12;
    const linear = lightness - amplitude * Math.max(-1, Math.min(position - 3, 9 - position, 1));
    return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * channel(0)) + (0.7152 * channel(8)) + (0.0722 * channel(4));
};
const contrast = (a: Hsl, b: Hsl): number => {
  const values = [luminance(a), luminance(b)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
};

describe("Tailwind design tokens", () => {
  it("publishes the semantic catalog through Tailwind v4", () => {
    expect(css.startsWith('@import "tailwindcss";')).toBe(true);
    for (const name of ["background", "surface", "foreground-secondary", "primary", "secondary", "destructive", "success", "warning", "info", "border", "focus"]) {
      expect(css).toContain(`--color-${name}:`);
    }
    for (const name of ["text-caption", "radius-xl", "spacing-control", "shadow-dialog", "duration-fast", "breakpoint-compact"]) {
      expect(css).toContain(`--${name}:`);
    }
    for (const weight of ["medium", "semibold", "bold"]) {
      expect(css).toContain(`--font-weight-${weight}: var(--weight-${weight});`);
    }
    expect(css).not.toContain("@apply");
    expect(css).not.toMatch(/\.ui-/u);
    const customSelectors = css.split("\n").filter(line => line.startsWith("."));
    expect(customSelectors.every(line => line.startsWith(".transcript"))).toBe(true);
  });

  it.each([false, true])("meets text and action contrast in the %s scheme", dark => {
    const rules = schemeRules(dark);
    const canvas = token(rules, "color-canvas");
    const surface = token(rules, "color-surface-content");
    const onAccent = token(rules, "color-on-accent");
    for (const foreground of ["color-text", "color-text-secondary", "color-text-tertiary", "color-danger", "color-warning", "color-success"]) {
      expect(contrast(token(rules, foreground), surface), foreground).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(token(rules, "color-text"), canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(onAccent, token(rules, "color-accent"))).toBeGreaterThanOrEqual(4.5);
    for (const [foreground, background] of [
      ["color-text-secondary", "color-surface-muted"],
      ["color-success", "color-success-soft"],
      ["color-warning", "color-warning-soft"],
      ["color-danger", "color-danger-soft"],
      ["color-info", "color-info-soft"],
    ] as const) {
      expect(contrast(token(rules, foreground), token(rules, background)), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("preserves liquid glass with accessibility fallbacks", () => {
    expect(css).toContain("--material-sidebar:");
    expect(css).toContain("--material-toolbar: linear-gradient");
    expect(css).toContain("--material-popover:");
    expect(css).toContain("--material-dialog:");
    expect(css).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(css).toMatch(/prefers-reduced-transparency:[\s\S]*\[data-glass-surface\][^}]*backdrop-filter:\s*none/u);
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (prefers-contrast: more)");
  });

  it("layers a full-width toolbar material beneath the sidebar and its actions above the drag region", () => {
    expect(css).toContain("--layer-toolbar-material: 5");
    expect(css).toContain("--layer-titlebar-action: 22");
    expect(css).toContain("--titlebar-actions-safe-width: 13rem");
    expect(css).not.toContain(".content-toolbar::before");
  });

  it("keeps the desktop floor and Tailwind responsive breakpoints", () => {
    expect(css).toContain("--container-content: 46rem");
    expect(css).not.toContain("--content-width:");
    expect(css).toContain("--transcript-bottom-inset: 11rem");
    expect(remToken("window-min-width")).toBe(47.5);
    expect(remToken("window-min-height")).toBe(32.5);
    expect(remToken("breakpoint-compact")).toBeGreaterThan(remToken("window-min-width"));
    expect(remToken("breakpoint-wide")).toBeGreaterThan(remToken("breakpoint-compact"));
    expect(css).toContain("OverlayScrollbars internals cannot be expressed on a React element");
  });

  it("allows the dedicated update-check surface below the main window floor", () => {
    expect(css).toContain('html[data-renderer-surface="update-check"]');
    expect(css).toMatch(/data-renderer-surface="update-check"[^}]*min-width:\s*0;\s*min-height:\s*0/u);
  });
});
