// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Button, ButtonGroup, InsetIconButton } from "./button";
import { Badge } from "./badge";
import { Checkbox } from "./checkbox";
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
import { FormField } from "./form";
import { EmptyState, ErrorState, LoadingState } from "./state";
import { SegmentedControl, SegmentedControlItem } from "./radio-group";
import { Switch } from "./switch";

beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe(): void { /* jsdom layout is static */ }
  unobserve(): void { /* jsdom layout is static */ }
  disconnect(): void { /* jsdom layout is static */ }
}));
afterAll(() => vi.unstubAllGlobals());
afterEach(cleanup);

describe("Button", () => {
  it.each([
    ["primary", "bg-primary"],
    ["secondary", "bg-secondary"],
    ["ghost", "bg-transparent"],
    ["destructive", "bg-destructive"],
  ] as const)("renders the %s variant", (variant, expectedClass) => {
    render(<Button variant={variant}>{variant}</Button>);
    expect(screen.getByRole("button", { name: variant }).className).toContain(expectedClass);
  });

  it("keeps liquid glass on hierarchy surfaces rather than ordinary buttons", () => {
    render(<Button variant="secondary">Action</Button>);
    expect(screen.getByRole("button", { name: "Action" }).className).not.toContain("backdrop-blur");
  });

  it("supports circular icon controls and native disabled behavior", () => {
    const onClick = vi.fn();
    render(<Button size="icon" aria-label="Add" disabled onClick={onClick}>+</Button>);
    const button = screen.getByRole("button", { name: "Add" });
    expect(button.className).toContain("size-control-icon");
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps inset icon hover feedback inside its full-size target", () => {
    render(<InsetIconButton aria-label="Search">+</InsetIconButton>);
    const button = screen.getByRole("button", { name: "Search" });
    expect(button.className).toContain("size-control-icon");
    expect(button.className).toContain("rounded-full");
    expect(button.className).toContain("hover:not-disabled:bg-transparent");
    expect(button.className).toContain("before:size-6");
    expect(button.className).toContain("before:left-1/2");
    expect(button.className).toContain("before:top-1/2");
    expect(button.className).toContain("hover:not-disabled:before:bg-surface-muted");
  });

  it("groups capsule controls with accessible group semantics", () => {
    render(<ButtonGroup aria-label="View"><Button variant="secondary">List</Button><Button variant="secondary">Grid</Button></ButtonGroup>);
    expect(screen.getByRole("group", { name: "View" })).toBeTruthy();
  });
});

describe("fields and menus", () => {
  it("exposes field labels", () => {
    render(<><Input aria-label="Project name" /><Textarea aria-label="Instructions" /></>);
    expect(screen.getByRole("textbox", { name: "Project name" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Instructions" })).toBeTruthy();
  });

  it("connects generated field metadata to its control", () => {
    render(<>
      <p id="external-hint">Stored locally.</p>
      <FormField label="Project name" description="Shown in the sidebar." error="A name is required." required>
        <Input aria-describedby="external-hint" />
      </FormField>
    </>);

    const input = screen.getByRole("textbox", { name: "Project name" });
    const id = input.id;
    expect(id).not.toBe("");
    expect(input).toHaveProperty("required", true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "external-hint",
      `${id}-description`,
      `${id}-error`,
    ]);
    expect(document.getElementById(`${id}-description`)?.textContent).toBe("Shown in the sidebar.");
    expect(document.getElementById(`${id}-error`)?.textContent).toBe("A name is required.");
  });

  it("selects dropdown actions from the keyboard", async () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="secondary">Actions</Button></DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>Open details</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const item = await screen.findByRole("menuitem", { name: "Open details" });
    expect(document.querySelector(".ui-popover-arrow")).toBeNull();
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
    expect(sheet.getAttribute("data-edge")).toBe("right");
    expect(sheetRef.current).toBe(sheet);
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

});

describe("selection controls", () => {
  it("exposes native accessible state through Radix controls", () => {
    const onSwitch = vi.fn();
    render(<><Checkbox aria-label="Remember" defaultChecked /><Switch aria-label="Automation" onCheckedChange={onSwitch} /><SegmentedControl aria-label="Mode" defaultValue="manual"><SegmentedControlItem value="manual">Manual</SegmentedControlItem><SegmentedControlItem value="smart">Smart</SegmentedControlItem></SegmentedControl></>);
    expect(screen.getByRole("checkbox", { name: "Remember" }).getAttribute("data-state")).toBe("checked");
    fireEvent.click(screen.getByRole("switch", { name: "Automation" }));
    expect(onSwitch).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("radio", { name: "Smart" }));
    expect(screen.getByRole("radio", { name: "Smart" }).getAttribute("data-state")).toBe("checked");
  });

  it.each(["neutral", "success", "warning", "destructive", "info"] as const)("renders a semantic %s badge", variant => {
    render(<Badge variant={variant}>{variant}</Badge>);
    expect(screen.getByText(variant).className).toContain(variant === "neutral" ? "text-foreground-secondary" : `text-${variant}`);
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
