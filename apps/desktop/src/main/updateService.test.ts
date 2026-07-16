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

  it("reports the outcome of a manual update check only for direct builds", () => {
    const updater = { checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() };
    const notify = { upToDate: vi.fn(), unableToCheck: vi.fn() };
    const direct = createUpdateService("direct", updater, notify);
    const homebrew = createUpdateService("homebrew", updater, notify);

    direct.checkManually();
    direct.onUpdateNotAvailable();
    direct.checkManually();
    direct.onError();
    homebrew.checkManually();
    homebrew.onUpdateNotAvailable();
    homebrew.onError();

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(notify.upToDate).toHaveBeenCalledOnce();
    expect(notify.unableToCheck).toHaveBeenCalledOnce();
  });

  it("does not overlap manual update checks", () => {
    const updater = { checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() };
    const direct = createUpdateService("direct", updater);

    direct.checkManually();
    direct.checkManually();

    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("defers a manual check until an automatic check completes", () => {
    const updater = { checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() };
    const notify = { upToDate: vi.fn(), unableToCheck: vi.fn() };
    const direct = createUpdateService("direct", updater, notify);

    direct.onCheckingForUpdate();
    direct.checkManually();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();

    direct.onUpdateNotAvailable();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();

    direct.onUpdateNotAvailable();
    expect(notify.upToDate).toHaveBeenCalledOnce();
  });

  it("does not start a second check when an automatic check finds an update", () => {
    const updater = { checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() };
    const direct = createUpdateService("direct", updater);

    direct.onCheckingForUpdate();
    direct.checkManually();
    direct.onUpdateAvailable();

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
  });
});
