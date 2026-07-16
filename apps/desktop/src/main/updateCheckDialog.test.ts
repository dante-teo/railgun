import { describe, expect, it, vi } from "vitest";
import { createUpdateCheckDialog } from "./updateCheckDialog";

describe("update check dialog", () => {
  it("shows a modal spinner while checking and closes when finished", async () => {
    const show = vi.fn();
    const focus = vi.fn();
    const close = vi.fn();
    const executeJavaScript = vi.fn(async () => undefined);
    const window = {
      isDestroyed: () => false,
      show,
      focus,
      close,
      once: vi.fn(),
      webContents: { executeJavaScript },
    };
    const createWindow = vi.fn(() => window);
    const checking = createUpdateCheckDialog(createWindow);

    checking.show();
    await Promise.resolve();

    expect(createWindow).toHaveBeenCalledWith(expect.objectContaining({ modal: true, show: false, title: "Checking for Updates" }));
    expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("update-check-spinner"));
    expect(show).toHaveBeenCalledOnce();

    checking.show();
    expect(focus).toHaveBeenCalledOnce();
    checking.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
