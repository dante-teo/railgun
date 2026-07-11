import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface Memory {
  id: string;
  content: string;
  category: string;
  createdAt: number;
}

export interface MemoryStore {
  save(content: string, category: string): Memory;
  search(query: string, limit?: number): readonly Memory[];
  recent(limit?: number): readonly Memory[];
}

export const formatMemoriesForPrompt = (memories: readonly Memory[]): string | null =>
  memories.length > 0
    ? memories.map(m => `- ${m.content}`).join("\n")
    : null;

export const createMemoryStore = (db: Database.Database): MemoryStore => {
  const insertMemory = db.prepare(
    "INSERT INTO memories (id, content, category, created_at) VALUES (?, ?, ?, ?)",
  );
  const selectRecent = db.prepare(
    "SELECT id, content, category, created_at FROM memories ORDER BY created_at DESC, rowid DESC LIMIT ?",
  );
  const selectSearch = db.prepare(
    "SELECT id, content, category, created_at FROM memories WHERE content LIKE '%' || ? || '%' COLLATE NOCASE ORDER BY created_at DESC, rowid DESC LIMIT ?",
  );

  const mapRow = (row: Record<string, unknown>): Memory => ({
    id: row["id"] as string,
    content: row["content"] as string,
    category: row["category"] as string,
    createdAt: row["created_at"] as number,
  });

  const save = (content: string, category: string): Memory => {
    const id = randomUUID();
    const createdAt = Date.now() / 1000;
    insertMemory.run(id, content, category, createdAt);
    return { id, content, category, createdAt };
  };

  const search = (query: string, limit = 10): readonly Memory[] =>
    (selectSearch.all(query, limit) as Record<string, unknown>[]).map(mapRow);

  const recent = (limit = 20): readonly Memory[] =>
    (selectRecent.all(limit) as Record<string, unknown>[]).map(mapRow);

  return { save, search, recent };
};
