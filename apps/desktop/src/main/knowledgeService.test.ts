import { describe, expect, it, vi } from "vitest";
import { createKnowledgeService } from "./knowledgeService";

describe("Knowledge service", () => {
  it("keeps a cancelled native picker away from the backend", async () => {
    const call = vi.fn();
    const service = createKnowledgeService(call, async () => undefined);
    await expect(service.importNotes()).resolves.toEqual({ cancelled: true });
    expect(call).not.toHaveBeenCalled();
  });

  it("imports semantically without returning the selected path", async () => {
    const call = vi.fn(async (command, validate) => validate({ imported: 3 }));
    const service = createKnowledgeService(call, async () => "/private/user/Notes");
    await expect(service.importNotes()).resolves.toEqual({ cancelled: false, imported: 3 });
    expect(call.mock.calls[0]?.[0]).toEqual({ type: "notes_import", folderPath: "/private/user/Notes", semantic: true });
  });

  it("bounds note results and redacts source directories", async () => {
    const notes = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1, sourcePath: `/Users/private/project/file-${index}.md`, content: "x".repeat(3_000), distance: .1,
    }));
    const service = createKnowledgeService(async (_command, validate) => validate({ notes }), async () => undefined);
    const results = await service.searchNotes("query", "semantic");
    expect(results).toHaveLength(20);
    expect(results[0]?.sourceName).toBe("file-0.md");
    expect(results[0]?.snippet).toHaveLength(2_000);
    expect(JSON.stringify(results)).not.toContain("/Users/private");
  });
});
