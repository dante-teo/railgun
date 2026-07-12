import type Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface NoteSearchResult {
  id: number;
  sourcePath: string | null;
  snippet: string;
}

export interface NoteSemanticResult {
  id: number;
  sourcePath: string | null;
  content: string;
  distance: number;
}

export type EmbedFn = (text: string, kind: "query" | "passage") => Promise<Float32Array>;

export interface NoteStore {
  search(query: string, limit?: number): readonly NoteSearchResult[];
  searchSemantic(queryVector: Float32Array, limit?: number): readonly NoteSemanticResult[];
  storeVector(noteId: number, embedding: Float32Array): void;
  importFolder(folderPath: string, chunkWords?: number): number;
  importFolderWithEmbeddings(folderPath: string, embedFn: EmbedFn, chunkWords?: number): Promise<number>;
  backfillEmbeddings(embedFn: EmbedFn): Promise<number>;
}

// Typed shapes for raw better-sqlite3 rows — one unchecked cast at the array
// boundary; properties are then read without further assertions.
interface SearchRow { id: number; source_path: string | null; snippet: string }
interface SemanticRow { rowid: number; distance: number; source_path: string | null; content: string }
interface UnembeddedRow { id: number; content: string }

const sanitizeFts5Query = (raw: string): string =>
  raw.replace(/["():*]/g, " ").trim();

/** Yield every .md/.txt file in `folderPath` as word-chunks of `chunkWords`. */
function* readChunks(
  folderPath: string,
  chunkWords: number,
): Generator<{ fullPath: string; chunk: string }> {
  for (const entry of readdirSync(folderPath)) {
    if (!/\.(md|txt)$/.test(entry)) continue;
    const fullPath = join(folderPath, entry);
    const words = readFileSync(fullPath, "utf-8").split(/\s+/).filter(w => w.length > 0);
    for (let i = 0; i < words.length; i += chunkWords) {
      yield { fullPath, chunk: words.slice(i, i + chunkWords).join(" ") };
    }
  }
}

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

  const insertVec = db.prepare(
    "INSERT INTO notes_vec (rowid, embedding) VALUES (?, ?)",
  );

  const selectSemantic = db.prepare(`
    SELECT knn.rowid, knn.distance, n.source_path, n.content
    FROM (
      SELECT rowid, distance
      FROM notes_vec
      WHERE embedding MATCH ?
        AND k = ?
    ) AS knn
    JOIN notes n ON n.id = knn.rowid
    ORDER BY knn.distance
  `);

  const selectUnembedded = db.prepare(`
    SELECT n.id, n.content
    FROM notes n
    WHERE n.id NOT IN (SELECT rowid FROM notes_vec)
    ORDER BY n.id
  `);

  const search = (query: string, limit = 5): readonly NoteSearchResult[] => {
    const sanitized = sanitizeFts5Query(query);
    if (sanitized.length === 0) return [];
    return (selectSearch.all(sanitized, limit) as SearchRow[]).map(row => ({
      id: row.id,
      sourcePath: row.source_path,
      snippet: row.snippet,
    }));
  };

  const storeVector = (noteId: number, embedding: Float32Array): void => {
    insertVec.run(BigInt(noteId), embedding);
  };

  const searchSemantic = (queryVector: Float32Array, limit = 5): readonly NoteSemanticResult[] =>
    (selectSemantic.all(queryVector, limit) as SemanticRow[]).map(row => ({
      id: row.rowid,
      sourcePath: row.source_path,
      content: row.content,
      distance: row.distance,
    }));

  const importFolder = (folderPath: string, chunkWords = 500): number => {
    let count = 0;
    db.transaction(() => {
      for (const { fullPath, chunk } of readChunks(folderPath, chunkWords)) {
        insertNote.run(fullPath, chunk, Date.now() / 1000);
        count++;
      }
    })();
    return count;
  };

  const importFolderWithEmbeddings = async (
    folderPath: string,
    embedFn: EmbedFn,
    chunkWords = 500,
  ): Promise<number> => {
    let count = 0;
    for (const { fullPath, chunk } of readChunks(folderPath, chunkWords)) {
      const { lastInsertRowid } = insertNote.run(fullPath, chunk, Date.now() / 1000);
      storeVector(Number(lastInsertRowid), await embedFn(chunk, "passage"));
      count++;
    }
    return count;
  };

  const backfillEmbeddings = async (embedFn: EmbedFn): Promise<number> => {
    const rows = selectUnembedded.all() as UnembeddedRow[];
    for (const row of rows) {
      storeVector(row.id, await embedFn(row.content, "passage"));
    }
    return rows.length;
  };

  return { search, searchSemantic, storeVector, importFolder, importFolderWithEmbeddings, backfillEmbeddings };
};
