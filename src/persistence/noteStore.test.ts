import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNoteStore } from "./noteStore.js";
import { createSessionStore } from "./sessionStore.js";

describe("createNoteStore", () => {
  let dbDir: string;
  let dbPath: string;
  let notesDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), "railgun-notestore-db-"));
    dbPath = join(dbDir, "state.db");
    notesDir = await mkdtemp(join(tmpdir(), "railgun-notestore-notes-"));
  });

  afterEach(async () => {
    await rm(dbDir, { recursive: true });
    await rm(notesDir, { recursive: true });
  });

  const openStore = () => {
    const sessionStore = createSessionStore(dbPath);
    const noteStore = createNoteStore(sessionStore.db);
    return { sessionStore, noteStore };
  };

  it("importFolder returns count of chunks for short files (one chunk each)", async () => {
    await writeFile(join(notesDir, "a.md"), "hello world from file a");
    await writeFile(join(notesDir, "b.txt"), "another note in file b");
    const { sessionStore, noteStore } = openStore();
    try {
      const count = noteStore.importFolder(notesDir);
      expect(count).toBe(2);
    } finally {
      sessionStore.close();
    }
  });

  it("importFolder splits a file into multiple chunks when it exceeds chunkWords", async () => {
    // 1001 words → 3 chunks (500 + 500 + 1) with chunkWords=500
    const words = Array.from({ length: 1001 }, (_, i) => `word${i}`).join(" ");
    await writeFile(join(notesDir, "big.md"), words);
    const { sessionStore, noteStore } = openStore();
    try {
      const count = noteStore.importFolder(notesDir, 500);
      expect(count).toBe(3);
    } finally {
      sessionStore.close();
    }
  });

  it("importFolder ignores non-.md/.txt files", async () => {
    await writeFile(join(notesDir, "data.json"), JSON.stringify({ key: "value" }));
    await writeFile(join(notesDir, "note.md"), "a markdown note");
    const { sessionStore, noteStore } = openStore();
    try {
      const count = noteStore.importFolder(notesDir);
      expect(count).toBe(1);
    } finally {
      sessionStore.close();
    }
  });

  it("search returns matching result with correct sourcePath and non-empty snippet", async () => {
    await writeFile(join(notesDir, "osaka.md"), "I visited Osaka in 2023 and loved the street food there");
    await writeFile(join(notesDir, "coding.md"), "My favorite programming language is TypeScript");
    const { sessionStore, noteStore } = openStore();
    try {
      noteStore.importFolder(notesDir);
      const results = noteStore.search("Osaka");
      expect(results).toHaveLength(1);
      expect(results[0]!.sourcePath).toContain("osaka.md");
      expect(results[0]!.snippet.length).toBeGreaterThan(0);
    } finally {
      sessionStore.close();
    }
  });

  it("search returns empty array when no notes match", async () => {
    await writeFile(join(notesDir, "note.md"), "something completely unrelated");
    const { sessionStore, noteStore } = openStore();
    try {
      noteStore.importFolder(notesDir);
      const results = noteStore.search("xyzzy_nonexistent");
      expect(results).toEqual([]);
    } finally {
      sessionStore.close();
    }
  });

  it("search with FTS5-hostile input (parens, quotes, colon) does not crash", async () => {
    await writeFile(join(notesDir, "note.md"), "test note content here");
    const { sessionStore, noteStore } = openStore();
    try {
      noteStore.importFolder(notesDir);
      expect(() => noteStore.search('(bad "query" :star*))')).not.toThrow();
    } finally {
      sessionStore.close();
    }
  });

  it("search with only FTS5-hostile chars returns empty array", async () => {
    await writeFile(join(notesDir, "note.md"), "test note");
    const { sessionStore, noteStore } = openStore();
    try {
      noteStore.importFolder(notesDir);
      const results = noteStore.search('":()* ');
      expect(results).toEqual([]);
    } finally {
      sessionStore.close();
    }
  });
});
