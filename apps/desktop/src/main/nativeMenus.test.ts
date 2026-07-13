import { describe, expect, it, vi } from "vitest";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { buildApplicationMenuTemplate, buildContextMenuTemplate } from "./nativeMenus";

const flatten = (template: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);

const editFlags = (enabled = true): ContextMenuParams["editFlags"] => ({
  canUndo: enabled,
  canRedo: enabled,
  canCut: enabled,
  canCopy: enabled,
  canPaste: enabled,
  canDelete: enabled,
  canSelectAll: enabled,
  canEditRichly: false,
});

describe("native application menu", () => {
  it("uses macOS accelerators and dispatches only closed app commands", () => {
    const send = vi.fn();
    const items = flatten(buildApplicationMenuTemplate(false, send));
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "New Chat", accelerator: "CmdOrCtrl+N" }),
      expect.objectContaining({ label: "Command Palette…", accelerator: "CmdOrCtrl+K" }),
      expect.objectContaining({ label: "Chat", accelerator: "CmdOrCtrl+1" }),
      expect.objectContaining({ label: "Settings", accelerator: "CmdOrCtrl+," }),
      expect.objectContaining({ label: "Toggle Sidebar", accelerator: "Control+CmdOrCtrl+S" }),
    ]));
    const newChat = items.find((item) => item.label === "New Chat");
    (newChat?.click as (() => void) | undefined)?.();
    expect(send).toHaveBeenCalledWith("new-chat");
  });

  it("delegates standard application, edit, and window menus to native roles", () => {
    const roles = buildApplicationMenuTemplate(false, vi.fn()).map((item) => item.role);
    expect(roles).toEqual(expect.arrayContaining(["appMenu", "editMenu", "windowMenu"]));
  });

  it("includes reload and developer tools roles only in development", () => {
    const roles = (development: boolean): unknown[] => flatten(buildApplicationMenuTemplate(development, vi.fn()))
      .map((item) => item.role);
    expect(roles(false)).not.toContain("reload");
    expect(roles(false)).not.toContain("toggleDevTools");
    expect(roles(true)).toEqual(expect.arrayContaining(["reload", "forceReload", "toggleDevTools"]));
  });
});

describe("native context menu", () => {
  it("offers only standard editable actions with applicability flags", () => {
    const flags = { ...editFlags(false), canCopy: true, canSelectAll: true };
    const items = buildContextMenuTemplate({ isEditable: true, selectionText: "selected", editFlags: flags });
    expect(items.map((item) => item.role ?? item.type)).toEqual([
      "undo", "redo", "separator", "cut", "copy", "paste", "separator", "selectAll",
    ]);
    expect(items.find((item) => item.role === "copy")?.enabled).toBe(true);
    expect(items.find((item) => item.role === "paste")?.enabled).toBe(false);
  });

  it("offers copy/select all for selected text and nothing for other content", () => {
    expect(buildContextMenuTemplate({ isEditable: false, selectionText: "selected", editFlags: editFlags() })
      .map((item) => item.role)).toEqual(["copy", "selectAll"]);
    expect(buildContextMenuTemplate({ isEditable: false, selectionText: "", editFlags: editFlags() })).toEqual([]);
  });
});
