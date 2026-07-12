import type Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface NoteSearchResult {
  id: number;
  sourcePath: string | null;
  snippet: string;
}

export interface NoteStore {
  search(query: string, limit?: number): readonly NoteSearchResult[];
  importFolder(folderPath: string, chunkWords?: number): number;
}

const sanitizeFts5Query = (raw: string): string =>
  raw.replace(/["():*]/g, " ").trim();

export const createNoteStore = (db: Database.Database): NoteStore => {
  const insertNote = db.prepare(
    "INSERT INTO notes (source_path, content, created_at) VALUES (?, ?, ?)",
  );

  const selectSearch = db.prepare(`
    SELECT n.id, n.source_path, snippet(notes_fts, 0, '>>>', '<<<', '...', 30) AS snippet
    FROM notes_fts
    JOIN notes n ON n.id = notes_fts.rowid
    WHERE notes_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  const search = (query: string, limit = 5): readonly NoteSearchResult[] => {
    const sanitized = sanitizeFts5Query(query);
    if (sanitized.length === 0) return [];
    return (selectSearch.all(sanitized, limit) as Record<string, unknown>[]).map(row => ({
      id: row["id"] as number,
      sourcePath: row["source_path"] as string | null,
      snippet: row["snippet"] as string,
    }));
  };

  const importFolder = (folderPath: string, chunkWords = 500): number => {
    const entries = readdirSync(folderPath);
    let totalChunks = 0;
    db.transaction(() => {
      for (const entry of entries) {
        if (!/\.(md|txt)$/.test(entry)) continue;
        const fullPath = join(folderPath, entry);
        const words = readFileSync(fullPath, "utf-8").split(/\s+/).filter(w => w.length > 0);
        for (let i = 0; i < words.length; i += chunkWords) {
          insertNote.run(fullPath, words.slice(i, i + chunkWords).join(" "), Date.now() / 1000);
          totalChunks++;
        }
      }
    })();
    return totalChunks;
  };

  return { search, importFolder };
};
