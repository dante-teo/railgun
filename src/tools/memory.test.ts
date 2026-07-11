import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registry } from "./index.js";
import { createSessionStore } from "../persistence/sessionStore.js";
import { createMemoryStore } from "../persistence/memoryStore.js";
import type { MemoryStore } from "../persistence/memoryStore.js";

describe("memory tool registry integration", () => {
  let dir: string;
  let path: string;
  let memoryStore: MemoryStore;
  let close: () => void;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railgun-memory-tool-test-"));
    path = join(dir, "state.db");
    const sessionStore = createSessionStore(path);
    memoryStore = createMemoryStore(sessionStore.db);
    close = () => sessionStore.close();
  });

  afterEach(async () => {
    close();
    await rm(dir, { recursive: true });
  });

  const makeContext = (store?: MemoryStore) => ({
    signal: new AbortController().signal,
    commandApprovalMode: "manual" as const,
    sessionApprovals: new Set<string>(),
    confirmShellCommand: async () => {
      throw new Error("confirmShellCommand should not be called");
    },
    ...(store !== undefined ? { memoryStore: store } : {}),
  });

  it("exposes both memory_write and memory_search schemas when memory toolset is enabled", () => {
    const schemas = registry.getSchemas(["memory"]);

    expect(schemas.some(s => s.name === "memory_write")).toBe(true);
    expect(schemas.some(s => s.name === "memory_search")).toBe(true);
  });

  it("memory_write with valid args saves and returns Saved.", async () => {
    const result = await registry.run(
      "memory_write",
      { content: "I hate coffee", category: "preference" },
      makeContext(memoryStore),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("Saved.");
    expect(memoryStore.recent()).toHaveLength(1);
    expect(memoryStore.recent()[0]!.content).toBe("I hate coffee");
  });

  it("memory_write with missing content returns isError: true", async () => {
    const result = await registry.run(
      "memory_write",
      { content: "", category: "preference" },
      makeContext(memoryStore),
    );

    expect(result.isError).toBe(true);
  });

  it("memory_write returns isError: true when memoryStore is undefined", async () => {
    const result = await registry.run(
      "memory_write",
      { content: "I hate coffee", category: "preference" },
      makeContext(undefined),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });

  it("memory_search returns formatted results containing [category]", async () => {
    memoryStore.save("I hate coffee", "preference");

    const result = await registry.run(
      "memory_search",
      { query: "coffee" },
      makeContext(memoryStore),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("[preference]");
    expect(result.content).toContain("I hate coffee");
  });

  it("memory_search with no matches returns the no-match message", async () => {
    const result = await registry.run(
      "memory_search",
      { query: "pizza" },
      makeContext(memoryStore),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("No matching memories found.");
  });

  it("memory_search returns isError: true when memoryStore is undefined", async () => {
    const result = await registry.run(
      "memory_search",
      { query: "anything" },
      makeContext(undefined),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });
});
