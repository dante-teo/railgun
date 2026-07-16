import type { BrowserWindowConstructorOptions, WebContents } from "electron";

interface UpdateCheckDialogWindow {
  isDestroyed(): boolean;
  show(): void;
  focus(): void;
  close(): void;
  once(event: "closed", listener: () => void): void;
  readonly webContents: Pick<WebContents, "executeJavaScript">;
}

type UpdateCheckDialogWindowFactory = (options: BrowserWindowConstructorOptions) => UpdateCheckDialogWindow;

const dialogMarkup = `
  document.documentElement.style.cssText = "height:100%;background:#f7f9f8";
  document.body.style.cssText = "display:grid;height:100%;place-items:center;margin:0;color:#18201d;background:#f7f9f8;font:500 15px -apple-system,BlinkMacSystemFont,sans-serif";
  document.body.innerHTML = '<main role="status" aria-live="polite" style="display:grid;justify-items:center;gap:14px"><i class="update-check-spinner" aria-hidden="true"></i><span>Checking for updates…</span></main>';
  const style = document.createElement("style");
  style.textContent = ".update-check-spinner{width:24px;height:24px;border:3px solid #c5d1ca;border-top-color:#23734f;border-radius:50%;animation:update-check-spin .8s linear infinite}@keyframes update-check-spin{to{transform:rotate(360deg)}}";
  document.head.append(style);
`;

export const createUpdateCheckDialog = (createWindow: UpdateCheckDialogWindowFactory) => {
  let current: UpdateCheckDialogWindow | undefined;
  const liveWindow = (): UpdateCheckDialogWindow | undefined => current?.isDestroyed() ? undefined : current;
  const showWindow = (window: UpdateCheckDialogWindow): void => {
    if (current === window && !window.isDestroyed()) window.show();
  };

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
        backgroundColor: "#f7f9f8",
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
      void window.webContents.executeJavaScript(dialogMarkup).then(() => showWindow(window), () => showWindow(window));
    },
    close: (): void => {
      const window = liveWindow();
      if (window !== undefined) window.close();
    },
  };
};
