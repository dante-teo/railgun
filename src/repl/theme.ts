import { appearance, terminal } from "os-theme";

export type ThemeMode = "dark" | "light";

export interface Theme {
  readonly mode: ThemeMode;
  readonly text: string;
  readonly muted: string;
  readonly dim: string;
  readonly accent: string;
  readonly strong: string;
  readonly border: string;
  readonly surface: string;
  readonly selection: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly successSurface: string;
  readonly warningSurface: string;
  readonly errorSurface: string;
  readonly statusSurface: string;
  readonly codeSurface: string;
}

const freezeTheme = (theme: Theme): Theme => Object.freeze(theme);

export const THEMES: Readonly<Record<ThemeMode, Theme>> = Object.freeze({
  dark: freezeTheme({
    mode: "dark", text: "#E6FFF7", muted: "#A6C9BD", dim: "#78988E",
    accent: "#5EE6B8", strong: "#35D6A0", border: "#3F6F60",
    surface: "#14362C", selection: "#1E5A47", success: "#52D89C",
    warning: "#F4C95D", error: "#FF7B86", successSurface: "#123C2B",
    warningSurface: "#3E341A", errorSurface: "#421F26", statusSurface: "#153B30",
    codeSurface: "#102D26",
  }),
  light: freezeTheme({
    mode: "light", text: "#163C31", muted: "#486D61", dim: "#67877D",
    accent: "#087F5B", strong: "#056548", border: "#8ABDAC",
    surface: "#E7F7F1", selection: "#C9F1E3", success: "#087A52",
    warning: "#8A5A00", error: "#B42335", successSurface: "#DDF5E9",
    warningSurface: "#FFF3CC", errorSurface: "#FDE2E5", statusSurface: "#DDF3EA",
    codeSurface: "#EAF5F1",
  }),
});

export const themeForMode = (mode: ThemeMode): Theme => THEMES[mode];

type ThemeListener = (mode: ThemeMode) => void;

export interface TerminalThemeAdapter {
  current(): Promise<ThemeMode | null>;
  on(event: "change", listener: ThemeListener): void;
  off(event: "change", listener: ThemeListener): void;
  dispose(): void;
}

export interface AppearanceAdapter {
  current(): Promise<ThemeMode>;
  on(event: "change", listener: ThemeListener): Promise<void>;
  off(event: "change", listener: ThemeListener): Promise<void>;
  dispose(): Promise<void>;
}

export const supportsTerminalThemeEvents = (environment: Readonly<Record<string, string | undefined>>): boolean => {
  const term = environment["TERM"] ?? "";
  const program = (environment["TERM_PROGRAM"] ?? "").toLowerCase();
  return environment["KITTY_WINDOW_ID"] !== undefined
    || environment["VTE_VERSION"] !== undefined
    || term === "xterm-kitty"
    || program === "ghostty"
    || program === "contour";
};

const defaultTerminalAdapter = (): TerminalThemeAdapter => {
  const liveEvents = supportsTerminalThemeEvents(process.env);
  return {
    current: () => terminal.current(),
    on: (event, listener) => { if (liveEvents) terminal.on(event, listener); },
    off: (event, listener) => { if (liveEvents) terminal.off(event, listener); },
    dispose: () => { if (liveEvents) terminal.dispose(); },
  };
};

const safely = async <T>(operation: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await operation();
  } catch {
    return fallback;
  }
};

export class ThemeController {
  readonly #terminal: TerminalThemeAdapter;
  readonly #appearance: AppearanceAdapter;
  readonly #subscribers = new Set<ThemeListener>();
  #mode: ThemeMode | undefined;
  #started = false;
  #disposed = false;

  readonly #onTerminalChange = (mode: ThemeMode): void => this.#update(mode);
  readonly #onAppearanceChange = (mode: ThemeMode): void => {
    void safely(() => this.#terminal.current(), null).then(terminalMode => {
      if (!this.#disposed) this.#update(terminalMode ?? mode);
    });
  };

  constructor(
    terminalAdapter: TerminalThemeAdapter = defaultTerminalAdapter(),
    appearanceAdapter: AppearanceAdapter = appearance,
  ) {
    this.#terminal = terminalAdapter;
    this.#appearance = appearanceAdapter;
  }

  subscribe(listener: ThemeListener): () => void {
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  async start(): Promise<ThemeMode> {
    if (this.#started) return this.#mode ?? "dark";
    this.#started = true;
    const terminalMode = await safely(() => this.#terminal.current(), null);
    const initial = terminalMode ?? await safely(() => this.#appearance.current(), "dark");
    this.#mode = initial;
    if (!this.#disposed) {
      this.#terminal.on("change", this.#onTerminalChange);
      await safely(() => this.#appearance.on("change", this.#onAppearanceChange), undefined);
    }
    return initial;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#subscribers.clear();
    this.#terminal.off("change", this.#onTerminalChange);
    await safely(() => this.#appearance.off("change", this.#onAppearanceChange), undefined);
    this.#terminal.dispose();
    await safely(() => this.#appearance.dispose(), undefined);
  }

  #update(mode: ThemeMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#subscribers.forEach(listener => listener(mode));
  }
}
