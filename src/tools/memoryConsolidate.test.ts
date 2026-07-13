import { describe, expect, it, vi } from "vitest";
import "../tools/index.js"; // ensure registration
import { registry } from "../tools/registry.js";
import type { ToolContext } from "../tools/registry.js";
import type { Memory, MemoryStore } from "../persistence/memoryStore.js";

const makeContext = (memoryStore?: MemoryStore): ToolContext => {
  const base = {
    confirmShellCommand: async () => false,
    signal: new AbortController().signal,
    commandApprovalMode: "manual" as const,
    sessionApprovals: new Set<string>(),
  };
  return memoryStore !== undefined
    ? ({ ...base, memoryStore } satisfies ToolContext)
    : (base satisfies ToolContext);
};

const makeMemoryStore = () => {
  const memories = new Map<string, Memory>();
  let counter = 0;

  const save = vi.fn<MemoryStore["save"]>((content, category) => {
    const id = `id-${++counter}`;
    const memory: Memory = { id, content, category, createdAt: Date.now() / 1000 };
    memories.set(id, memory);
    return memory;
  });

  const search = vi.fn<MemoryStore["search"]>(() => []);
  const recent = vi.fn<MemoryStore["recent"]>(() => []);
  const all = vi.fn<MemoryStore["all"]>(() => [...memories.values()]);

  const deleteMemory = vi.fn<MemoryStore["delete"]>((id) => {
    const had = memories.has(id);
    memories.delete(id);
    return had;
  });

  const update = vi.fn<MemoryStore["update"]>((id, content, category) => {
    const memory = memories.get(id);
    if (memory === undefined) return null;
    const updated: Memory = { ...memory, content, category };
    memories.set(id, updated);
    return updated;
  });

  const runInTransaction = vi.fn<MemoryStore["runInTransaction"]>((fn) => {
    fn();
  });

  return {
    save,
    search,
    recent,
    all,
    delete: deleteMemory,
    update,
    runInTransaction,
  } satisfies MemoryStore;
};

describe("memory_consolidate tool", () => {
  it("returns error when memoryStore is missing", async () => {
    const result = await registry.run("memory_consolidate", { operations: [] }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });

  it("returns empty result for empty operations array", async () => {
    const store = makeMemoryStore();
    const result = await registry.run("memory_consolidate", { operations: [] }, makeContext(store));
    expect(result.isError).toBe(false);
    expect(result.content).toBe("No operations provided.");
  });

  it("delete action removes memories and reports count", async () => {
    const store = makeMemoryStore();
    store.save("x", "fact"); // id-1
    store.save("y", "fact"); // id-2
    const result = await registry.run(
      "memory_consolidate",
      { operations: [{ action: "delete", ids: ["id-1", "id-2"], reason: "stale" }] },
      makeContext(store),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Deleted 2");
    expect(store.delete).toHaveBeenCalledTimes(2);
  });

  it("merge action deletes source memories and creates a new one", async () => {
    const store = makeMemoryStore();
    store.save("a", "fact"); // id-1
    store.save("b", "fact"); // id-2
    const result = await registry.run(
      "memory_consolidate",
      {
        operations: [{
          action: "merge",
          ids: ["id-1", "id-2"],
          newContent: "merged content",
          category: "fact",
          reason: "duplicate",
        }],
      },
      makeContext(store),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Merged 2");
    expect(store.delete).toHaveBeenCalledWith("id-1");
    expect(store.delete).toHaveBeenCalledWith("id-2");
    expect(store.save).toHaveBeenCalledWith("merged content", "fact");
  });

  it("update action changes memory content", async () => {
    const store = makeMemoryStore();
    store.save("old content", "fact"); // id-1
    const result = await registry.run(
      "memory_consolidate",
      {
        operations: [{
          action: "update",
          ids: ["id-1"],
          newContent: "cleaner content",
          category: "fact",
          reason: "precision",
        }],
      },
      makeContext(store),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Updated");
    expect(store.update).toHaveBeenCalledWith("id-1", "cleaner content", "fact");
  });

  it("merge with fewer than 2 ids returns error message", async () => {
    const store = makeMemoryStore();
    const result = await registry.run(
      "memory_consolidate",
      { operations: [{ action: "merge", ids: ["id-1"], newContent: "x", category: "fact", reason: "r" }] },
      makeContext(store),
    );
    expect(result.isError).toBe(false); // returned in content not isError
    expect(result.content).toContain("Error: merge requires at least 2 ids");
  });

  it("wraps operations in a transaction", async () => {
    const store = makeMemoryStore();
    await registry.run(
      "memory_consolidate",
      { operations: [{ action: "delete", ids: [], reason: "none" }] },
      makeContext(store),
    );
    expect(store.runInTransaction).toHaveBeenCalledOnce();
  });
});
