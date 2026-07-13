import { Menu } from "electron";
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";
import type { AppCommand } from "../shared/types";

export type SendAppCommand = (command: AppCommand) => void;

export const buildApplicationMenuTemplate = (
  development: boolean,
  sendCommand: SendAppCommand,
): MenuItemConstructorOptions[] => {
  const command = (value: AppCommand): (() => void) => () => sendCommand(value);
  const viewItems: MenuItemConstructorOptions[] = [
    { label: "Chat", accelerator: "CmdOrCtrl+1", click: command("show-chat") },
    { label: "Settings", accelerator: "CmdOrCtrl+,", click: command("show-settings") },
    { type: "separator" },
    { label: "Toggle Sidebar", accelerator: "Control+CmdOrCtrl+S", click: command("toggle-sidebar") },
  ];
  if (development) {
    viewItems.push(
      { type: "separator" },
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
    );
  }

  return [
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        { label: "New Chat", accelerator: "CmdOrCtrl+N", click: command("new-chat") },
        { type: "separator" },
        { label: "Command Palette…", accelerator: "CmdOrCtrl+K", click: command("command-palette") },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { label: "View", submenu: viewItems },
    { role: "windowMenu" },
  ];
};

type ContextMenuDetails = Pick<ContextMenuParams, "editFlags" | "isEditable" | "selectionText">;

export const buildContextMenuTemplate = (params: ContextMenuDetails): MenuItemConstructorOptions[] => {
  if (params.isEditable) {
    const flags = params.editFlags;
    return [
      { role: "undo", enabled: flags.canUndo },
      { role: "redo", enabled: flags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: flags.canCut },
      { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: flags.canSelectAll },
    ];
  }
  if (params.selectionText.length === 0) return [];
  return [
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "selectAll", enabled: params.editFlags.canSelectAll },
  ];
};

export const installContextMenu = (window: BrowserWindow): void => {
  window.webContents.on("context-menu", (_event, params) => {
    const template = buildContextMenuTemplate(params);
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window });
  });
};
