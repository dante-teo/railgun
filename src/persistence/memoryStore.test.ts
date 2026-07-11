import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, formatMemoriesForPrompt } from "./memoryStore.js";
import { createSessionStore } from "./sessionStore.js";

describe("createMemoryStore", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railgun-memory-test-"));
    path = join(dir, "state.db");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true });
  });

  const openStore = () => {
    const sessionStore = createSessionStore(path);
    const memoryStore = createMemoryStore(sessionStore.db);
    return { sessionStore, memoryStore };
  };

  it("save returns a Memory with a UUID id, correct content and category, and a numeric createdAt", () => {
    const { sessionStore, memoryStore } = openStore();
    try {
      const memory = memoryStore.save("I am vegetarian", "preference");

      expect(memory.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(memory.content).toBe("I am vegetarian");
      expect(memory.category).toBe("preference");
      expect(typeof memory.createdAt).toBe("number");
      expect(memory.createdAt).toBeGreaterThan(0);
    } finally {
      sessionStore.close();
    }
  });

  it("recent returns memories newest-first", () => {
    const { sessionStore, memoryStore } = openStore();
    try {
      memoryStore.save("first", "fact");
      memoryStore.save("second", "fact");
      memoryStore.save("third", "fact");

      const results = memoryStore.recent();

      expect(results.map(m => m.content)).toEqual(["third", "second", "first"]);
    } finally {
      sessionStore.close();
    }
  });

  it("recent respects limit parameter", () => {
    const { sessionStore, memoryStore } = openStore();
    try {
      memoryStore.save("a", "fact");
      memoryStore.save("b", "fact");
      memoryStore.save("c", "fact");

      const results = memoryStore.recent(2);

      expect(results).toHaveLength(2);
      expect(results[0]!.content).toBe("c");
    } finally {
      sessionStore.close();
    }
  });

  it("search returns only memories matching the query, case-insensitively", () => {
    const { sessionStore, memoryStore } = openStore();
    try {
      memoryStore.save("I hate coffee", "preference");
      memoryStore.save("I love tea", "preference");
      memoryStore.save("My project is Railgun", "project");

      const results = memoryStore.search("COFFEE");

      expect(results).toHaveLength(1);
      expect(results[0]!.content).toBe("I hate coffee");
    } finally {
      sessionStore.close();
    }
  });

  it("search with no matches returns an empty array", () => {
    const { sessionStore, memoryStore } = openStore();
    try {
      memoryStore.save("I hate coffee", "preference");

      const results = memoryStore.search("pizza");

      expect(results).toEqual([]);
    } finally {
      sessionStore.close();
    }
  });

  it("memories persist across store re-opens", () => {
    const sessionStore = createSessionStore(path);
    const memoryStore = createMemoryStore(sessionStore.db);
    memoryStore.save("I am vegetarian", "preference");
    sessionStore.close();

    const sessionStore2 = createSessionStore(path);
    const memoryStore2 = createMemoryStore(sessionStore2.db);
    const results = memoryStore2.recent();
    sessionStore2.close();

    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("I am vegetarian");
  });
});

describe("formatMemoriesForPrompt", () => {
  it("returns null for an empty array", () => {
    expect(formatMemoriesForPrompt([])).toBeNull();
  });

  it("returns formatted string for non-empty array", () => {
    const memories = [
      { id: "a", content: "I am vegetarian", category: "preference", createdAt: 1 },
      { id: "b", content: "My project is Railgun", category: "project", createdAt: 2 },
    ];
    const result = formatMemoriesForPrompt(memories);

    expect(result).toBe("- I am vegetarian\n- My project is Railgun");
  });
});
