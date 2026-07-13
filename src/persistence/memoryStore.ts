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
  all(): readonly Memory[];
  delete(id: string): boolean;
  update(id: string, content: string, category: string): Memory | null;
  runInTransaction(fn: () => void): void;
}

export const formatMemoriesForPrompt = (memories: readonly Memory[]): string | null =>
  memories.length > 0
    ? memories.map(m => `- ${m.content}`).join("\n")
    : null;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

interface MemoryRow {
  id: string;
  content: string;
  category: string;
  created_at: number;
}

const isMemoryRow = (row: unknown): row is MemoryRow => {
  if (!isObject(row)) return false;
  if (typeof row["id"] !== "string") return false;
  if (typeof row["content"] !== "string") return false;
  if (typeof row["category"] !== "string") return false;
  if (typeof row["created_at"] !== "number") return false;
  return true;
};

const mapRow = (row: unknown): Memory => {
  if (!isMemoryRow(row)) throw new Error("Invalid memory row from database");
  return { id: row.id, content: row.content, category: row.category, createdAt: row.created_at };
};

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
  const selectAll = db.prepare(
    "SELECT id, content, category, created_at FROM memories ORDER BY created_at ASC, rowid ASC",
  );
  const deleteById = db.prepare("DELETE FROM memories WHERE id = ?");
  const updateById = db.prepare(
    "UPDATE memories SET content = ?, category = ? WHERE id = ? RETURNING id, content, category, created_at",
  );

  const save = (content: string, category: string): Memory => {
    const id = randomUUID();
    const createdAt = Date.now() / 1000;
    insertMemory.run(id, content, category, createdAt);
    return { id, content, category, createdAt };
  };

  const search = (query: string, limit = 10): readonly Memory[] =>
    selectSearch.all(query, limit).map(mapRow);

  const recent = (limit = 20): readonly Memory[] =>
    selectRecent.all(limit).map(mapRow);

  const all = (): readonly Memory[] =>
    selectAll.all().map(mapRow);

  const deleteMemory = (id: string): boolean =>
    deleteById.run(id).changes > 0;

  const update = (id: string, content: string, category: string): Memory | null => {
    const row = updateById.get(content, category, id);
    return row !== undefined ? mapRow(row) : null;
  };

  const runInTransaction = (fn: () => void): void => {
    db.transaction(fn)();
  };

  return { save, search, recent, all, delete: deleteMemory, update, runInTransaction };
};
