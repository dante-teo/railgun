import { describe, expect, it, vi } from "vitest";
import { createUpdateCheckDialog } from "./updateCheckDialog";

describe("update check dialog", () => {
  it("shows a modal spinner while checking and closes when finished", async () => {
    const show = vi.fn();
    const focus = vi.fn();
    const close = vi.fn();
    const loadURL = vi.fn(async () => undefined);
    const listeners = new Map<string, () => void>();
    const window = {
      isDestroyed: () => false,
      show,
      focus,
      close,
      once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      loadURL,
    };
    const createWindow = vi.fn(() => window);
    const checking = createUpdateCheckDialog(createWindow, "railgun://app/");

    checking.show();
    expect(createWindow).toHaveBeenCalledWith(expect.objectContaining({ modal: true, show: false, title: "Checking for Updates" }));
    expect(loadURL).toHaveBeenCalledWith("railgun://app/?surface=update-check");
    expect(show).not.toHaveBeenCalled();
    listeners.get("ready-to-show")?.();
    expect(show).toHaveBeenCalledOnce();

    checking.show();
    expect(focus).toHaveBeenCalledOnce();
    checking.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes an invisible dialog when its renderer cannot load", async () => {
    const close = vi.fn();
    const window = {
      isDestroyed: () => false,
      show: vi.fn(),
      focus: vi.fn(),
      close,
      once: vi.fn(),
      loadURL: vi.fn(async () => { throw new Error("renderer unavailable"); }),
    };
    const createWindow = vi.fn(() => window);
    const checking = createUpdateCheckDialog(createWindow, "railgun://app/");

    checking.show();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    checking.show();
    expect(createWindow).toHaveBeenCalledTimes(2);
  });
});
