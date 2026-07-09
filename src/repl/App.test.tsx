import { describe, expect, it } from "vitest";
import type React from "react";
import { TodoPanel, shouldAppendToolTranscriptLine } from "./App.js";
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
});
