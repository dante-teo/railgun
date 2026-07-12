import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registry } from "./index.js";
import { createSessionStore } from "../persistence/sessionStore.js";
import { createNoteStore } from "../persistence/noteStore.js";
import type { NoteStore } from "../persistence/noteStore.js";

describe("note_search tool registry integration", () => {
  let dir: string;
  let dbPath: string;
  let notesDir: string;
  let noteStore: NoteStore;
  let close: () => void;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railgun-notesearch-tool-test-"));
    dbPath = join(dir, "state.db");
    notesDir = await mkdtemp(join(tmpdir(), "railgun-notesearch-notes-"));
    const sessionStore = createSessionStore(dbPath);
    noteStore = createNoteStore(sessionStore.db);
    close = () => sessionStore.close();
  });

  afterEach(async () => {
    close();
    await rm(dir, { recursive: true });
    await rm(notesDir, { recursive: true });
  });

  const makeContext = (store?: NoteStore) => ({
    signal: new AbortController().signal,
    commandApprovalMode: "manual" as const,
    sessionApprovals: new Set<string>(),
    confirmShellCommand: async () => {
      throw new Error("confirmShellCommand should not be called");
    },
    ...(store !== undefined ? { noteStore: store } : {}),
  });

  it("exposes note_search schema in the memory toolset", () => {
    const schemas = registry.getSchemas(["memory"]);
    expect(schemas.some(s => s.name === "note_search")).toBe(true);
  });

  it("returns isError: true when noteStore is not in context", async () => {
    const result = await registry.run("note_search", { query: "anything" }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });

  it("returns isError: true for empty query", async () => {
    const result = await registry.run("note_search", { query: "" }, makeContext(noteStore));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-empty");
  });

  it("returns isError: true when query arg is missing", async () => {
    const result = await registry.run("note_search", {}, makeContext(noteStore));
    expect(result.isError).toBe(true);
  });

  it("returns no-match message when notes contain no matching content", async () => {
    await writeFile(join(notesDir, "a.md"), "completely unrelated content here");
    noteStore.importFolder(notesDir);
    const result = await registry.run("note_search", { query: "xyzzy_never_matches" }, makeContext(noteStore));
    expect(result.isError).toBe(false);
    expect(result.content).toBe("No matching notes found.");
  });

  it("returns snippet containing the matched note path when a match exists", async () => {
    await writeFile(join(notesDir, "cooking.md"), "I love making ramen at home with homemade broth");
    noteStore.importFolder(notesDir);
    const result = await registry.run("note_search", { query: "ramen" }, makeContext(noteStore));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("cooking.md");
  });
});
