// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../shared/types";
import { TaskPalette } from "../tasks/TaskPalette";
import { CommandPalette } from "./CommandPalette";
import type { RendererCommand } from "./commandRegistry";

afterEach(cleanup);

const commands = (): readonly RendererCommand[] => [
  { id: "new-chat", label: "New Task", enabled: true, execute: vi.fn() },
  { id: "show-chat", label: "Task", enabled: true, execute: vi.fn() },
];

describe("shared palettes", () => {
  it("preserves the active command across equivalent item-array rerenders", async () => {
    const view = render(<CommandPalette open commands={commands()} restoreFocusTo={null} onOpenChange={() => undefined} />);
    const search = screen.getByRole("combobox", { name: "Search commands" });
    expect(search.getAttribute("aria-autocomplete")).toBe("list");
    expect(search.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(screen.getByRole("option", { name: "New Task" }).getAttribute("aria-selected")).toBe("true"));

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: "Task" }).getAttribute("aria-selected")).toBe("true");
    view.rerender(<CommandPalette open commands={commands()} restoreFocusTo={null} onOpenChange={() => undefined} />);
    expect(screen.getByRole("option", { name: "Task" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps command and task states outside their listboxes", () => {
    const commandView = render(<CommandPalette open commands={[]} restoreFocusTo={null} onOpenChange={() => undefined} />);
    const commandList = screen.getByRole("listbox", { name: "Commands" });
    expect(commandList.children).toHaveLength(0);
    expect(screen.getByText("No matching commands").closest("[role='listbox']")).toBeNull();
    commandView.unmount();

    const sessions: readonly SessionSummary[] = [];
    render(<TaskPalette
      open
      sessions={sessions}
      activeSessionId={undefined}
      loading
      error={undefined}
      disabled={false}
      restoreFocusTo={null}
      onOpenChange={() => undefined}
      onRetry={() => undefined}
      onSelect={() => undefined}
    />);
    const taskSearch = screen.getByRole("combobox", { name: "Search tasks" });
    expect(taskSearch.getAttribute("aria-autocomplete")).toBe("list");
    const taskList = screen.getByRole("listbox", { name: "Previous tasks" });
    expect(within(taskList).queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Loading tasks…").closest("[role='listbox']")).toBeNull();
  });
});
