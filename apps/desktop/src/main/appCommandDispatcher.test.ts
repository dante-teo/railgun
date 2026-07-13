import { describe, expect, it, vi } from "vitest";
import { dispatchAppCommand } from "./appCommandDispatcher";
import type { AppCommandWindow } from "./appCommandDispatcher";
import { DESKTOP_IPC } from "../shared/types";

const commandWindow = (options: { destroyed?: boolean; minimized?: boolean } = {}) => ({
  isDestroyed: () => options.destroyed ?? false,
  isMinimized: () => options.minimized ?? false,
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  webContents: { send: vi.fn() },
}) satisfies AppCommandWindow;

describe("application command dispatch", () => {
  it("reactivates an existing Railgun window when none is focused", () => {
    const window = commandWindow({ minimized: true });
    const createWindow = vi.fn();

    dispatchAppCommand("new-chat", {
      getFocusedWindow: () => null,
      windows: [window],
      createWindow,
    });

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC.appCommand, "new-chat");
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("creates a window carrying the command when no live target exists", () => {
    const createWindow = vi.fn();

    dispatchAppCommand("new-chat", {
      getFocusedWindow: () => null,
      windows: [commandWindow({ destroyed: true })],
      createWindow,
    });

    expect(createWindow).toHaveBeenCalledWith("new-chat");
  });
});
