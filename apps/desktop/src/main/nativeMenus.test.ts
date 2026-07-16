import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { buildApplicationMenuTemplate, buildContextMenuTemplate, buildSessionContextMenu } from "./nativeMenus";

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
      expect.objectContaining({ label: "New Task", accelerator: "CmdOrCtrl+N" }),
      expect.objectContaining({ label: "Command Palette…", accelerator: "CmdOrCtrl+K" }),
      expect.objectContaining({ label: "Task", accelerator: "CmdOrCtrl+1" }),
      expect.objectContaining({ label: "Settings", accelerator: "CmdOrCtrl+," }),
      expect.objectContaining({ label: "Toggle Sidebar", accelerator: "Control+CmdOrCtrl+S" }),
    ]));
    const newChat = items.find((item) => item.label === "New Task");
    (newChat?.click as (() => void) | undefined)?.();
    expect(send).toHaveBeenCalledWith("new-chat");
  });

  it("delegates standard application, edit, and window menus to native roles", () => {
    const roles = buildApplicationMenuTemplate(false, vi.fn()).map((item) => item.role);
    expect(roles).toEqual(expect.arrayContaining(["appMenu", "editMenu", "windowMenu"]));
  });

  it("includes a manual update check in the macOS application menu when updates are available", () => {
    const checkForUpdates = vi.fn();
    const items = flatten(buildApplicationMenuTemplate(false, vi.fn(), checkForUpdates));
    const checkItem = items.find((item) => item.label === "Check for Updates…");

    checkItem?.click?.({} as never, {} as never, {} as never);

    expect(checkItem).toEqual(expect.objectContaining({ enabled: true }));
    expect(checkForUpdates).toHaveBeenCalledOnce();
    expect(flatten(buildApplicationMenuTemplate(false, vi.fn())).map((item) => item.label))
      .not.toContain("Check for Updates…");
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

describe("session context menu", () => {
  it("resolves fork when the fork item is clicked", async () => {
    const window = {} as BrowserWindow;
    const popup = vi.fn();
    const menu = { popup };
    let template: MenuItemConstructorOptions[] = [];
    const buildFromTemplate = vi.fn((items: MenuItemConstructorOptions[]) => { template = items; return menu; });
    const promise = buildSessionContextMenu("sess-1", window, buildFromTemplate as never);
    const forkItem = template.find((i) => i.label === "Fork task");
    forkItem?.click?.({} as never, window, {} as never);
    expect(await promise).toBe("fork");
    expect(popup).toHaveBeenCalledWith(expect.objectContaining({ window }));
  });

  it("resolves null when the menu closes without selection", async () => {
    const window = {} as BrowserWindow;
    let closeCallback: (() => void) | undefined;
    const popup = vi.fn(({ callback }: { callback?: () => void }) => { closeCallback = callback; });
    const menu = { popup };
    const buildFromTemplate = vi.fn(() => menu);
    const promise = buildSessionContextMenu("sess-1", window, buildFromTemplate as never);
    closeCallback?.();
    expect(await promise).toBeNull();
  });
});
