import { describe, expect, it } from "vitest";
import {
  createTodoStore,
  deriveTodoProgress,
  normalizeTodoState,
  TODO_CONTENT_LIMIT,
  TODO_NODE_LIMIT,
  TODO_TRUNCATION_MARKER,
} from "./todo.js";

describe("todo state", () => {
  it("reads an empty state from a new store", () => {
    const store = createTodoStore();

    expect(store.read()).toEqual([]);
  });

  it("replace-writes nested todos", () => {
    const store = createTodoStore();

    const result = store.write({
      todos: [{ id: "parent", content: "Parent", children: [{ id: "child", content: "Child", status: "completed" }] }]
    });

    expect(result.todos).toEqual([
      { id: "parent", content: "Parent", status: "pending", children: [{ id: "child", content: "Child", status: "completed" }] }
    ]);
    expect(store.read()).toEqual(result.todos);
  });

  it("merge-updates any node by global id", () => {
    const store = createTodoStore([
      { id: "parent", content: "Parent", status: "pending", children: [{ id: "child", content: "Child", status: "pending" }] }
    ]);

    const result = store.write({ merge: true, todos: [{ id: "child", content: "Child done", status: "completed" }] });

    expect(result.todos).toEqual([
      {
        id: "parent",
        content: "Parent",
        status: "pending",
        children: [{ id: "child", content: "Child done", status: "completed" }]
      }
    ]);
  });

  it("collapses duplicate ids deterministically", () => {
    const normalized = normalizeTodoState([
      { id: "same", content: "first" },
      { id: "same", content: "second" },
      { id: "parent", content: "parent", children: [{ id: "same", content: "nested" }] }
    ]);

    expect(normalized).toEqual([
      { id: "same", content: "first", status: "pending" },
      { id: "parent", content: "parent", status: "pending" }
    ]);
  });

  it("normalizes invalid status to pending", () => {
    const normalized = normalizeTodoState([{ id: "x", content: "X", status: "wat" }]);

    expect(normalized).toEqual([{ id: "x", content: "X", status: "pending" }]);
  });

  it("drops items with blank content so the UI never renders empty todo rows", () => {
    const normalized = normalizeTodoState([
      { id: "blank", content: "   " },
      { id: "missing-content" },
      { id: "ok", content: "Keep me" }
    ]);

    expect(normalized).toEqual([{ id: "ok", content: "Keep me", status: "pending" }]);
  });

  it("truncates oversized content", () => {
    const oversized = "a".repeat(TODO_CONTENT_LIMIT + 10);
    const [item] = normalizeTodoState([{ id: "x", content: oversized }]);

    expect(item?.content).toHaveLength(TODO_CONTENT_LIMIT + TODO_TRUNCATION_MARKER.length);
    expect(item?.content.endsWith(TODO_TRUNCATION_MARKER)).toBe(true);
  });

  it("keeps only the first 256 nodes", () => {
    const normalized = normalizeTodoState(
      Array.from({ length: TODO_NODE_LIMIT + 10 }, (_, i) => ({ id: `id-${i}`, content: `Item ${i}` }))
    );

    expect(normalized).toHaveLength(TODO_NODE_LIMIT);
    expect(normalized.at(-1)?.id).toBe("id-255");
  });

  it("derives parent progress from children and ignores explicit parent completion", () => {
    const [parent] = normalizeTodoState([
      {
        id: "parent",
        content: "Parent",
        status: "completed",
        children: [
          { id: "a", content: "A", status: "completed" },
          { id: "b", content: "B", status: "pending" }
        ]
      }
    ]);

    expect(parent).toBeDefined();
    if (!parent) throw new Error("expected parent");
    expect(deriveTodoProgress(parent)).toEqual({ done: 1, total: 2 });
  });

  it("formatForInjection includes only active pending/in-progress work", () => {
    const store = createTodoStore([
      { id: "pending", content: "Pending", status: "pending" },
      { id: "active", content: "Active", status: "in_progress" },
      { id: "done", content: "Done", status: "completed" },
      { id: "cancelled", content: "Cancelled", status: "cancelled" },
      {
        id: "parent",
        content: "Parent",
        status: "completed",
        children: [{ id: "child", content: "Child", status: "pending" }]
      }
    ]);

    expect(store.formatForInjection()).toContain("pending");
    expect(store.formatForInjection()).toContain("active");
    expect(store.formatForInjection()).toContain("child");
    expect(store.formatForInjection()).not.toContain("done");
    expect(store.formatForInjection()).not.toContain("cancelled");
  });
});
