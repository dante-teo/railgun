import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const renderer = new URL(".", import.meta.url);
const sourceFiles = (await readdir(renderer, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile() && [".ts", ".tsx"].includes(extname(entry.name)) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx"))
  .map(entry => join(entry.parentPath, entry.name));
const sources = await Promise.all(sourceFiles.map(async path => ({ path, source: await readFile(path, "utf8") })));

describe("renderer design-system boundaries", () => {
  it("does not embed colors or manual browser dialogs in product code", () => {
    for (const { path, source } of sources) {
      expect(source, path).not.toMatch(/(?:#[\da-f]{3,8}|(?:rgb|hsl)a?\()/iu);
      expect(source, path).not.toMatch(/window\.(?:alert|confirm|prompt)\s*\(/u);
      expect(source, path).not.toMatch(/role=["']dialog["']/u);
    }
  });

  it("keeps inline styles limited to runtime structural values", () => {
    const allowed = new Set(["App.tsx", "Chat.tsx", "FileBrowser.tsx", "ShellLayout.tsx"]);
    for (const { path, source } of sources) {
      if (source.includes("style={{")) expect(allowed.has(path.split("/").at(-1) ?? ""), path).toBe(true);
    }
  });

  it("uses the shared palette and semantic search treatments", () => {
    for (const name of ["commands/CommandPalette.tsx", "tasks/TaskPalette.tsx", "chat/ChatControls.tsx"]) {
      const source = sources.find(file => file.path.endsWith(name))?.source ?? "";
      expect(source).toContain("PaletteList");
      expect(source).toContain("useListboxNavigation");
    }
    expect(sources.find(file => file.path.endsWith("knowledge/KnowledgePage.tsx"))?.source).toContain("SearchField");
    expect(sources.find(file => file.path.endsWith("settings/SettingsPage.tsx"))?.source).toContain("SearchField");
  });
});
