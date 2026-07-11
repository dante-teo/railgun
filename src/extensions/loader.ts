import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionRunner } from "./runner.js";
import type { ExtensionAPI, ExtensionFactory } from "./types.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface LoadExtensionsOptions {
  readonly cwd: string;
  readonly homeDir: string;
  readonly trusted: boolean;
}

const createExtensionAPI = (runner: ExtensionRunner, source: string): ExtensionAPI => ({
  on: (event, handler) => runner.on(event, handler, source),
  registerTool: (tool) => runner.registerTool(tool),
  registerCommand: () => { /* stub — future surface */ },
  registerShortcut: () => { /* stub — future surface */ },
  registerFlag: () => { /* stub — future surface */ },
  registerProvider: () => { /* stub — future surface */ },
});

const loadModule = async (runner: ExtensionRunner, modPath: string): Promise<void> => {
  // Dynamic import is required here: extension module paths are determined at runtime.
  const mod = await import(pathToFileURL(modPath).href) as Record<string, unknown>;
  const factory: unknown = mod.default ?? mod;
  if (typeof factory !== "function") {
    runner.reportExtensionError({
      extension: modPath,
      event: "load",
      error: new Error("Extension does not export a default function"),
    });
    return;
  }
  const api = createExtensionAPI(runner, modPath);
  await (factory as ExtensionFactory)(api);
};

export const loadExtensions = async (
  runner: ExtensionRunner,
  options: LoadExtensionsOptions
): Promise<void> => {
  const { cwd, homeDir, trusted } = options;
  const dirs: string[] = [];
  // Project-local directory first, only when trusted
  if (trusted) dirs.push(join(cwd, ".railgun", "extensions"));
  // Global directory always
  dirs.push(join(homeDir, ".railgun", "extensions"));

  for (const dir of dirs) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // directory doesn't exist — skip
    }

    for (const entry of entries) {
      // Direct .ts / .js file
      if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
        const modPath = join(dir, entry.name);
        try { await loadModule(runner, modPath); }
        catch (error) { runner.reportExtensionError({ extension: modPath, event: "load", error }); }
        continue;
      }

      // Subdirectory — probe for index.ts / index.js (prefer .ts)
      if (!entry.isDirectory()) continue;
      const subDir = join(dir, entry.name);
      let subEntries: Dirent[];
      try { subEntries = await readdir(subDir, { withFileTypes: true }); }
      catch { continue; }
      for (const idx of ["index.ts", "index.js"]) {
        if (!subEntries.some(e => e.isFile() && e.name === idx)) continue;
        const modPath = join(subDir, idx);
        try { await loadModule(runner, modPath); }
        catch (error) { runner.reportExtensionError({ extension: modPath, event: "load", error }); }
        break; // prefer index.ts over index.js; stop after first match
      }
    }
  }
};

export const registerExtensionTools = (
  runner: ExtensionRunner,
  registry: ToolRegistry,
  sessionId: string
): void => {
  for (const extTool of runner.getTools()) {
    registry.register({
      name: extTool.name,
      toolset: "extension",
      schema: {
        name: extTool.name,
        description: extTool.description,
        inputSchema: extTool.inputSchema as Record<string, unknown>,
      },
      handler: async (args) => {
        const result = await extTool.execute(args as Record<string, unknown>, { sessionId });
        return { content: result.content, isError: result.isError ?? false };
      },
    });
  }
};
