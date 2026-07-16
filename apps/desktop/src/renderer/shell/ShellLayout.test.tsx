// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellLayout } from "./ShellLayout";
import { PANE_STORAGE_KEY, PANE_WIDTHS } from "./paneStorage";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  Reflect.deleteProperty(globalThis, "ResizeObserver");
});

const renderLayout = (inspector?: React.ReactNode) => render(
  <ShellLayout
    sidebar={<span>Sidebar content</span>}
    main={<span>Main content</span>}
    {...(inspector === undefined ? {} : { inspector })}
    sidebarVisible
    onSidebarVisibilityChange={() => undefined}
  />,
);

describe("ShellLayout", () => {
  it("uses the shared compact sidebar icon treatment for the toggle", () => {
    renderLayout();
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle.className).toContain("bg-transparent");
    expect(toggle.className).toContain("size-control-icon");
    expect(toggle.className).not.toContain("size-[var(--titlebar-control-height)]");
    expect(toggle.className).toContain("rounded-full");
    expect(toggle.className).not.toContain("rounded-xs");
    expect(toggle.className).toContain("before:size-6");
    expect(toggle.className).toContain("hover:not-disabled:before:bg-surface-muted");
    expect(toggle.className).toContain("hover:not-disabled:bg-transparent");
    expect(toggle.querySelector(".lucide-panel-right")).not.toBeNull();
  });

  it("resizes and clamps the sidebar with pointer controls, then resets on double click", () => {
    renderLayout();
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.pointerDown(separator, { clientX: PANE_WIDTHS.sidebar.default, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 1_000, pointerId: 1 });
    expect(separator.getAttribute("aria-valuenow")).toBe(String(PANE_WIDTHS.sidebar.max));
    const shell = separator.closest<HTMLElement>(".desktop-shell");
    expect(shell?.style.getPropertyValue("--sidebar-width")).toBe(`${PANE_WIDTHS.sidebar.max}px`);
    expect(shell?.style.getPropertyValue("--sidebar-content-inset"))
      .toBe(`calc(${PANE_WIDTHS.sidebar.max}px + (2 * var(--sidebar-gutter)))`);
    expect(shell?.style.getPropertyValue("--toolbar-surface-right")).toBe("0px");
    expect(shell?.style.getPropertyValue("--titlebar-drag-left")).toBe("0px");
    expect(shell?.style.getPropertyValue("--titlebar-drag-right")).toBe("var(--titlebar-actions-safe-width)");
    const toolbarMaterial = shell?.querySelector<HTMLElement>("[data-glass-surface='toolbar']");
    expect(toolbarMaterial?.className).toContain("left-0");
    expect(toolbarMaterial?.className).not.toContain("inset-x-0");
    expect(toolbarMaterial?.className).toContain("right-[var(--toolbar-surface-right)]");
    expect(toolbarMaterial?.style.right).toBe("");
    expect(toolbarMaterial?.className).toContain("z-[var(--layer-toolbar-material)]");
    expect(shell?.querySelector(".titlebar-drag-region")?.className).toContain("left-[var(--titlebar-drag-left)]");
    expect(shell?.querySelector<HTMLElement>(".sidebar-spacer")?.style.width).toBe("var(--sidebar-content-inset)");
    fireEvent.doubleClick(separator);
    expect(separator.getAttribute("aria-valuenow")).toBe(String(PANE_WIDTHS.sidebar.default));
  });

  it("supports keyboard resizing for the sidebar without exposing an inspector resize control", () => {
    renderLayout(<span>Inspector content</span>);
    const sidebar = screen.getByRole("separator", { name: "Resize sidebar" });
    fireEvent.keyDown(sidebar, { key: "ArrowRight" });
    expect(sidebar.getAttribute("aria-valuenow")).toBe(String(PANE_WIDTHS.sidebar.default + 10));
    fireEvent.keyDown(sidebar, { key: "Home" });
    expect(sidebar.getAttribute("aria-valuenow")).toBe(String(PANE_WIDTHS.sidebar.min));
    expect(screen.queryByRole("separator", { name: "Resize inspector" })).toBeNull();
  });

  it("reserves activity when wide and overlays it without reservation when constrained", () => {
    let resize: ResizeObserverCallback = () => undefined;
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe(): void { /* Driven explicitly by the test. */ }
      disconnect(): void { /* No resources in the test double. */ }
    } });
    const onModeChange = vi.fn();
    render(<ShellLayout
      sidebar={<span>Sidebar content</span>}
      main={<span>Main content</span>}
      inspector={<span>Inspector content</span>}
      workspace={<span>Workspace content</span>}
      sidebarVisible
      onSidebarVisibilityChange={() => undefined}
      onInspectorLayoutModeChange={onModeChange}
    />);
    const shell = document.querySelector<HTMLElement>(".desktop-shell");
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
    act(() => resize([{ contentRect: { width: 1_900 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(shell?.classList.contains("workspace-open")).toBe(true);
    expect(shell?.classList.contains("inspector-overlay")).toBe(false);
    expect(shell?.style.getPropertyValue("--toolbar-surface-right")).toBe("var(--workspace-width)");
    expect(shell?.style.getPropertyValue("--titlebar-drag-right")).toBe("calc(var(--workspace-width) + var(--titlebar-actions-safe-width))");
    expect(screen.getByRole("complementary", { name: "Inspector" })).not.toBeNull();
    expect(screen.getByRole("complementary", { name: "Files workspace" })).not.toBeNull();
    expect(shell?.querySelector(".shell-center")?.nextElementSibling?.classList.contains("shell-inspector")).toBe(true);
    expect(onModeChange).toHaveBeenLastCalledWith("reserved");

    act(() => resize([{ contentRect: { width: 1_600 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(shell?.classList.contains("inspector-overlay")).toBe(true);
    expect(shell?.style.getPropertyValue("--toolbar-surface-right")).toBe("var(--workspace-width)");
    expect(screen.getByRole("complementary", { name: "Inspector" })).not.toBeNull();
    expect(onModeChange).toHaveBeenLastCalledWith("overlay");
  });

  it("restores versioned widths and falls back when storage is invalid or obsolete", () => {
    window.localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify({ version: 1, sidebar: 300, inspector: 350 }));
    const first = renderLayout(<span>Inspector content</span>);
    expect(screen.getByRole("separator", { name: "Resize sidebar" }).getAttribute("aria-valuenow")).toBe("300");
    expect(document.querySelector<HTMLElement>(".desktop-shell")?.style.getPropertyValue("--inspector-width"))
      .toBe(`${PANE_WIDTHS.inspector.default}px`);
    expect(screen.queryByRole("separator", { name: "Resize inspector" })).toBeNull();
    first.unmount();

    window.localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify({ version: 0, sidebar: 300, inspector: 350 }));
    const second = renderLayout();
    expect(screen.getByRole("separator", { name: "Resize sidebar" }).getAttribute("aria-valuenow"))
      .toBe(String(PANE_WIDTHS.sidebar.default));
    second.unmount();

    window.localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify({ version: 1, sidebar: 12, inspector: 350 }));
    renderLayout();
    expect(screen.getByRole("separator", { name: "Resize sidebar" }).getAttribute("aria-valuenow"))
      .toBe(String(PANE_WIDTHS.sidebar.default));
  });

  it("reserves the Files pane at normal desktop widths and overlays it only when chat would be unusable", () => {
    let resize: ResizeObserverCallback = () => undefined;
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe(): void { /* Driven explicitly by the test. */ }
      disconnect(): void { /* No resources in the test double. */ }
    } });
    render(<ShellLayout
      sidebar={<span>Sidebar content</span>}
      main={<span>Main content</span>}
      workspace={<span>Workspace content</span>}
      sidebarVisible
      onSidebarVisibilityChange={() => undefined}
    />);
    const shell = document.querySelector<HTMLElement>(".desktop-shell");

    act(() => resize([{ contentRect: { width: 1_024 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(shell?.classList.contains("workspace-overlay")).toBe(false);
    expect(screen.getByRole("complementary", { name: "Files workspace" }).className).not.toContain("absolute");

    act(() => resize([{ contentRect: { width: 760 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(shell?.classList.contains("workspace-overlay")).toBe(true);
    expect(screen.getByRole("complementary", { name: "Files workspace" }).className).toContain("absolute");
  });

  it("omits the inspector entirely and never persists visibility state", () => {
    renderLayout();
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize inspector" })).toBeNull();
    const stored = JSON.parse(window.localStorage.getItem(PANE_STORAGE_KEY) ?? "null") as Record<string, unknown>;
    expect(stored).toEqual({
      version: 1,
      sidebar: PANE_WIDTHS.sidebar.default,
      inspector: PANE_WIDTHS.inspector.default,
    });
    expect(stored).not.toHaveProperty("sidebarVisible");
  });

  it("releases the reserved content width when the sidebar is hidden", () => {
    render(<ShellLayout
      sidebar={<span>Sidebar content</span>}
      collapsedSidebarAction={<button type="button">New Task</button>}
      main={<span>Main content</span>}
      sidebarVisible={false}
      onSidebarVisibilityChange={() => undefined}
    />);
    expect(document.querySelector<HTMLElement>(".sidebar-spacer")?.style.width).toBe("0px");
    expect(document.querySelector<HTMLElement>(".desktop-shell")?.style.getPropertyValue("--toolbar-surface-right")).toBe("0px");
    expect(document.querySelector<HTMLElement>(".desktop-shell")?.style.getPropertyValue("--titlebar-drag-left")).toBe("var(--collapsed-toolbar-content-left)");
    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    expect(toggle.className).toContain("size-control-icon");
    expect(toggle.className).toContain("bg-transparent");
    expect(toggle.className).toContain("rounded-full");
    expect(toggle.className.split(" ")).not.toContain("size-6");
    expect(toggle.querySelector(".lucide-panel-left")).not.toBeNull();
    const controls = toggle.closest(".collapsed-sidebar-controls");
    expect(controls).not.toBeNull();
    expect(controls?.className).toContain("z-[var(--layer-titlebar-action)]");
    expect(toggle.className).toContain("[-webkit-app-region:no-drag]");
    expect(screen.getByRole("button", { name: "New Task" }).closest(".collapsed-sidebar-controls")).toBe(controls);
  });
});
