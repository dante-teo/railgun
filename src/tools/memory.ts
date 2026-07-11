import { registry } from "./registry.js";

const extractString = (args: unknown, key: string): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

registry.register({
  name: "memory_write",
  toolset: "memory",
  verb: "Remembering",
  previewArgKey: "content",
  schema: {
    name: "memory_write",
    description:
      "Save a fact or preference about the user for future sessions. " +
      "Use this when the user shares personal information, preferences, or facts they want remembered.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact or preference to remember." },
        category: {
          type: "string",
          enum: ["preference", "fact", "project"],
          description: "Category of the memory.",
        },
      },
      required: ["content", "category"],
    },
  },
  handler: async (args, context) => {
    if (!context.memoryStore) {
      return { content: "Error: memory is not available in this context", isError: true };
    }
    const content = extractString(args, "content");
    const category = extractString(args, "category");
    if (!content || !category) {
      return { content: 'Error: memory_write requires non-empty "content" and "category" arguments', isError: true };
    }
    context.memoryStore.save(content, category);
    return { content: "Saved.", isError: false };
  },
});

registry.register({
  name: "memory_search",
  toolset: "memory",
  verb: "Searching memories",
  previewArgKey: "query",
  schema: {
    name: "memory_search",
    description:
      "Search saved memories about the user by keyword. " +
      "Use this to recall facts or preferences the user shared in previous sessions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search for in saved memories." },
      },
      required: ["query"],
    },
  },
  handler: async (args, context) => {
    if (!context.memoryStore) {
      return { content: "Error: memory is not available in this context", isError: true };
    }
    const query = extractString(args, "query");
    if (!query) {
      return { content: 'Error: memory_search requires a non-empty "query" argument', isError: true };
    }
    const results = context.memoryStore.search(query);
    if (results.length === 0) return { content: "No matching memories found.", isError: false };
    const formatted = results.map(m => `- [${m.category}] ${m.content}`).join("\n");
    return { content: formatted, isError: false };
  },
});
