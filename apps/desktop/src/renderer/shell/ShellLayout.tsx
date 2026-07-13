import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import { Button } from "../components/ui/button";
import { clampPaneWidth, PANE_WIDTHS, readPaneWidths, writePaneWidths } from "./paneStorage";
import type { PaneWidths } from "./paneStorage";

export interface ShellLayoutProps {
  readonly sidebar: ReactNode;
  readonly main: ReactNode;
  readonly inspector?: ReactNode;
  readonly sidebarVisible: boolean;
  readonly inspectorVisible?: boolean;
  readonly onSidebarVisibilityChange: (visible: boolean) => void;
}

interface ResizeStart {
  readonly x: number;
  readonly width: number;
}

interface PaneSeparatorProps {
  readonly className: string;
  readonly label: string;
  readonly pane: keyof PaneWidths;
  readonly width: number;
  readonly onWidthChange: (width: number) => void;
}

const separatorKeyWidth = (pane: keyof PaneWidths, width: number, event: KeyboardEvent): number | undefined => {
  const direction = pane === "sidebar" ? 1 : -1;
  if (event.key === "ArrowLeft") return width - (10 * direction);
  if (event.key === "ArrowRight") return width + (10 * direction);
  if (event.key === "Home") return PANE_WIDTHS[pane].min;
  if (event.key === "End") return PANE_WIDTHS[pane].max;
  return undefined;
};

const PaneSeparator = ({ className, label, pane, width, onWidthChange }: PaneSeparatorProps): React.JSX.Element => {
  const drag = useRef<ResizeStart | undefined>(undefined);
  const range = PANE_WIDTHS[pane];
  const updateWidth = (next: number): void => onWidthChange(clampPaneWidth(pane, next));

  return <div
    className={`pane-separator ${className}`}
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={range.min}
    aria-valuemax={range.max}
    aria-valuenow={width}
    tabIndex={0}
    onDoubleClick={() => updateWidth(range.default)}
    onKeyDown={(event) => {
      const next = separatorKeyWidth(pane, width, event);
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
      updateWidth(drag.current.width + (pane === "sidebar" ? delta : -delta));
    }}
    onPointerUp={() => { drag.current = undefined; }}
    onPointerCancel={() => { drag.current = undefined; }}
    onLostPointerCapture={() => { drag.current = undefined; }}
  />;
};

export const ShellLayout = ({
  sidebar,
  main,
  inspector,
  sidebarVisible,
  inspectorVisible = inspector !== undefined,
  onSidebarVisibilityChange,
}: ShellLayoutProps): React.JSX.Element => {
  const [widths, setWidths] = useState<PaneWidths>(() => readPaneWidths(window.localStorage));
  const hasInspector = inspector !== undefined && inspectorVisible;

  useEffect(() => { writePaneWidths(window.localStorage, widths); }, [widths]);

  const setPaneWidth = (pane: keyof PaneWidths, width: number): void =>
    setWidths((current) => ({ ...current, [pane]: width }));
  const style = {
    "--sidebar-width": `${widths.sidebar}px`,
    "--sidebar-content-inset": `calc(${widths.sidebar}px + (2 * var(--sidebar-gutter)))`,
    "--inspector-width": `${widths.inspector}px`,
  } as CSSProperties;

  return (
    <main className={`desktop-shell${sidebarVisible ? "" : " sidebar-collapsed"}${hasInspector ? " has-inspector" : ""}`} style={style}>
      <div className="titlebar" aria-hidden="true" />
      <aside id="app-sidebar" className="sidebar" aria-hidden={!sidebarVisible} inert={!sidebarVisible}>{sidebar}</aside>
      {sidebarVisible ? <PaneSeparator
        className="sidebar-separator"
        label="Resize sidebar"
        pane="sidebar"
        width={widths.sidebar}
        onWidthChange={(width) => setPaneWidth("sidebar", width)}
      /> : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="sidebar-toggle"
        aria-label={sidebarVisible ? "Collapse sidebar" : "Expand sidebar"}
        aria-controls="app-sidebar"
        aria-expanded={sidebarVisible}
        onClick={() => onSidebarVisibilityChange(!sidebarVisible)}
      ><PanelLeft aria-hidden="true" /></Button>
      <div className="sidebar-spacer" style={{ width: sidebarVisible ? "var(--sidebar-content-inset)" : 0 }} aria-hidden="true" />
      <div className="shell-center">{main}</div>
      {hasInspector ? <>
        <PaneSeparator
          className="inspector-separator"
          label="Resize inspector"
          pane="inspector"
          width={widths.inspector}
          onWidthChange={(width) => setPaneWidth("inspector", width)}
        />
        <aside className="shell-inspector" aria-label="Inspector">{inspector}</aside>
      </> : null}
    </main>
  );
};
