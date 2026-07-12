export interface Palette {
  readonly accent: string;
  readonly strong: string;
  readonly text: string;
  readonly muted: string;
  readonly dim: string;
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

export type ThemeMode = "dark" | "light";

export const palettes: Readonly<Record<ThemeMode, Palette>> = {
  dark: Object.freeze({
    accent: "#5EE6B8",
    strong: "#35D6A0",
    text: "#E6FFF7",
    muted: "#A6C9BD",
    dim: "#78988E",
    border: "#3F6F60",
    surface: "#14362C",
    selection: "#1E5A47",
    success: "#52D89C",
    warning: "#F4C95D",
    error: "#FF7B86",
    successSurface: "#123C2B",
    warningSurface: "#3E341A",
    errorSurface: "#421F26",
    statusSurface: "#153B30",
    codeSurface: "#102D26",
  }),
  light: Object.freeze({
    accent: "#087F5B",
    strong: "#056548",
    text: "#163C31",
    muted: "#486D61",
    dim: "#67877D",
    border: "#8ABDAC",
    surface: "#E7F7F1",
    selection: "#C9F1E3",
    success: "#087A52",
    warning: "#8A5A00",
    error: "#B42335",
    successSurface: "#DDF5E9",
    warningSurface: "#FFF3CC",
    errorSurface: "#FDE2E5",
    statusSurface: "#DDF3EA",
    codeSurface: "#EAF5F1",
  }),
} as const;

export const glyphs = {
  toolRunning: "⏺",
  toolDone: "✔",
  toolError: "✘",
  streamingCursor: "▌",
  todoChecked: "[x]",
  todoCancelled: "[-]",
  todoInProgress: "[>]",
  todoPending: "[ ]",
  unseenMessages: "↓",
} as const;
