import { describe, expect, it } from "vitest";
import type React from "react";
import { TodoPanel, shouldAppendToolTranscriptLine, shouldShowToolLine } from "./App.js";
import { createTodoStore } from "../tools/todo.js";

describe("TodoPanel", () => {
  it("hides when todo state is empty", () => {
    expect(TodoPanel({ todos: [], isLoading: false })).toBeNull();
  });

  it("renders when todo state is nonempty", () => {
    const store = createTodoStore([{ id: "a", content: "A", status: "pending" }]);
    const panel = TodoPanel({ todos: store.read(), isLoading: false });
    const element = panel as React.ReactElement<{ children: readonly React.ReactElement[] }>;
    const header = element.props.children[0] as React.ReactElement<{ children: readonly unknown[] }>;

    expect(panel).not.toBeNull();
    expect(header.props.children).toEqual(["Todos · ", 0, "/", 1]);
  });

  it("renders a loading state while todos are being crafted", () => {
    const panel = TodoPanel({ todos: [], isLoading: true });
    const element = panel as React.ReactElement<{ children: readonly React.ReactElement[] }>;
    const loading = element.props.children[1] as React.ReactElement<{ children: readonly unknown[] }>;

    expect(panel).not.toBeNull();
    expect(loading.props.children).toContain(" Crafting todos");
  });

  it("suppresses normal transcript lines for todo completions", () => {
    expect(shouldAppendToolTranscriptLine("todo")).toBe(false);
    expect(shouldAppendToolTranscriptLine("read_file")).toBe(true);
  });

  it("surfaces todo tool errors even though successful completions are suppressed", () => {
    expect(shouldShowToolLine("todo", false)).toBe(false);
    expect(shouldShowToolLine("todo", true)).toBe(true);
    expect(shouldShowToolLine("read_file", false)).toBe(true);
    expect(shouldShowToolLine("read_file", true)).toBe(true);
  });

  it("renders pending items with [ ] glyph", () => {
    const store = createTodoStore([{ id: "a", content: "A", status: "pending" }]);
    const panel = TodoPanel({ todos: store.read(), isLoading: false });
    const element = panel as unknown as React.ReactElement<{ children: readonly unknown[] }>;
    const items = element.props.children[2] as unknown as React.ReactElement[];
    const glyphText = (items[0] as React.ReactElement<{ children: readonly unknown[] }>).props.children[0] as React.ReactElement<{ children: readonly unknown[] }>;

    expect(glyphText.props.children).toContain("[ ]");
  });

  it("renders completed items with [x] glyph", () => {
    const store = createTodoStore([{ id: "a", content: "A", status: "completed" }]);
    const panel = TodoPanel({ todos: store.read(), isLoading: false });
    const element = panel as unknown as React.ReactElement<{ children: readonly unknown[] }>;
    const items = element.props.children[2] as unknown as React.ReactElement[];
    const glyphText = (items[0] as React.ReactElement<{ children: readonly unknown[] }>).props.children[0] as React.ReactElement<{ children: readonly unknown[] }>;

    expect(glyphText.props.children).toContain("[x]");
  });
});
