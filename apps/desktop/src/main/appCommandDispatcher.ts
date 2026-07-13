import { DESKTOP_IPC } from "../shared/types";
import type { AppCommand } from "../shared/types";

export interface AppCommandWindow {
  readonly webContents: { send: (channel: string, command: AppCommand) => void };
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
}

export interface AppCommandDispatcherDependencies {
  readonly getFocusedWindow: () => AppCommandWindow | null;
  readonly windows: Iterable<AppCommandWindow>;
  readonly createWindow: (initialCommand: AppCommand) => void;
}

export const dispatchAppCommand = (
  command: AppCommand,
  dependencies: AppCommandDispatcherDependencies,
): void => {
  const liveWindows = [...dependencies.windows].filter((window) => !window.isDestroyed());
  const focusedWindow = dependencies.getFocusedWindow();
  const target = focusedWindow !== null && liveWindows.includes(focusedWindow)
    ? focusedWindow
    : liveWindows[0];

  if (target === undefined) {
    dependencies.createWindow(command);
    return;
  }

  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  target.webContents.send(DESKTOP_IPC.appCommand, command);
};
