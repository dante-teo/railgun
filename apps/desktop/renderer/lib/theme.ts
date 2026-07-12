export type { ThemeMode } from "@railgun/core/ui/palette.js";
export { glyphs } from "@railgun/core/ui/palette.js";

import type { ThemeMode } from "@railgun/core/ui/palette.js";

export const getInitialTheme = (): ThemeMode =>
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

export const applyTheme = (mode: ThemeMode): void => {
  if (mode === "dark") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", "light");
  }
};

export const subscribeThemeChanges = (callback: (mode: ThemeMode) => void): (() => void) => {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (e: MediaQueryListEvent): void => {
    callback(e.matches ? "dark" : "light");
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
};
