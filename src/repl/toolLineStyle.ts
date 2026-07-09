import type { SkinConfig } from "../skins.js";

export const toolLineIcon = (failed: boolean): string =>
  failed ? "✘" : "✔";

export const toolLineColor = (skin: SkinConfig, failed: boolean): string =>
  failed ? skin.colors.error : skin.colors.success;

export const busyColor = (skin: SkinConfig): string =>
  skin.colors.accent;

export const busySpinnerType = (): "dots2" =>
  "dots2";

export const approvalColor = (skin: SkinConfig): string =>
  skin.colors.accent;

export const selectedItemStyle = (skin: SkinConfig): { color: string; backgroundColor: string } => ({
  color: skin.colors.accent,
  backgroundColor: skin.colors.selectedBg,
});

export const unselectedItemColor = (skin: SkinConfig): string =>
  skin.colors.dim;

export type ToolFrameState = "pending" | "success" | "error";

export const toolFrameBg = (skin: SkinConfig, state: ToolFrameState): string =>
  state === "pending" ? skin.colors.toolPendingBg
  : state === "success" ? skin.colors.toolSuccessBg
  : skin.colors.toolErrorBg;

export const toolFrameBorder = (skin: SkinConfig, state: ToolFrameState): string =>
  state === "pending" ? skin.colors.border
  : state === "success" ? skin.colors.success
  : skin.colors.error;
