import { readFile } from "node:fs/promises";
import { registry } from "./registry.js";

const extractPath = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
};

registry.register({
  name: "read_file",
  toolset: "file",
  schema: {
    name: "read_file",
    description: "Read the text content of a file on disk.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  handler: async (args) => {
    const path = extractPath(args);
    if (path === undefined) {
      return { content: 'Error: read_file requires a string "path" argument', isError: true };
    }
    try {
      return { content: await readFile(path, "utf-8"), isError: false };
    } catch (error) {
      return { content: `Error reading ${path}: ${String(error)}`, isError: true };
    }
  }
});
