export type UpdateChannel = "direct" | "homebrew";

export interface DesktopUpdater {
  checkForUpdates(): void;
  downloadUpdate?(): void;
  quitAndInstall(): void;
}

export const createUpdateService = (channel: UpdateChannel, updater: DesktopUpdater) => {
  const enabled = channel === "direct";
  return {
    channel,
    enabled,
    start: (): void => { if (enabled) updater.checkForUpdates(); },
    onUpdateAvailable: (): void => { if (enabled) updater.downloadUpdate?.(); },
    install: (): void => { if (enabled) updater.quitAndInstall(); },
  };
};
