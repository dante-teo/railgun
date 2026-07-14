// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Button, ButtonGroup } from "./button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "./dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";
import { Input, Textarea } from "./input";
import { EmptyState, ErrorState, LoadingState } from "./state";

beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe(): void { /* jsdom layout is static */ }
  unobserve(): void { /* jsdom layout is static */ }
  disconnect(): void { /* jsdom layout is static */ }
}));
afterAll(() => vi.unstubAllGlobals());
afterEach(cleanup);

describe("Button", () => {
  it.each(["primary", "tonal", "ghost", "destructive", "capsule"] as const)("renders the %s variant", (variant) => {
    render(<Button variant={variant}>{variant}</Button>);
    expect(screen.getByRole("button", { name: variant }).className).toContain(`ui-button-${variant}`);
  });

  it("keeps glass as an opaque tonal compatibility alias", () => {
    render(<Button variant="glass">Legacy</Button>);
    const className = screen.getByRole("button", { name: "Legacy" }).className;
    expect(className).toContain("ui-button-tonal");
    expect(className).not.toContain("ui-button-glass");
  });

  it("supports circular icon controls and native disabled behavior", () => {
    const onClick = vi.fn();
    render(<Button size="icon" aria-label="Add" disabled onClick={onClick}>+</Button>);
    const button = screen.getByRole("button", { name: "Add" });
    expect(button.className).toContain("ui-button-icon");
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("groups capsule controls with accessible group semantics", () => {
    render(<ButtonGroup aria-label="View"><Button variant="capsule">List</Button><Button variant="capsule">Grid</Button></ButtonGroup>);
    expect(screen.getByRole("group", { name: "View" })).toBeTruthy();
  });
});

describe("fields and menus", () => {
  it("exposes field labels", () => {
    render(<><Input aria-label="Project name" /><Textarea aria-label="Instructions" /></>);
    expect(screen.getByRole("textbox", { name: "Project name" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Instructions" })).toBeTruthy();
  });

  it("selects dropdown actions from the keyboard", async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="tonal">Actions</Button></DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>Open details</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const item = await screen.findByRole("menuitem", { name: "Open details" });
    expect(document.querySelector(".ui-popover-arrow")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(item));
    fireEvent.keyDown(item, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Open details" })).toBeNull());
  });
});

describe("overlays", () => {
  it("omits a decorative close button and closes through a footer action", async () => {
    render(
      <Dialog>
        <DialogTrigger asChild><Button>Open dialog</Button></DialogTrigger>
        <DialogContent>
          <DialogTitle>Connection details</DialogTitle>
          <DialogDescription>Validated backend information.</DialogDescription>
          <DialogFooter><DialogClose asChild><Button>Done</Button></DialogClose></DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(await screen.findByRole("dialog", { name: "Connection details" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("uses dialog behavior for an edge sheet", async () => {
    const sheetRef = createRef<HTMLDivElement>();
    render(
      <Sheet>
        <SheetTrigger asChild><Button>Open sheet</Button></SheetTrigger>
        <SheetContent ref={sheetRef} edge="right"><SheetTitle>Inspector</SheetTitle></SheetContent>
      </Sheet>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    const sheet = await screen.findByRole("dialog", { name: "Inspector" });
    expect(sheet.className).toContain("ui-sheet-right");
    expect(sheetRef.current).toBe(sheet);
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

});

describe("shared states", () => {
  it("uses status and alert semantics without assigning an unnecessary role to empty content", () => {
    render(<><LoadingState title="Loading" /><EmptyState title="No sessions" /><ErrorState title="Failed" /></>);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    expect(screen.getByRole("status").querySelector(".lucide-loader-circle")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Failed");
    expect(screen.getByRole("heading", { name: "No sessions" })).toBeTruthy();
  });
});
