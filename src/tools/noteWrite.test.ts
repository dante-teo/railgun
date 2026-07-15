import { describe, expect, it, vi } from "vitest";
import { registry } from "./registry.js";
import type { ToolContext } from "./registry.js";
import "./noteWrite.js";
import type { NoteStore } from "../persistence/noteStore.js";

const context = (noteStore?: NoteStore): ToolContext => ({
  signal: new AbortController().signal,
  commandApprovalMode: "manual",
  sessionApprovals: new Set(),
  confirmShellCommand: async () => { throw new Error("note_write must not request shell approval"); },
  ...(noteStore !== undefined ? { noteStore } : {}),
});

const makeNoteStore = (overrides: Partial<NoteStore> = {}): NoteStore => ({
  search: vi.fn(() => []),
  searchSemantic: vi.fn(() => []),
  storeVector: vi.fn(),
  write: vi.fn(() => ({ id: 1, sourcePath: null, snippet: "saved note" })),
  importFolder: vi.fn(() => 0),
  importFolderWithEmbeddings: vi.fn(async () => 0),
  backfillEmbeddings: vi.fn(async () => 0),
  ...overrides,
} satisfies NoteStore);

describe("note_write", () => {
  it("writes a note and confirms it was saved", async () => {
    const write = vi.fn(() => ({ id: 7, sourcePath: null, snippet: "TypeScript tips" }));
    const result = await registry.run("note_write", { content: "TypeScript tips for the project." }, context(makeNoteStore({ write })));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("saved");
    expect(write).toHaveBeenCalledWith("TypeScript tips for the project.", undefined);
  });

  it("accepts an optional title used as the note source label", async () => {
    const write = vi.fn(() => ({ id: 2, sourcePath: "Meeting notes", snippet: "standup" }));
    await registry.run("note_write", { content: "Standup notes.", title: "Meeting notes" }, context(makeNoteStore({ write })));
    expect(write).toHaveBeenCalledWith("Standup notes.", "Meeting notes");
  });

  it("returns an error when content is missing", async () => {
    const result = await registry.run("note_write", {}, context(makeNoteStore()));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("content");
  });

  it("returns an error when content is empty", async () => {
    const result = await registry.run("note_write", { content: "   " }, context(makeNoteStore()));
    expect(result.isError).toBe(true);
  });

  it("returns an error when noteStore is unavailable", async () => {
    const result = await registry.run("note_write", { content: "some note" }, context(undefined));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });
});

describe("note_write toolset registration", () => {
  it("is exposed under the memory toolset", () => {
    const schemas = registry.getSchemas(["memory"]);
    expect(schemas.some(s => s.name === "note_write")).toBe(true);
  });

  it("is not exposed when memory toolset is excluded", () => {
    const schemas = registry.getSchemas(["file", "terminal", "planning"]);
    expect(schemas.some(s => s.name === "note_write")).toBe(false);
  });
});
