import { describe, expect, it } from "vitest";
import {
  createTodoStore,
  normalizeTodoState,
  summarizeTodos,
  TODO_CONTENT_LIMIT,
  TODO_NODE_LIMIT,
  TODO_TRUNCATION_MARKER,
} from "./todo.js";

describe("todo state", () => {
  it("reads an empty state from a new store", () => {
    const store = createTodoStore();

    expect(store.read()).toEqual([]);
  });

  it("replace-writes flat todos", () => {
    const store = createTodoStore();

    const result = store.write({
      todos: [{ id: "a", content: "A" }],
    });

    expect(result.todos).toEqual([{ id: "a", content: "A", status: "pending" }]);
    expect(store.read()).toEqual(result.todos);
  });

  it("merge-updates any node by global id", () => {
    const store = createTodoStore([
      { id: "a", content: "Alpha", status: "pending" },
      { id: "b", content: "Beta", status: "in_progress" },
    ]);

    const result = store.write({
      merge: true,
      todos: [{ id: "b", content: "Beta done", status: "completed" }],
    });

    expect(result.todos).toEqual([
      { id: "a", content: "Alpha", status: "pending" },
      { id: "b", content: "Beta done", status: "completed" },
    ]);
  });

  it("merge-update status only (regression: merge-drop bug)", () => {
    const store = createTodoStore([
      { id: "a", content: "Original", status: "pending" },
    ]);

    const result = store.write({
      merge: true,
      todos: [{ id: "a", status: "completed" }],
    });

    expect(result.todos).toEqual([
      { id: "a", content: "Original", status: "completed" },
    ]);
  });

  it("merge-update content only", () => {
    const store = createTodoStore([
      { id: "a", content: "Original", status: "in_progress" },
    ]);

    const result = store.write({
      merge: true,
      todos: [{ id: "a", content: "Revised" }],
    });

    expect(result.todos).toEqual([
      { id: "a", content: "Revised", status: "in_progress" },
    ]);
  });

  it("merge appends new items after existing ones", () => {
    const store = createTodoStore([
      { id: "a", content: "Alpha", status: "pending" },
    ]);

    const result = store.write({
      merge: true,
      todos: [{ id: "b", content: "Beta" }],
    });

    expect(result.todos).toEqual([
      { id: "a", content: "Alpha", status: "pending" },
      { id: "b", content: "Beta", status: "pending" },
    ]);
  });

  it("collapses duplicate ids keeping last occurrence", () => {
    const normalized = normalizeTodoState([
      { id: "same", content: "first" },
      { id: "same", content: "second" },
    ]);

    expect(normalized).toEqual([
      { id: "same", content: "second", status: "pending" },
    ]);
  });

  it("normalizes invalid status to pending", () => {
    const normalized = normalizeTodoState([{ id: "x", content: "X", status: "wat" }]);

    expect(normalized).toEqual([{ id: "x", content: "X", status: "pending" }]);
  });

  it("coerces items with blank content to placeholder", () => {
    const normalized = normalizeTodoState([
      { id: "blank", content: "   " },
      { id: "missing-content" },
      { id: "ok", content: "Keep me" },
    ]);

    expect(normalized).toEqual([
      { id: "blank", content: "(no description)", status: "pending" },
      { id: "missing-content", content: "(no description)", status: "pending" },
      { id: "ok", content: "Keep me", status: "pending" },
    ]);
  });

  it("coerces blank/missing id to '?'", () => {
    const normalized = normalizeTodoState([
      { id: "", content: "no id" },
      { id: "   ", content: "whitespace id" },
    ]);

    // Both get id "?", last-occurrence-wins via dedupe
    expect(normalized).toEqual([
      { id: "?", content: "whitespace id", status: "pending" },
    ]);
  });

  it("coerces non-object items to invalid-item placeholders", () => {
    const normalized = normalizeTodoState([
      42,
      "hello",
      { id: "ok", content: "Valid" },
    ]);

    expect(normalized).toEqual([
      { id: "?", content: "(invalid item)", status: "pending" },
      { id: "?", content: "(invalid item)", status: "pending" },
      { id: "ok", content: "Valid", status: "pending" },
    ]);
  });

  it("truncates oversized content to exactly TODO_CONTENT_LIMIT chars", () => {
    const oversized = "a".repeat(TODO_CONTENT_LIMIT + 10);
    const [item] = normalizeTodoState([{ id: "x", content: oversized }]);

    expect(item?.content).toHaveLength(TODO_CONTENT_LIMIT);
    expect(item?.content.endsWith(TODO_TRUNCATION_MARKER)).toBe(true);
    expect(item?.content.slice(0, -TODO_TRUNCATION_MARKER.length)).toHaveLength(TODO_CONTENT_LIMIT - TODO_TRUNCATION_MARKER.length);
  });

  it("keeps only the first 256 nodes", () => {
    const normalized = normalizeTodoState(
      Array.from({ length: TODO_NODE_LIMIT + 10 }, (_, i) => ({ id: `id-${i}`, content: `Item ${i}` })),
    );

    expect(normalized).toHaveLength(TODO_NODE_LIMIT);
    expect(normalized.at(-1)?.id).toBe("id-255");
  });

  it("normalizes uppercase status to lowercase", () => {
    const normalized = normalizeTodoState([
      { id: "a", content: "A", status: "COMPLETED" },
      { id: "b", content: "B", status: "In_Progress" },
    ]);

    expect(normalized).toEqual([
      { id: "a", content: "A", status: "completed" },
      { id: "b", content: "B", status: "in_progress" },
    ]);
  });

  it("does not truncate long ids", () => {
    const longId = "x".repeat(TODO_CONTENT_LIMIT + 100);
    const [item] = normalizeTodoState([{ id: longId, content: "test" }]);

    expect(item?.id).toBe(longId);
  });

  it("summarizeTodos returns four-way breakdown", () => {
    const todos = normalizeTodoState([
      { id: "a", content: "A", status: "pending" },
      { id: "b", content: "B", status: "in_progress" },
      { id: "c", content: "C", status: "completed" },
      { id: "d", content: "D", status: "cancelled" },
    ]);

    expect(summarizeTodos(todos)).toEqual({
      total: 4,
      pending: 1,
      in_progress: 1,
      completed: 1,
      cancelled: 1,
    });
  });

  it("formatForInjection includes only active pending/in-progress work", () => {
    const store = createTodoStore([
      { id: "pending", content: "Pending", status: "pending" },
      { id: "active", content: "Active", status: "in_progress" },
      { id: "done", content: "Done", status: "completed" },
      { id: "cancelled", content: "Cancelled", status: "cancelled" },
    ]);

    const injection = store.formatForInjection();
    expect(injection).toContain("[Your active task list was preserved across context compression]");
    expect(injection).toContain("- [ ] pending. Pending (pending)");
    expect(injection).toContain("- [>] active. Active (in_progress)");
    expect(injection).not.toContain("done");
    expect(injection).not.toContain("cancelled");
  });

  it("formatForInjection returns empty string when no active items", () => {
    const store = createTodoStore([
      { id: "done", content: "Done", status: "completed" },
    ]);

    expect(store.formatForInjection()).toBe("");
  });
});
