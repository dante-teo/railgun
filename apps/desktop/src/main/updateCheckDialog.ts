import type { BrowserWindowConstructorOptions } from "electron";

interface UpdateCheckDialogWindow {
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  close(): void;
  loadURL(url: string): Promise<void>;
  once(event: "closed" | "ready-to-show", listener: () => void): void;
}

type UpdateCheckDialogWindowFactory = (options: BrowserWindowConstructorOptions) => UpdateCheckDialogWindow;

const updateSurfaceUrl = (rendererUrl: string): string => {
  const url = new URL(rendererUrl);
  url.searchParams.set("surface", "update-check");
  return url.toString();
};

export const createUpdateCheckDialog = (createWindow: UpdateCheckDialogWindowFactory, rendererUrl: string) => {
  let current: UpdateCheckDialogWindow | undefined;
  const liveWindow = (): UpdateCheckDialogWindow | undefined => current?.isDestroyed() ? undefined : current;

  return {
    show: (): void => {
      const existing = liveWindow();
      if (existing !== undefined) {
        existing.focus();
        return;
      }
      const window = createWindow({
        width: 320,
        height: 160,
        title: "Checking for Updates",
        modal: true,
        show: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        closable: false,
        skipTaskbar: true,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          webviewTag: false,
          devTools: false,
        },
      });
      current = window;
      window.once("closed", () => { if (current === window) current = undefined; });
      window.once("ready-to-show", () => { if (current === window && !window.isDestroyed()) window.show(); });
      void window.loadURL(updateSurfaceUrl(rendererUrl)).catch(() => {
        if (current !== window) return;
        current = undefined;
        if (!window.isDestroyed()) window.close();
      });
    },
    close: (): void => {
      const window = liveWindow();
      if (window !== undefined) window.close();
    },
  };
};
