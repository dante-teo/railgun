import { embedText } from "../persistence/embedder.js";
import { registry } from "./registry.js";
import { extractString } from "./args.js";

registry.register({
  name: "note_search_semantic",
  toolset: "memory",
  verb: "Searching notes by meaning",
  previewArgKey: "query",
  schema: {
    name: "note_search_semantic",
    description:
      "Search the user's imported notes by MEANING, not exact keywords. " +
      "Use this when `note_search` (keyword search) finds nothing, or when " +
      "the question is about a broad topic or feeling rather than a specific word. " +
      "If semantic search is unavailable, this tool automatically falls back to keyword search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language question or topic to search for by meaning." },
      },
      required: ["query"],
    },
  },
  handler: async (args, context) => {
    const noteStore = context.noteStore;
    if (!noteStore) {
      return { content: "Error: note search is not available in this context", isError: true };
    }
    const query = extractString(args, "query");
    if (!query) {
      return { content: 'Error: note_search_semantic requires a non-empty "query" argument', isError: true };
    }
    const results = await embedText(query, "query")
      .then(queryVector => noteStore.searchSemantic(queryVector))
      .catch(() => null);
    if (results === null) {
      const keywordResults = noteStore.search(query);
      const keywordContent = keywordResults.length === 0
        ? "No matching notes found."
        : keywordResults.map(r => `[${r.sourcePath ?? "unknown"}] ${r.snippet}`).join("\n\n");
      return {
        content: `Semantic search is unavailable; used keyword search instead.\n\n${keywordContent}`,
        isError: false,
      };
    }
    if (results.length === 0) return { content: "No semantically similar notes found.", isError: false };
    return {
      content: results
        .map(r => `[${r.sourcePath ?? "unknown"}, distance ${r.distance.toFixed(3)}] ${r.content}`)
        .join("\n\n"),
      isError: false,
    };
  },
});
