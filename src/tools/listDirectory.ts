import { readdir } from "node:fs/promises";
import { registry } from "./registry.js";

const extractPath = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
};

registry.register({
  name: "list_directory",
  toolset: "file",
  verb: "Listing",
  previewArgKey: "path",
  schema: {
    name: "list_directory",
    description:
      'List the names of files and subdirectories inside a directory. Subdirectory names are suffixed with "/".',
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  handler: async (args) => {
    const path = extractPath(args);
    if (path === undefined) {
      return { content: 'Error: list_directory requires a string "path" argument', isError: true };
    }
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const names = entries.map(e => e.name + (e.isDirectory() ? "/" : "")).sort();
      return { content: names.length > 0 ? names.join("\n") : "(empty directory)", isError: false };
    } catch (error) {
      return { content: `Error listing ${path}: ${String(error)}`, isError: true };
    }
  }
});
