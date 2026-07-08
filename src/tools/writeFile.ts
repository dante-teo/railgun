import { writeFile } from "node:fs/promises";
import { registry } from "./registry.js";

const extractPath = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
};

const extractContent = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const content = (args as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
};

registry.register({
  name: "write_file",
  toolset: "file",
  verb: "Writing",
  previewArgKey: "path",
  schema: {
    name: "write_file",
    description: "Write text content to a file on disk, overwriting existing content.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    }
  },
  handler: async (args) => {
    const path = extractPath(args);
    const content = extractContent(args);
    if (path === undefined) return { content: 'Error: write_file requires a string "path" argument', isError: true };
    if (content === undefined) {
      return { content: 'Error: write_file requires a string "content" argument', isError: true };
    }
    try {
      await writeFile(path, content, "utf-8");
      return { content: `Wrote ${content.length} bytes to ${path}`, isError: false };
    } catch (error) {
      return { content: `Error writing ${path}: ${String(error)}`, isError: true };
    }
  }
});
