export const MIN_TRANSCRIPT_WIDTH = 640;
export const MIN_TRANSCRIPT_WITH_WORKSPACE = 320;
export const SHELL_HORIZONTAL_GUTTER = 16;
export const WORKSPACE_WIDTH = Object.freeze({ min: 360, ratio: 0.42, max: 672 });
export type InspectorLayoutMode = "reserved" | "overlay";

export const shouldOverlayWorkspace = (shellWidth: number, sidebarVisible: boolean, sidebarWidth: number): boolean => {
  const sidebarReservation = sidebarVisible ? sidebarWidth + SHELL_HORIZONTAL_GUTTER : 0;
  return shellWidth - sidebarReservation - workspaceWidth(shellWidth) < MIN_TRANSCRIPT_WITH_WORKSPACE;
};

interface InspectorOverlayInput {
  readonly shellWidth: number;
  readonly sidebarVisible: boolean;
  readonly sidebarWidth: number;
  readonly inspectorWidth: number;
  readonly workspaceVisible: boolean;
}

const workspaceWidth = (shellWidth: number): number => Math.min(
  WORKSPACE_WIDTH.max,
  Math.max(WORKSPACE_WIDTH.min, shellWidth * WORKSPACE_WIDTH.ratio),
);

export const shouldOverlayInspector = ({
  shellWidth,
  sidebarVisible,
  sidebarWidth,
  inspectorWidth,
  workspaceVisible,
}: InspectorOverlayInput): boolean => {
  const sidebarReservation = sidebarVisible ? sidebarWidth + SHELL_HORIZONTAL_GUTTER : 0;
  const workspaceReservation = workspaceVisible ? workspaceWidth(shellWidth) : 0;
  return shellWidth - sidebarReservation - workspaceReservation - inspectorWidth < MIN_TRANSCRIPT_WIDTH;
};
