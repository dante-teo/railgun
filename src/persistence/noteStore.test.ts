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

  it.each(["what's", "foo-bar", "me@example.com"])(
    "search safely handles natural-language punctuation in %s",
    async query => {
      await writeFile(join(notesDir, "note.md"), "what's new with foo-bar? Contact me@example.com");
      const { sessionStore, noteStore } = openStore();
      try {
        noteStore.importFolder(notesDir);

        expect(noteStore.search(query)).toHaveLength(1);
      } finally {
        sessionStore.close();
      }
    },
  );

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

  // ── Vector / semantic search ──────────────────────────────────────────────

  const makeVec = (fill: number): Float32Array => new Float32Array(384).fill(fill);

  it("storeVector + searchSemantic: round-trip returns the stored note at distance ~0", () => {
    const { sessionStore, noteStore } = openStore();
    try {
      // Insert a note via importFolder so FTS5 trigger fires, then storeVector manually
      // using the id obtained from importFolder's side-effect on notes table.
      noteStore.importFolder(notesDir); // empty dir → 0 chunks; table exists
      // Insert directly so we control the id
      const db = sessionStore.db;
      const { lastInsertRowid } = db
        .prepare("INSERT INTO notes (source_path, content, created_at) VALUES (?, ?, ?)")
        .run("/test/hiking.md", "went hiking this weekend loved it", Date.now() / 1000);
      const noteId = Number(lastInsertRowid);

      const vec = makeVec(0.5);
      noteStore.storeVector(noteId, vec);

      const results = noteStore.searchSemantic(vec);
      expect(results).toHaveLength(1);
      expect(results[0]!.sourcePath).toBe("/test/hiking.md");
      expect(results[0]!.content).toContain("hiking");
      expect(results[0]!.distance).toBeCloseTo(0, 3);
    } finally {
      sessionStore.close();
    }
  });

  it("searchSemantic returns empty array when notes_vec is empty", () => {
    const { sessionStore, noteStore } = openStore();
    try {
      const results = noteStore.searchSemantic(makeVec(0.1));
      expect(results).toEqual([]);
    } finally {
      sessionStore.close();
    }
  });

  it("importFolderWithEmbeddings: inserts chunks and stores vectors via embedFn", async () => {
    await writeFile(join(notesDir, "a.md"), "first note content here");
    await writeFile(join(notesDir, "b.md"), "second note content here");
    const { sessionStore, noteStore } = openStore();
    try {
      const fakeEmbed = async (_text: string, _kind: "query" | "passage") => makeVec(0.7);
      const count = await noteStore.importFolderWithEmbeddings(notesDir, fakeEmbed);
      expect(count).toBe(2);
      // searchSemantic should find both via the stored vector
      const results = noteStore.searchSemantic(makeVec(0.7));
      expect(results.length).toBe(2);
    } finally {
      sessionStore.close();
    }
  });

  it("backfillEmbeddings: embeds notes imported without vectors, is idempotent", async () => {
    await writeFile(join(notesDir, "old.md"), "old note imported before phase 27");
    const { sessionStore, noteStore } = openStore();
    try {
      // Sync import — inserts note rows + FTS5 but no vectors
      noteStore.importFolder(notesDir);

      const fakeEmbed = async (_text: string, _kind: "query" | "passage") => makeVec(0.3);

      // First backfill: should embed 1 note
      const backfilled = await noteStore.backfillEmbeddings(fakeEmbed);
      expect(backfilled).toBe(1);

      // searchSemantic should now find it
      const results = noteStore.searchSemantic(makeVec(0.3));
      expect(results.length).toBe(1);
      expect(results[0]!.content).toContain("old note");

      // Second backfill: nothing left to embed
      const backfilledAgain = await noteStore.backfillEmbeddings(fakeEmbed);
      expect(backfilledAgain).toBe(0);
    } finally {
      sessionStore.close();
    }
  });

  it("backfillEmbeddings: recovers chunks skipped by a partial importFolderWithEmbeddings", async () => {
    await writeFile(join(notesDir, "a.md"), "first chunk");
    await writeFile(join(notesDir, "b.md"), "second chunk");
    const { sessionStore, noteStore } = openStore();
    try {
      let callCount = 0;
      const flakyEmbed = async (_text: string, _kind: "query" | "passage"): Promise<Float32Array> => {
        callCount++;
        if (callCount > 1) throw new Error("network failure");
        return makeVec(0.9);
      };

      // importFolderWithEmbeddings inserts both note rows but only stores 1 vector
      await expect(noteStore.importFolderWithEmbeddings(notesDir, flakyEmbed)).rejects.toThrow("network failure");

      const goodEmbed = async (_text: string, _kind: "query" | "passage") => makeVec(0.9);
      const backfilled = await noteStore.backfillEmbeddings(goodEmbed);
      // Exactly 1 note was left without a vector
      expect(backfilled).toBe(1);
    } finally {
      sessionStore.close();
    }
  });
});
