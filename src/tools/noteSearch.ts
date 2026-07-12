import { registry } from "./registry.js";

const extractString = (args: unknown, key: string): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

registry.register({
  name: "note_search",
  toolset: "memory",
  verb: "Searching notes",
  previewArgKey: "query",
  schema: {
    name: "note_search",
    description:
      "Search the user's imported notes by keyword. " +
      "Use this before saying 'I don't know' about something the user might " +
      "have written down before.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or phrase to search for in imported notes." },
      },
      required: ["query"],
    },
  },
  handler: async (args, context) => {
    if (!context.noteStore) {
      return { content: "Error: note search is not available in this context", isError: true };
    }
    const query = extractString(args, "query");
    if (!query) {
      return { content: 'Error: note_search requires a non-empty "query" argument', isError: true };
    }
    const results = context.noteStore.search(query);
    if (results.length === 0) return { content: "No matching notes found.", isError: false };
    return {
      content: results.map(r => `[${r.sourcePath ?? "unknown"}] ${r.snippet}`).join("\n\n"),
      isError: false,
    };
  },
});
