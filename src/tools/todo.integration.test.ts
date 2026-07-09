import { describe, expect, it } from "vitest";
import { registry } from "./index.js";
import { createTodoStore } from "./todo.js";

const noopContext = (store = createTodoStore()) => ({
  confirmShellCommand: async () => {
    throw new Error("confirmShellCommand should not be called");
  },
  todoStore: store
});

describe("todo tool registry integration", () => {
  it("exposes the todo schema when planning is enabled", () => {
    const schemas = registry.getSchemas(["planning"]);

    expect(schemas.some(schema => schema.name === "todo")).toBe(true);
  });

  it("updates the caller-owned store from a scripted tool call", async () => {
    const store = createTodoStore();
    const result = await registry.run("todo", { todos: [{ id: "a", content: "A" }] }, noopContext(store));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({
      todos: [{ id: "a", content: "A", status: "pending" }],
      summary: { total: 1, pending: 1, in_progress: 0, completed: 0, cancelled: 0 }
    });
    expect(store.read()).toEqual([{ id: "a", content: "A", status: "pending" }]);
  });

  it("does not leak between separate stores", async () => {
    const first = createTodoStore();
    const second = createTodoStore();

    await registry.run("todo", { todos: [{ id: "a", content: "A" }] }, noopContext(first));

    expect(first.read()).toHaveLength(1);
    expect(second.read()).toEqual([]);
  });

  it("rejects non-list todos with an error instead of wiping the store", async () => {
    const store = createTodoStore([{ id: "a", content: "A" }]);
    const result = await registry.run("todo", { todos: {} }, noopContext(store));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("todos must be a list");
    expect(store.read()).toHaveLength(1);
  });

  it("rejects an unparseable string todos with an error", async () => {
    const store = createTodoStore([{ id: "a", content: "A" }]);
    const result = await registry.run("todo", { todos: "not json" }, noopContext(store));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unparseable string");
    expect(store.read()).toHaveLength(1);
  });

  it("parses a JSON string todos into a list", async () => {
    const store = createTodoStore();
    const jsonString = JSON.stringify([{ id: "a", content: "A", status: "pending" }]);
    const result = await registry.run("todo", { todos: jsonString }, noopContext(store));

    expect(result.isError).toBe(false);
    expect(store.read()).toEqual([{ id: "a", content: "A", status: "pending" }]);
  });

  it("treats null todos as a read instead of erroring", async () => {
    const store = createTodoStore([{ id: "a", content: "A" }]);
    const result = await registry.run("todo", { todos: null }, noopContext(store));

    expect(result.isError).toBe(false);
    expect(store.read()).toHaveLength(1);
    expect(JSON.parse(result.content).todos).toEqual([{ id: "a", content: "A", status: "pending" }]);
  });
});
