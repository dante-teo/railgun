import { describe, expect, it } from "vitest";
import type React from "react";
import { TodoPanel } from "./TodoPanel.js";

describe("TodoPanel", () => {
  it("returns null when empty and not loading", () => {
    expect(TodoPanel({ todos: [], isLoading: false })).toBeNull();
  });

  it("shows skeleton when loading with empty todos", () => {
    const panel = TodoPanel({ todos: [], isLoading: true });
    const element = panel as React.ReactElement<{ "aria-busy": string }>;
    expect(panel).not.toBeNull();
    expect(element.props["aria-busy"]).toBe("true");
  });

  it("renders summary header with counts", () => {
    const todos = [
      { id: "1", content: "A", status: "completed" as const },
      { id: "2", content: "B", status: "pending" as const },
    ];
    const panel = TodoPanel({ todos, isLoading: false });
    const element = panel as React.ReactElement<{ children: readonly React.ReactElement[] }>;
    const header = element.props.children[0] as React.ReactElement<{ children: readonly React.ReactElement[] }>;
    const summary = header.props.children[1] as React.ReactElement<{ children: readonly unknown[] }>;
    expect(summary.props.children).toEqual([1, "/", 2]);
  });

  it.each([
    ["pending",     "[ ]"],
    ["completed",   "[x]"],
    ["in_progress", "[>]"],
    ["cancelled",   "[-]"],
  ] as const)("maps %s status to %s glyph", (status, expectedGlyph) => {
    const todos = [{ id: "1", content: "A", status }];
    const panel = TodoPanel({ todos, isLoading: false });
    const element = panel as React.ReactElement<{ children: readonly unknown[] }>;
    const listWrapper = element.props.children[1] as React.ReactElement<{ children: readonly React.ReactElement[] }>;
    const items = listWrapper.props.children as unknown as React.ReactElement[];
    const glyph = (items[0] as React.ReactElement<{ children: readonly React.ReactElement[] }>).props.children[0] as React.ReactElement<{ children: string }>;
    expect(glyph.props.children).toBe(expectedGlyph);
  });

  it("applies status CSS modifier class to item", () => {
    const todos = [{ id: "1", content: "A", status: "in_progress" as const }];
    const panel = TodoPanel({ todos, isLoading: false });
    const element = panel as React.ReactElement<{ children: readonly unknown[] }>;
    const listWrapper = element.props.children[1] as React.ReactElement<{ children: readonly React.ReactElement[] }>;
    const items = listWrapper.props.children as unknown as React.ReactElement[];
    const item = items[0] as React.ReactElement<{ className: string }>;
    expect(item.props.className).toBe("todo-item todo-item--in_progress");
  });
});
