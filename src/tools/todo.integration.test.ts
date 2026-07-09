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
      summary: { total: 1, completed: 0, active: 1 }
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
});
