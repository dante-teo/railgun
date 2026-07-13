import type { BrowserWindow, IpcMainInvokeEvent, Session, WebContents } from "electron";

export const productionRendererOrigin = "railgun://app";

// Injected by @vitejs/plugin-react in development. Hashing the fixed preamble
// keeps arbitrary inline scripts blocked instead of enabling `unsafe-inline`.
const VITE_REACT_REFRESH_PREAMBLE = "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='";

export const rendererOrigin = (developmentUrl: string | undefined): string =>
  developmentUrl === undefined ? productionRendererOrigin : new URL(developmentUrl).origin;

const comparableOrigin = (value: string): string => {
  const url = new URL(value);
  return url.protocol === "railgun:" ? `${url.protocol}//${url.host}` : url.origin;
};

export const rendererCsp = (developmentUrl: string | undefined): string => {
  const sourceOrigin = rendererOrigin(developmentUrl);
  const websocketOrigin = developmentUrl === undefined
    ? "railgun:"
    : sourceOrigin.replace(/^http:/u, "ws:").replace(/^https:/u, "wss:");
  const scriptSources = developmentUrl === undefined
    ? "'self'"
    : `'self' ${sourceOrigin} 'unsafe-eval' ${VITE_REACT_REFRESH_PREAMBLE}`;
  const styleSources = developmentUrl === undefined ? "'self'" : `'self' ${sourceOrigin} 'unsafe-inline'`;
  const connectSources = developmentUrl === undefined
    ? "'self' railgun:"
    : `'self' ${sourceOrigin} ${websocketOrigin}`;
  return [
    "default-src 'none'",
    `script-src ${scriptSources}`,
    `style-src ${styleSources}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connectSources}`,
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
};

export interface SenderAuthorizationContext {
  readonly windows: ReadonlySet<BrowserWindow>;
  readonly expectedOrigin: string;
  readonly fromWebContents: (contents: WebContents) => BrowserWindow | null;
}

export const isAuthorizedIpcSender = (
  event: IpcMainInvokeEvent,
  context: SenderAuthorizationContext,
): boolean => {
  if (event.sender.isDestroyed() || event.senderFrame === null) return false;
  const window = context.fromWebContents(event.sender);
  if (window === null || window.isDestroyed() || !context.windows.has(window)) return false;
  if (event.senderFrame !== event.sender.mainFrame) return false;
  try {
    return comparableOrigin(event.senderFrame.url) === context.expectedOrigin;
  } catch {
    return false;
  }
};

export const assertAuthorizedIpcSender = (
  event: IpcMainInvokeEvent,
  context: SenderAuthorizationContext,
): void => {
  if (!isAuthorizedIpcSender(event, context)) throw new Error("Unauthorized renderer IPC sender");
};

export const denyContentEvent = (event: { preventDefault(): void }): void => event.preventDefault();
export const denyPermissionRequest = (
  _contents: WebContents,
  _permission: string,
  callback: (allowed: boolean) => void,
): void => callback(false);
export const denyPermissionCheck = (): boolean => false;

export const isAllowedWebContentsCreation = (
  type: ReturnType<WebContents["getType"]>,
  expectingWindow: boolean,
  development: boolean,
): boolean => type === "window" ? expectingWindow : type === "remote" && development;

export const installSessionGuards = (session: Session, csp: string): void => {
  session.on("will-download", denyContentEvent);
  session.setPermissionRequestHandler(denyPermissionRequest);
  session.setPermissionCheckHandler(denyPermissionCheck);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
        "X-Content-Type-Options": ["nosniff"],
      },
    });
  });
};

export const installWebContentsGuards = (contents: WebContents): void => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", denyContentEvent);
  contents.on("will-redirect", denyContentEvent);
  contents.on("will-attach-webview", denyContentEvent);
};
