import { describe, expect, it, vi } from "vitest";
import { THEMES, ThemeController, supportsTerminalThemeEvents, themeForMode, type AppearanceAdapter, type TerminalThemeAdapter } from "./theme.js";

const terminal = (current: TerminalThemeAdapter["current"]): TerminalThemeAdapter => ({
  current,
  on: vi.fn(),
  off: vi.fn(),
  dispose: vi.fn(),
});

const appearance = (current: AppearanceAdapter["current"]): AppearanceAdapter => ({
  current,
  on: vi.fn().mockResolvedValue(undefined),
  off: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn().mockResolvedValue(undefined),
});

describe("mint themes", () => {
  it("defines the exact semantic dark palette", () => {
    expect(THEMES.dark).toMatchObject({
      mode: "dark", text: "#E6FFF7", muted: "#A6C9BD", dim: "#78988E",
      accent: "#5EE6B8", strong: "#35D6A0", border: "#3F6F60",
      surface: "#14362C", selection: "#1E5A47", success: "#52D89C",
      warning: "#F4C95D", error: "#FF7B86", successSurface: "#123C2B",
      warningSurface: "#3E341A", errorSurface: "#421F26", statusSurface: "#153B30",
      codeSurface: "#102D26",
    });
  });

  it("defines the exact semantic light palette", () => {
    expect(THEMES.light).toMatchObject({
      mode: "light", text: "#163C31", muted: "#486D61", dim: "#67877D",
      accent: "#087F5B", strong: "#056548", border: "#8ABDAC",
      surface: "#E7F7F1", selection: "#C9F1E3", success: "#087A52",
      warning: "#8A5A00", error: "#B42335", successSurface: "#DDF5E9",
      warningSurface: "#FFF3CC", errorSurface: "#FDE2E5", statusSurface: "#DDF3EA",
      codeSurface: "#EAF5F1",
    });
  });

  it("resolves immutable light and dark themes", () => {
    expect(themeForMode("light")).toBe(THEMES.light);
    expect(themeForMode("dark")).toBe(THEMES.dark);
    expect(Object.isFrozen(THEMES.light)).toBe(true);
  });
});

describe("ThemeController", () => {
  it("only probes live terminal notifications where Mode 2031 is expected", () => {
    expect(supportsTerminalThemeEvents({ TERM_PROGRAM: "ghostty" })).toBe(true);
    expect(supportsTerminalThemeEvents({ VTE_VERSION: "8200" })).toBe(true);
    expect(supportsTerminalThemeEvents({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
  });

  it("prefers the terminal over the OS and falls back to dark on failures", async () => {
    const os = appearance(vi.fn().mockResolvedValue("light"));
    const preferred = new ThemeController(terminal(vi.fn().mockResolvedValue("dark")), os);
    expect(await preferred.start()).toBe("dark");
    expect(os.current).not.toHaveBeenCalled();

    const failed = new ThemeController(terminal(vi.fn().mockRejectedValue(new Error("no tty"))), appearance(vi.fn().mockRejectedValue(new Error("no os"))));
    expect(await failed.start()).toBe("dark");
  });

  it("re-queries the terminal on OS events, deduplicates, and emits terminal events immediately", async () => {
    let terminalListener: ((mode: "dark" | "light") => void) | undefined;
    let osListener: ((mode: "dark" | "light") => void) | undefined;
    const tty = terminal(vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("dark").mockResolvedValueOnce(null));
    vi.mocked(tty.on).mockImplementation((_event, listener) => { terminalListener = listener; });
    const os = appearance(vi.fn().mockResolvedValue("light"));
    vi.mocked(os.on).mockImplementation(async (_event, listener) => { osListener = listener; });
    const controller = new ThemeController(tty, os);
    const observed: string[] = [];
    controller.subscribe(mode => observed.push(mode));
    expect(await controller.start()).toBe("light");

    osListener?.("dark");
    await vi.waitFor(() => expect(observed).toEqual(["dark"]));
    terminalListener?.("dark");
    expect(observed).toEqual(["dark"]);
    osListener?.("light");
    await vi.waitFor(() => expect(observed).toEqual(["dark", "light"]));
  });

  it("removes listeners and disposes both resources", async () => {
    const tty = terminal(vi.fn().mockResolvedValue(null));
    const os = appearance(vi.fn().mockResolvedValue("light"));
    const controller = new ThemeController(tty, os);
    await controller.start();
    await controller.dispose();
    expect(tty.off).toHaveBeenCalledOnce();
    expect(os.off).toHaveBeenCalledOnce();
    expect(tty.dispose).toHaveBeenCalledOnce();
    expect(os.dispose).toHaveBeenCalledOnce();
  });
});
