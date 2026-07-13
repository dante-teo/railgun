import type { Theme } from "./theme.js";

export const toolLineIcon = (failed: boolean): string =>
  failed ? "✘" : "✔";

export const toolLineColor = (theme: Theme, failed: boolean): string =>
  failed ? theme.error : theme.success;

export const busyColor = (theme: Theme): string => theme.accent;

export const busySpinnerType = (): "dots2" =>
  "dots2";

export const approvalColor = (theme: Theme): string => theme.accent;

export const selectedItemStyle = (theme: Theme): { color: string; backgroundColor: string } => ({
  color: theme.accent,
  backgroundColor: theme.selection,
});

export const unselectedItemColor = (theme: Theme): string => theme.dim;

export type ToolFrameState = "pending" | "success" | "error";

export const toolFrameBg = (theme: Theme, state: ToolFrameState): string =>
  state === "pending" ? theme.warningSurface
  : state === "success" ? theme.successSurface
  : theme.errorSurface;

export const toolFrameBorder = (theme: Theme, state: ToolFrameState): string =>
  state === "pending" ? theme.border
  : state === "success" ? theme.success
  : theme.error;

export const shouldAppendToolTranscriptLine = (name: string): boolean => name !== "todo";
export const shouldShowToolLine = (name: string, isError: boolean): boolean =>
  shouldAppendToolTranscriptLine(name) || isError;
