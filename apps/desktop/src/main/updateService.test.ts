import { describe, expect, it, vi } from "vitest";
import { createUpdateService } from "./updateService";

describe("channel-specific desktop updates", () => {
  it("checks, downloads, and installs only for direct builds", () => {
    const updater = { checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() };
    const direct = createUpdateService("direct", updater);
    direct.start(); direct.onUpdateAvailable(); direct.install();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("never invokes Electron's updater for Homebrew builds", () => {
    const updater = { checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() };
    const homebrew = createUpdateService("homebrew", updater);
    homebrew.start(); homebrew.onUpdateAvailable(); homebrew.install();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
