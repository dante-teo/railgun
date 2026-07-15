import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { Button } from "../components/ui/button";
import { shouldOverlayInspector } from "./inspectorLayout";
import type { InspectorLayoutMode } from "./inspectorLayout";
import { clampPaneWidth, PANE_WIDTHS, readPaneWidths, writePaneWidths } from "./paneStorage";

export interface ShellLayoutProps {
  readonly sidebar: ReactNode;
  readonly sidebarAction?: ReactNode;
  readonly collapsedSidebarAction?: ReactNode;
  readonly main: ReactNode;
  readonly mainAction?: ReactNode;
  readonly inspector?: ReactNode;
  readonly inspectorLabel?: string;
  readonly workspace?: ReactNode;
  readonly sidebarVisible: boolean;
  readonly inspectorVisible?: boolean;
  readonly workspaceVisible?: boolean;
  readonly onSidebarVisibilityChange: (visible: boolean) => void;
  readonly onInspectorLayoutModeChange?: (mode: InspectorLayoutMode) => void;
}

interface ResizeStart {
  readonly x: number;
  readonly width: number;
}

interface SidebarSeparatorProps {
  readonly width: number;
  readonly onWidthChange: (width: number) => void;
}

const sidebarKeyWidth = (width: number, event: KeyboardEvent): number | undefined => {
  if (event.key === "ArrowLeft") return width - 10;
  if (event.key === "ArrowRight") return width + 10;
  if (event.key === "Home") return PANE_WIDTHS.sidebar.min;
  if (event.key === "End") return PANE_WIDTHS.sidebar.max;
  return undefined;
};

const SidebarSeparator = ({ width, onWidthChange }: SidebarSeparatorProps): React.JSX.Element => {
  const drag = useRef<ResizeStart | undefined>(undefined);
  const range = PANE_WIDTHS.sidebar;
  const updateWidth = (next: number): void => onWidthChange(clampPaneWidth("sidebar", next));

  return <div
    className="pane-separator sidebar-separator"
    role="separator"
    aria-label="Resize sidebar"
    aria-orientation="vertical"
    aria-valuemin={range.min}
    aria-valuemax={range.max}
    aria-valuenow={width}
    tabIndex={0}
    onDoubleClick={() => updateWidth(range.default)}
    onKeyDown={(event) => {
      const next = sidebarKeyWidth(width, event);
      if (next === undefined) return;
      event.preventDefault();
      updateWidth(next);
    }}
    onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
      drag.current = { x: event.clientX, width };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
      if (drag.current === undefined) return;
      const delta = event.clientX - drag.current.x;
      updateWidth(drag.current.width + delta);
    }}
    onPointerUp={() => { drag.current = undefined; }}
    onPointerCancel={() => { drag.current = undefined; }}
    onLostPointerCapture={() => { drag.current = undefined; }}
  />;
};

export const ShellLayout = ({
  sidebar,
  sidebarAction,
  collapsedSidebarAction,
  main,
  mainAction,
  inspector,
  inspectorLabel = "Inspector",
  workspace,
  sidebarVisible,
  inspectorVisible = inspector !== undefined,
  workspaceVisible = workspace !== undefined,
  onSidebarVisibilityChange,
  onInspectorLayoutModeChange,
}: ShellLayoutProps): React.JSX.Element => {
  const [widths, setWidths] = useState(() => readPaneWidths(window.localStorage));
  const [shellWidth, setShellWidth] = useState<number>();
  const shellRef = useRef<HTMLElement>(null);
  const hasWorkspace = workspace !== undefined && workspaceVisible;
  const inspectorLayoutMode: InspectorLayoutMode | undefined = shellWidth === undefined
    ? undefined
    : shouldOverlayInspector({
      shellWidth,
      sidebarVisible,
      sidebarWidth: widths.sidebar,
      inspectorWidth: PANE_WIDTHS.inspector.default,
      workspaceVisible: hasWorkspace,
    }) ? "overlay" : "reserved";
  const hasInspector = inspector !== undefined && inspectorVisible && inspectorLayoutMode !== undefined;

  useEffect(() => { writePaneWidths(window.localStorage, widths); }, [widths]);
  useEffect(() => {
    const shell = shellRef.current;
    if (shell === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) setShellWidth(width);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (inspectorLayoutMode !== undefined) onInspectorLayoutModeChange?.(inspectorLayoutMode);
  }, [inspectorLayoutMode, onInspectorLayoutModeChange]);
  const setSidebarWidth = (width: number): void =>
    setWidths((current) => ({ ...current, sidebar: width }));
  const style = {
    "--sidebar-width": `${widths.sidebar}px`,
    "--sidebar-content-inset": `calc(${widths.sidebar}px + (2 * var(--sidebar-gutter)))`,
    "--inspector-width": `${PANE_WIDTHS.inspector.default}px`,
  } as CSSProperties;
  const sidebarToggle = <Button
    type="button"
    variant="sidebarIcon"
    size={sidebarVisible ? "compactIcon" : "icon"}
    className="sidebar-toggle"
    aria-label={sidebarVisible ? "Collapse sidebar" : "Expand sidebar"}
    aria-controls="app-sidebar"
    aria-expanded={sidebarVisible}
    onClick={() => onSidebarVisibilityChange(!sidebarVisible)}
  >{sidebarVisible ? <PanelRight aria-hidden="true" /> : <PanelLeft aria-hidden="true" />}</Button>;

  return (
    <main ref={shellRef} className={`desktop-shell${sidebarVisible ? "" : " sidebar-collapsed"}${hasWorkspace ? " workspace-open" : ""}${inspectorLayoutMode === "overlay" ? " inspector-overlay" : ""}`} style={style}>
      <div className="titlebar" aria-hidden="true" />
      <aside id="app-sidebar" className="sidebar" aria-hidden={!sidebarVisible} inert={!sidebarVisible}>{sidebar}</aside>
      {sidebarVisible ? sidebarAction : null}
      {sidebarVisible ? <SidebarSeparator
        width={widths.sidebar}
        onWidthChange={setSidebarWidth}
      /> : null}
      {sidebarVisible ? sidebarToggle : <div className="collapsed-sidebar-controls">
        {sidebarToggle}
        {collapsedSidebarAction === undefined ? null : <div className="collapsed-sidebar-action">{collapsedSidebarAction}</div>}
      </div>}
      {mainAction}
      <div className="sidebar-spacer" style={{ width: sidebarVisible ? "var(--sidebar-content-inset)" : 0 }} aria-hidden="true" />
      <div className="shell-center">{main}</div>
      {hasInspector ? <aside className="shell-inspector" aria-label={inspectorLabel}>{inspector}</aside> : null}
      {hasWorkspace ? <aside className="shell-workspace" aria-label="Files workspace">{workspace}</aside> : null}
    </main>
  );
};
