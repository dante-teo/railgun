// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(toggle.className).toContain("ui-button-sidebar-icon");
    expect(toggle.className).toContain("ui-button-compact-icon");
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

  it("switches the inspector to overlay mode from actual remaining transcript width", () => {
    let resize: ResizeObserverCallback = () => undefined;
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe(): void { /* Driven explicitly by the test. */ }
      disconnect(): void { /* No resources in the test double. */ }
    } });
    render(<ShellLayout
      sidebar={<span>Sidebar content</span>}
      main={<span>Main content</span>}
      inspector={<span>Inspector content</span>}
      sidebarVisible
      onSidebarVisibilityChange={() => undefined}
    />);
    const shell = document.querySelector<HTMLElement>(".desktop-shell");
    act(() => resize([{ contentRect: { width: 1_200 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(shell?.classList.contains("inspector-overlay")).toBe(true);
    expect(screen.getByRole("complementary", { name: "Inspector" })).not.toBeNull();
    act(() => resize([{ contentRect: { width: 1_300 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(shell?.classList.contains("inspector-overlay")).toBe(false);
    expect(screen.getByRole("complementary", { name: "Inspector" })).not.toBeNull();
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
    const toggle = screen.getByRole("button", { name: "Expand sidebar" });
    expect(toggle.className).toContain("ui-button-icon");
    expect(toggle.className).toContain("ui-button-sidebar-icon");
    expect(toggle.className).not.toContain("ui-button-compact-icon");
    expect(toggle.querySelector(".lucide-panel-left")).not.toBeNull();
    const controls = toggle.closest(".collapsed-sidebar-controls");
    expect(controls).not.toBeNull();
    expect(screen.getByRole("button", { name: "New Task" }).closest(".collapsed-sidebar-controls")).toBe(controls);
  });
});
