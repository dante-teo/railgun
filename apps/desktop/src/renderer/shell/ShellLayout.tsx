import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { Button, InsetIconButton } from "../components/ui/button";
import { cn } from "../lib/utils";
import { shouldOverlayInspector, shouldOverlayWorkspace } from "./inspectorLayout";
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
    className="pane-separator group absolute bottom-[var(--sidebar-gutter)] left-[calc(var(--sidebar-gutter)_+_var(--sidebar-width)_-_0.25rem)] top-[var(--sidebar-gutter)] z-[var(--layer-titlebar-control)] w-2 cursor-col-resize touch-none [-webkit-app-region:no-drag]"
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
  ><span className="mx-auto block h-full w-px bg-transparent transition-colors duration-fast group-hover:bg-border-strong" /></div>;
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
  const workspaceOverlay = hasWorkspace && shellWidth !== undefined && shouldOverlayWorkspace(shellWidth, sidebarVisible, widths.sidebar);
  const inspectorLayoutMode: InspectorLayoutMode | undefined = shellWidth === undefined
    ? undefined
    : shouldOverlayInspector({
      shellWidth,
      sidebarVisible,
      sidebarWidth: widths.sidebar,
      inspectorWidth: PANE_WIDTHS.inspector.default,
      workspaceVisible: hasWorkspace && !workspaceOverlay,
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
    "--toolbar-content-left": sidebarVisible ? "var(--space-7)" : "var(--collapsed-toolbar-content-left)",
    "--toolbar-surface-right": hasWorkspace && !workspaceOverlay ? "var(--workspace-width)" : "0px",
    "--titlebar-drag-left": sidebarVisible ? "0px" : "var(--collapsed-toolbar-content-left)",
    "--titlebar-drag-right": hasWorkspace && !workspaceOverlay
      ? "calc(var(--workspace-width) + var(--titlebar-actions-safe-width))"
      : "var(--titlebar-actions-safe-width)",
  } as CSSProperties;
  const sidebarToggle = <InsetIconButton
    type="button"
    className={cn("z-[var(--layer-titlebar-control)] justify-center rounded-full [-webkit-app-region:no-drag]", sidebarVisible && "absolute left-[var(--sidebar-toggle-left)] top-[var(--titlebar-control-center-y)] -translate-y-1/2 active:scale-[0.975]")}
    aria-label={sidebarVisible ? "Collapse sidebar" : "Expand sidebar"}
    aria-controls="app-sidebar"
    aria-expanded={sidebarVisible}
    onClick={() => onSidebarVisibilityChange(!sidebarVisible)}
  >{sidebarVisible ? <PanelRight aria-hidden="true" /> : <PanelLeft aria-hidden="true" />}</InsetIconButton>;

  return (
    <main ref={shellRef} className={cn("desktop-shell relative flex h-full bg-transparent", !sidebarVisible && "sidebar-collapsed", hasWorkspace && "workspace-open", workspaceOverlay && "workspace-overlay", inspectorLayoutMode === "overlay" && "inspector-overlay")} style={style}>
      <div
        data-glass-surface="toolbar"
        className="toolbar-material pointer-events-none fixed left-0 right-[var(--toolbar-surface-right)] top-0 z-[var(--layer-toolbar-material)] h-[var(--toolbar-surface-height)] [background:var(--material-toolbar)] [-webkit-backdrop-filter:var(--material-blur-toolbar)] [backdrop-filter:var(--material-blur-toolbar)] [-webkit-mask-image:var(--material-toolbar-mask)] [mask-image:var(--material-toolbar-mask)]"
        aria-hidden="true"
      />
      <div className="titlebar-drag-region fixed left-[var(--titlebar-drag-left)] right-[var(--titlebar-drag-right)] top-0 z-[var(--layer-titlebar)] h-[var(--titlebar-height)] [-webkit-app-region:drag]" aria-hidden="true" />
      <aside id="app-sidebar" data-glass-surface="sidebar" className={cn("absolute bottom-[var(--sidebar-gutter)] left-[var(--sidebar-gutter)] top-[var(--sidebar-gutter)] z-[var(--layer-sidebar)] flex w-[var(--sidebar-width)] flex-col overflow-hidden rounded-xl border border-border bg-popover pt-[calc(var(--titlebar-height)_+_var(--space-2))] shadow-popover backdrop-blur-popover transition-[opacity,transform] duration-standard ease-standard", !sidebarVisible && "pointer-events-none -translate-x-[calc(100%_+_var(--sidebar-gutter))] opacity-0")} aria-hidden={!sidebarVisible} inert={!sidebarVisible}>{sidebar}</aside>
      {sidebarVisible ? sidebarAction : null}
      {sidebarVisible ? <SidebarSeparator
        width={widths.sidebar}
        onWidthChange={setSidebarWidth}
      /> : null}
      {sidebarVisible ? sidebarToggle : <div className="collapsed-sidebar-controls pointer-events-auto absolute left-[var(--sidebar-toggle-left)] top-[var(--titlebar-control-center-y)] z-[var(--layer-titlebar-action)] flex h-[var(--titlebar-control-height)] -translate-y-1/2 items-center overflow-hidden rounded-full border border-border bg-surface-control [-webkit-app-region:no-drag]">
        {sidebarToggle}
        {collapsedSidebarAction === undefined ? null : <><span className="h-[calc(100%_-_var(--space-4))] w-px bg-border-strong" aria-hidden="true" /><div className="collapsed-sidebar-action flex">{collapsedSidebarAction}</div></>}
      </div>}
      {mainAction}
      <div className="sidebar-spacer shrink-0 transition-[width] duration-standard ease-standard" style={{ width: sidebarVisible ? "var(--sidebar-content-inset)" : 0 }} aria-hidden="true" />
      <div className="shell-center min-w-0 flex-1">{main}</div>
      {hasInspector ? <aside className={cn("shell-inspector flex h-full w-[var(--inspector-width)] min-w-[var(--inspector-width)] items-start overflow-visible border-0 bg-transparent pb-2 pr-4 pt-[calc(var(--titlebar-height)_+_var(--space-2))]", inspectorLayoutMode === "overlay" && "pointer-events-none absolute right-4 top-[calc(var(--titlebar-height)_+_var(--space-2))] z-[var(--layer-popover)] h-auto max-h-[calc(100%_-_var(--titlebar-height)_-_var(--space-6))] w-[var(--inspector-width)] min-w-0 overflow-visible p-0", inspectorLayoutMode === "overlay" && hasWorkspace && !workspaceOverlay && "right-[calc(var(--workspace-width)_+_var(--space-4))]")} aria-label={inspectorLabel}>{inspector}</aside> : null}
      {hasWorkspace ? <aside className={cn("shell-workspace relative h-full w-[var(--workspace-width)] min-w-[var(--workspace-width)] overflow-hidden border-l border-border-strong bg-surface", workspaceOverlay && "absolute inset-y-0 right-0 z-[var(--layer-popover)] w-[min(var(--workspace-width),calc(100%_-_var(--space-8)))] min-w-[22.5rem] shadow-dialog")} aria-label="Files workspace">{workspace}</aside> : null}
    </main>
  );
};
