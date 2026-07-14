import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registry } from "./index.js";
import { createSessionStore } from "../persistence/sessionStore.js";
import type { SessionStore } from "../persistence/sessionStore.js";
import { createNoteStore } from "../persistence/noteStore.js";
import type { NoteStore } from "../persistence/noteStore.js";
import { embedText } from "../persistence/embedder.js";
import type { ToolContext } from "./registry.js";

// The real embedText loads a 120 MB ONNX model — mock the module.
vi.mock("../persistence/embedder.js", () => ({
  embedText: vi.fn(async (_text: string, _kind: "query" | "passage") =>
    new Float32Array(384).fill(0.5),
  ),
}));

describe("note_search_semantic tool registry integration", () => {
  let dir: string;
  let sessionStore: SessionStore;
  let noteStore: NoteStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railgun-semantic-tool-test-"));
    sessionStore = createSessionStore(join(dir, "state.db"));
    noteStore = createNoteStore(sessionStore.db);
  });

  afterEach(async () => {
    sessionStore.close();
    await rm(dir, { recursive: true });
  });

  const makeContext = (store?: NoteStore): ToolContext => ({
    signal: new AbortController().signal,
    commandApprovalMode: "manual" as const,
    sessionApprovals: new Set<string>(),
    confirmShellCommand: async () => {
      throw new Error("confirmShellCommand should not be called");
    },
    ...(store !== undefined ? { noteStore: store } : {}),
  });

  it("exposes note_search_semantic schema in the memory toolset", () => {
    const schemas = registry.getSchemas(["memory"]);
    const schema = schemas.find(s => s.name === "note_search_semantic");

    expect(schema).toBeDefined();
    expect(schema?.description).toContain("automatically falls back to keyword search");
  });

  it("returns isError: true when noteStore is not in context", async () => {
    const result = await registry.run("note_search_semantic", { query: "anything" }, makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });

  it("returns isError: true for empty query", async () => {
    const result = await registry.run("note_search_semantic", { query: "" }, makeContext(noteStore));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-empty");
  });

  it("returns isError: true when query arg is missing", async () => {
    const result = await registry.run("note_search_semantic", {}, makeContext(noteStore));
    expect(result.isError).toBe(true);
  });

  it("returns no-match message when notes_vec is empty", async () => {
    const result = await registry.run("note_search_semantic", { query: "hiking" }, makeContext(noteStore));
    expect(result.isError).toBe(false);
    expect(result.content).toBe("No semantically similar notes found.");
  });

  it("returns formatted result when a vector match exists", async () => {
    // Insert a note row and store the same vector the mock embedText returns (all 0.5).
    const { lastInsertRowid } = sessionStore.db
      .prepare("INSERT INTO notes (source_path, content, created_at) VALUES (?, ?, ?)")
      .run("/notes/hiking.md", "went hiking this weekend", Date.now() / 1000);
    noteStore.storeVector(Number(lastInsertRowid), new Float32Array(384).fill(0.5));

    const result = await registry.run("note_search_semantic", { query: "outdoor activities" }, makeContext(noteStore));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hiking.md");
    expect(result.content).toContain("hiking");
  });

  it("falls back to keyword search when the semantic embedder is unavailable", async () => {
    sessionStore.db
      .prepare("INSERT INTO notes (source_path, content, created_at) VALUES (?, ?, ?)")
      .run("/notes/hiking.md", "went hiking this weekend", Date.now() / 1000);
    vi.mocked(embedText).mockRejectedValueOnce(new Error("missing native dependency"));

    const result = await registry.run("note_search_semantic", { query: "hiking" }, makeContext(noteStore));

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Semantic search is unavailable; used keyword search instead.");
    expect(result.content).toContain("hiking.md");
    expect(result.content).toContain("hiking");
  });

  it("reports no matches when the semantic embedder and keyword fallback find nothing", async () => {
    vi.mocked(embedText).mockRejectedValueOnce(new Error("missing native dependency"));

    const result = await registry.run("note_search_semantic", { query: "hiking" }, makeContext(noteStore));

    expect(result).toEqual({
      content: "Semantic search is unavailable; used keyword search instead.\n\nNo matching notes found.",
      isError: false,
    });
  });

  it("falls back successfully when a natural-language query contains punctuation", async () => {
    sessionStore.db
      .prepare("INSERT INTO notes (source_path, content, created_at) VALUES (?, ?, ?)")
      .run("/notes/update.md", "what's new with foo-bar", Date.now() / 1000);
    vi.mocked(embedText).mockRejectedValueOnce(new Error("missing native dependency"));

    const result = await registry.run(
      "note_search_semantic",
      { query: "what's new with foo-bar?" },
      makeContext(noteStore),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("update.md");
  });
});
