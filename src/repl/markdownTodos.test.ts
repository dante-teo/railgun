import { describe, expect, it } from "vitest";
import { extractMarkdownTodos, stripMarkdownTodoLines } from "./markdownTodos.js";

describe("markdown todo fallback", () => {
  it("extracts flat checkbox lists into todo items", () => {
    expect(extractMarkdownTodos("- [ ] Read files\n- [x] Update tests")).toEqual([
      { id: "md-1-read-files", content: "Read files", status: "pending" },
      { id: "md-2-update-tests", content: "Update tests", status: "completed" }
    ]);
  });

  it("extracts nested checkbox lists by indentation", () => {
    expect(extractMarkdownTodos("- [ ] Parent\n  - [~] Child")).toEqual([
      {
        id: "md-1-parent",
        content: "Parent",
        status: "pending",
        children: [{ id: "md-2-child", content: "Child", status: "in_progress" }]
      }
    ]);
  });

  it("does not extract ordinary numbered markdown lists", () => {
    expect(extractMarkdownTodos("1. Read files\n2. Update tests")).toEqual([]);
  });

  it("does not extract ordinary bullet markdown lists", () => {
    expect(extractMarkdownTodos("- Parent\n  - Child")).toEqual([]);
  });

  it("strips only checkbox todo lines from assistant text", () => {
    expect(stripMarkdownTodoLines("Want me to start?\n- [ ] Read\n1. Write")).toBe("Want me to start?\n1. Write");
  });
});
