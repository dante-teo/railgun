export const MIN_TRANSCRIPT_WIDTH = 640;
export const SHELL_HORIZONTAL_GUTTER = 16;

interface InspectorOverlayInput {
  readonly shellWidth: number;
  readonly sidebarVisible: boolean;
  readonly sidebarWidth: number;
  readonly inspectorWidth: number;
}

export const shouldOverlayInspector = ({
  shellWidth,
  sidebarVisible,
  sidebarWidth,
  inspectorWidth,
}: InspectorOverlayInput): boolean => {
  const sidebarReservation = sidebarVisible ? sidebarWidth + SHELL_HORIZONTAL_GUTTER : 0;
  return shellWidth - sidebarReservation - inspectorWidth < MIN_TRANSCRIPT_WIDTH;
};
