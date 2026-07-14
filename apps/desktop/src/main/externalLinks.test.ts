import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import { openExternalFromRenderer } from "./externalLinks";

const fixture = (url = "railgun://app/") => {
  const frame = { url };
  const sender = { isDestroyed: () => false, mainFrame: frame } as unknown as WebContents;
  const window = { isDestroyed: () => false } as BrowserWindow;
  return {
    event: { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent,
    context: {
      windows: new Set([window]),
      expectedOrigin: "railgun://app",
      fromWebContents: () => window,
    },
  };
};

describe("external browser boundary", () => {
  it("opens only validated HTTP(S) URLs from an authorized renderer", async () => {
    const { event, context } = fixture();
    const open = vi.fn(async () => undefined);
    await openExternalFromRenderer(event, "https://example.com/path", context, open);
    expect(open).toHaveBeenCalledWith("https://example.com/path");

    for (const value of ["javascript:alert(1)", "file:///tmp/secret", "/relative", "not a url"]) {
      await expect(openExternalFromRenderer(event, value, context, open)).rejects.toThrow();
    }
    expect(open).toHaveBeenCalledOnce();
  });

  it("checks sender authorization before opening", async () => {
    const { event, context } = fixture("https://attacker.invalid/");
    const open = vi.fn(async () => undefined);
    await expect(openExternalFromRenderer(event, "https://example.com", context, open)).rejects.toThrow("Unauthorized");
    expect(open).not.toHaveBeenCalled();
  });
});
