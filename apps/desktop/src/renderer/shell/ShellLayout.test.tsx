// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ShellLayout } from "./ShellLayout";
import { PANE_STORAGE_KEY, PANE_WIDTHS } from "./paneStorage";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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

  it("supports keyboard resizing for both pane directions", () => {
    renderLayout(<span>Inspector content</span>);
    const sidebar = screen.getByRole("separator", { name: "Resize sidebar" });
    const inspector = screen.getByRole("separator", { name: "Resize inspector" });
    fireEvent.keyDown(sidebar, { key: "ArrowRight" });
    expect(sidebar.getAttribute("aria-valuenow")).toBe(String(PANE_WIDTHS.sidebar.default + 10));
    fireEvent.keyDown(sidebar, { key: "Home" });
    expect(sidebar.getAttribute("aria-valuenow")).toBe(String(PANE_WIDTHS.sidebar.min));
    fireEvent.keyDown(inspector, { key: "ArrowLeft" });
    expect(inspector.getAttribute("aria-valuenow")).toBe(String(PANE_WIDTHS.inspector.default + 10));
    fireEvent.keyDown(inspector, { key: "End" });
    expect(inspector.getAttribute("aria-valuenow")).toBe(String(PANE_WIDTHS.inspector.max));
  });

  it("restores versioned widths and falls back when storage is invalid or obsolete", () => {
    window.localStorage.setItem(PANE_STORAGE_KEY, JSON.stringify({ version: 1, sidebar: 300, inspector: 350 }));
    const first = renderLayout(<span>Inspector content</span>);
    expect(screen.getByRole("separator", { name: "Resize sidebar" }).getAttribute("aria-valuenow")).toBe("300");
    expect(screen.getByRole("separator", { name: "Resize inspector" }).getAttribute("aria-valuenow")).toBe("350");
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
      main={<span>Main content</span>}
      sidebarVisible={false}
      onSidebarVisibilityChange={() => undefined}
    />);
    expect(document.querySelector<HTMLElement>(".sidebar-spacer")?.style.width).toBe("0px");
  });
});
