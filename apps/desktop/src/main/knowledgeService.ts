import { basename } from "node:path";
import type { BackendRpcCommand } from "./backendSupervisor";
import {
  DreamSummarySchema, InstructionFileListSchema, InstructionFileSchema, MemoryListSchema, MemorySchema,
  NoteResultListSchema,
} from "../shared/schemas";
import type { DreamSummary, InstructionFile, InstructionFileId, InstructionFileSummary, Memory, MemoryMutation, NoteResult, NoteSearchMode } from "../shared/types";

type Call = <T>(command: BackendRpcCommand, validate: (data: unknown) => T) => Promise<T>;
type PickFolder = () => Promise<string | undefined>;
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null) throw new Error("Backend returned an invalid Knowledge response");
  return value as Record<string, unknown>;
};
const sourceName = (value: unknown): string => typeof value === "string" && value.length > 0 ? basename(value) : "Imported note";
const snippet = (value: unknown): string => typeof value === "string" ? value.slice(0, 2_000) : "";

export const createKnowledgeService = (call: Call, pickFolder: PickFolder) => ({
  listMemories: (query?: string): Promise<readonly Memory[]> => call(
    query === undefined || query.trim() === "" ? { type: "memory_list", limit: 100 } : { type: "memory_search", query, limit: 100 },
    data => MemoryListSchema.parse(record(data).memories),
  ),
  createMemory: (value: MemoryMutation): Promise<Memory> => call(
    { type: "memory_create", ...value }, data => MemorySchema.parse(record(data).memory),
  ),
  updateMemory: (id: string, value: MemoryMutation): Promise<Memory> => call(
    { type: "memory_update", memoryId: id, patch: value }, data => MemorySchema.parse(record(data).memory),
  ),
  deleteMemory: (id: string): Promise<void> => call({ type: "memory_delete", memoryId: id }, data => {
    if (data !== undefined) throw new Error("Backend returned unexpected delete data");
  }),
  importNotes: async (): Promise<{ cancelled: true } | { cancelled: false; imported: number }> => {
    const folderPath = await pickFolder();
    if (folderPath === undefined) return { cancelled: true };
    return call({ type: "notes_import", folderPath, semantic: true }, data => {
      const imported = record(data).imported;
      if (!Number.isInteger(imported) || (imported as number) < 0) throw new Error("Backend returned an invalid import count");
      return { cancelled: false as const, imported: imported as number };
    });
  },
  searchNotes: (query: string, mode: NoteSearchMode): Promise<readonly NoteResult[]> => call(
    { type: "notes_search", query, mode, limit: 20 }, data => {
      const notes = record(data).notes;
      if (!Array.isArray(notes)) throw new Error("Backend returned invalid note results");
      return NoteResultListSchema.parse(notes.slice(0, 20).map(item => {
        const note = record(item);
        return {
          id: note.id,
          sourceName: sourceName(note.sourcePath),
          snippet: snippet(mode === "semantic" ? note.content : note.snippet),
          ...(typeof note.distance === "number" ? { distance: note.distance } : {}),
        };
      }));
    },
  ),
  runDream: (): Promise<DreamSummary> => call({ type: "dream_run" }, DreamSummarySchema.parse),
  listInstructionFiles: (): Promise<readonly InstructionFileSummary[]> => call(
    { type: "instruction_files_list" }, data => InstructionFileListSchema.parse(record(data).files),
  ),
  getInstructionFile: (fileId: InstructionFileId): Promise<InstructionFile> => call(
    { type: "instruction_file_get", fileId }, data => InstructionFileSchema.parse(record(data).file),
  ),
  updateInstructionFile: (fileId: InstructionFileId, content: string): Promise<InstructionFile> => call(
    { type: "instruction_file_update", fileId, content }, data => InstructionFileSchema.parse(record(data).file),
  ),
});
