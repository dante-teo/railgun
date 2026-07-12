import { palettes, glyphs, type ThemeMode } from "./palette.js";

export { type ThemeMode } from "./palette.js";

export const rgb = (hex: string, background = false): string => {
  const [red, green, blue] = [1, 3, 5].map(offset =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
  return `\u001b[${background ? 48 : 38};2;${red};${green};${blue}m`;
};

const RESET = "\u001b[0m";

const style =
  (hex: string) =>
  (s: string): string =>
    `${rgb(hex)}${s}${RESET}`;

const bgStyle =
  (hex: string) =>
  (s: string): string =>
    `${rgb(hex, true)}${s}${RESET}`;

export type ToolCallState = "running" | "done" | "error";

export interface AnsiTheme {
  readonly mode: ThemeMode;
  readonly accent: (s: string) => string;
  readonly strong: (s: string) => string;
  readonly text: (s: string) => string;
  readonly muted: (s: string) => string;
  readonly dim: (s: string) => string;
  readonly error: (s: string) => string;
  readonly success: (s: string) => string;
  readonly warning: (s: string) => string;
  readonly bgSurface: (s: string) => string;
  readonly bgStatus: (s: string) => string;
  readonly bgCode: (s: string) => string;
  readonly toolCallLabel: (name: string, state: ToolCallState) => string;
  readonly toolCallPrefix: (state: ToolCallState) => string;
  readonly streamingCursor: () => string;
  readonly thinkingIndicator: () => string;
  readonly unseenPill: () => string;
}

export const createAnsiTheme = (mode: ThemeMode = "dark"): AnsiTheme => {
  const p = palettes[mode];
  const t: AnsiTheme = {
    mode,
    accent: style(p.accent),
    strong: style(p.strong),
    text: style(p.text),
    muted: style(p.muted),
    dim: style(p.dim),
    error: style(p.error),
    success: style(p.success),
    warning: style(p.warning),
    bgSurface: bgStyle(p.surface),
    bgStatus: bgStyle(p.statusSurface),
    bgCode: bgStyle(p.codeSurface),
    toolCallLabel: (name: string, state: ToolCallState): string => {
      const body = `${name}(...)`;
      if (state === "running") return t.dim(`${glyphs.toolRunning} Running ${body}...`);
      if (state === "error") return t.error(`${glyphs.toolError} ${body} failed`);
      return t.dim(`${glyphs.toolDone} ${body} done`);
    },
    toolCallPrefix: (state: ToolCallState): string => {
      if (state === "running") return t.dim(glyphs.toolRunning);
      if (state === "error") return t.error(glyphs.toolError);
      return t.success(glyphs.toolDone);
    },
    streamingCursor: () => t.accent(glyphs.streamingCursor),
    thinkingIndicator: () => t.dim("Thinking..."),
    unseenPill: () => t.accent(`${glyphs.unseenMessages} new messages`),
  };
  return t;
};
