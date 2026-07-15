import { registry } from "./registry.js";
import { extractString } from "./args.js";

registry.register({
  name: "note_write",
  toolset: "memory",
  verb: "Writing note",
  previewArgKey: "title",
  schema: {
    name: "note_write",
    description:
      "Save a note to the user's note library. " +
      "Use this to record information the user asks you to remember, " +
      "capture meeting notes, document decisions, or store any content " +
      "the user wants to be able to search later.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The text content of the note to save." },
        title: { type: "string", description: "Optional label or title for the note (used as its source name)." },
      },
      required: ["content"],
    },
  },
  handler: async (args, context) => {
    if (!context.noteStore) {
      return { content: "Error: note writing is not available in this context.", isError: true };
    }
    const content = extractString(args, "content");
    if (!content || !content.trim()) {
      return { content: 'Error: note_write requires a non-empty "content" argument.', isError: true };
    }
    const title = extractString(args, "title") ?? undefined;
    const result = context.noteStore.write(content.trim(), title);
    return {
      content: `Note saved (id: ${result.id}${title ? `, title: "${title}"` : ""}).`,
      isError: false,
    };
  },
});
