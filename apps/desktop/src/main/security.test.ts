import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent, Session, WebContents } from "electron";
import {
  denyContentEvent,
  denyPermissionCheck,
  denyPermissionRequest,
  isAuthorizedIpcSender,
  isAllowedWebContentsCreation,
  installWebContentsGuards,
  installSessionGuards,
  rendererCsp,
} from "./security";

const senderFixture = (options: {
  origin?: string;
  mainFrame?: boolean;
  destroyedSender?: boolean;
  destroyedWindow?: boolean;
  knownWindow?: boolean;
  missingWindow?: boolean;
} = {}) => {
  const mainFrame = { url: options.origin ?? "railgun://app/" };
  const sender = {
    isDestroyed: () => options.destroyedSender ?? false,
    mainFrame,
  } as unknown as WebContents;
  const senderFrame = options.mainFrame === false ? { url: mainFrame.url } : mainFrame;
  const window = { isDestroyed: () => options.destroyedWindow ?? false } as BrowserWindow;
  const windows = new Set<BrowserWindow>(options.knownWindow === false ? [] : [window]);
  const event = { sender, senderFrame } as unknown as IpcMainInvokeEvent;
  return {
    event,
    context: {
      windows,
      expectedOrigin: "railgun://app",
      fromWebContents: () => options.missingWindow === true ? null : window,
    },
  };
};

describe("renderer security policy", () => {
  it("builds environment-specific CSP without broad network access", () => {
    const production = rendererCsp(undefined);
    expect(production).toContain("default-src 'none'");
    expect(production).toContain("connect-src 'self' railgun:");
    expect(production).toContain("object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'");
    expect(production).not.toContain("http:");

    const development = rendererCsp("http://localhost:5173/path");
    expect(development).toContain("http://localhost:5173");
    expect(development).toContain("ws://localhost:5173");
    expect(development).toContain("'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='");
    expect(development).not.toContain("ws://localhost:*");
    expect(development).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
  });

  it("authorizes only the known trusted main frame", () => {
    const trusted = senderFixture();
    expect(isAuthorizedIpcSender(trusted.event, trusted.context)).toBe(true);
    for (const fixture of [
      senderFixture({ mainFrame: false }),
      senderFixture({ origin: "https://attacker.invalid" }),
      senderFixture({ destroyedSender: true }),
      senderFixture({ destroyedWindow: true }),
      senderFixture({ knownWindow: false }),
      senderFixture({ missingWindow: true }),
    ]) {
      expect(isAuthorizedIpcSender(fixture.event, fixture.context)).toBe(false);
    }
  });

  it("denies navigation, attachment, downloads, and permissions", () => {
    const preventDefault = vi.fn();
    denyContentEvent({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(denyPermissionCheck()).toBe(false);
    const permissionCallback = vi.fn();
    denyPermissionRequest({} as WebContents, "media", permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);

    const handlers = new Map<string, (...args: never[]) => void>();
    const setWindowOpenHandler = vi.fn();
    const contents = {
      setWindowOpenHandler,
      on: vi.fn((name: string, handler: (...args: never[]) => void) => { handlers.set(name, handler); }),
    } as unknown as WebContents;
    installWebContentsGuards(contents);
    expect(setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: "deny" });
    expect([...handlers.keys()].sort()).toEqual(["will-attach-webview", "will-navigate", "will-redirect"]);
    for (const handler of handlers.values()) handler({ preventDefault } as never);
    expect(preventDefault).toHaveBeenCalledTimes(4);
  });

  it("allows only expected windows and development DevTools renderers", () => {
    expect(isAllowedWebContentsCreation("window", true, false)).toBe(true);
    expect(isAllowedWebContentsCreation("window", false, true)).toBe(false);
    expect(isAllowedWebContentsCreation("webview", false, true)).toBe(false);
    expect(isAllowedWebContentsCreation("backgroundPage", false, true)).toBe(false);
    expect(isAllowedWebContentsCreation("remote", false, true)).toBe(true);
    expect(isAllowedWebContentsCreation("remote", false, false)).toBe(false);
  });

  it("installs download, permission, and CSP session guards", () => {
    const on = vi.fn();
    const setPermissionRequestHandler = vi.fn();
    const setPermissionCheckHandler = vi.fn();
    const onHeadersReceived = vi.fn();
    const session = {
      on,
      setPermissionRequestHandler,
      setPermissionCheckHandler,
      webRequest: { onHeadersReceived },
    } as unknown as Session;
    installSessionGuards(session, "default-src 'none'");
    expect(on).toHaveBeenCalledWith("will-download", expect.any(Function));
    expect(setPermissionRequestHandler).toHaveBeenCalledWith(expect.any(Function));
    expect(setPermissionCheckHandler).toHaveBeenCalledWith(expect.any(Function));

    const headersCallback = vi.fn();
    const headersHandler = onHeadersReceived.mock.calls[0]?.[0] as (
      details: { responseHeaders: Record<string, string[]> },
      callback: (response: unknown) => void,
    ) => void;
    headersHandler({ responseHeaders: { Existing: ["value"] } }, headersCallback);
    expect(headersCallback).toHaveBeenCalledWith({ responseHeaders: {
      Existing: ["value"],
      "Content-Security-Policy": ["default-src 'none'"],
      "X-Content-Type-Options": ["nosniff"],
    } });
  });
});
