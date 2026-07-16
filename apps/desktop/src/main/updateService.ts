export type UpdateChannel = "direct" | "homebrew";

export interface DesktopUpdater {
  checkForUpdates(): void;
  downloadUpdate?(): void;
  quitAndInstall(): void;
}

export interface UpdateCheckNotifier {
  checking(): void;
  finished(): void;
  upToDate(): void;
  unableToCheck(): void;
}

type UpdateCheckSource = "automatic" | "manual";

const unavailableNotifier: UpdateCheckNotifier = {
  checking: (): void => undefined,
  finished: (): void => undefined,
  upToDate: (): void => undefined,
  unableToCheck: (): void => undefined,
};

export const createUpdateService = (
  channel: UpdateChannel,
  updater: DesktopUpdater,
  notifier: UpdateCheckNotifier = unavailableNotifier,
) => {
  const enabled = channel === "direct";
  let activeCheck: UpdateCheckSource | undefined;
  let manualCheckQueued = false;
  const beginCheck = (source: UpdateCheckSource): void => {
    activeCheck = source;
    if (source === "manual") notifier.checking();
    updater.checkForUpdates();
  };
  const finishManualCheck = (source: UpdateCheckSource | undefined): boolean => {
    if (source !== "manual") return false;
    notifier.finished();
    return true;
  };
  const completeCheck = (notifyManualCheck: () => void): void => {
    const completedCheck = activeCheck;
    activeCheck = undefined;
    if (finishManualCheck(completedCheck)) notifyManualCheck();
    if (!manualCheckQueued) return;
    manualCheckQueued = false;
    beginCheck("manual");
  };

  return {
    channel,
    enabled,
    start: (): void => { if (enabled && activeCheck === undefined) beginCheck("automatic"); },
    expectAutomaticCheck: (): void => {
      if (enabled && activeCheck === undefined) activeCheck = "automatic";
    },
    onCheckingForUpdate: (): void => {
      if (enabled && activeCheck === undefined) activeCheck = "automatic";
    },
    checkManually: (): void => {
      if (!enabled) return;
      if (activeCheck !== undefined) {
        manualCheckQueued = true;
        return;
      }
      beginCheck("manual");
    },
    onUpdateAvailable: (): void => {
      if (!enabled) return;
      finishManualCheck(activeCheck);
      activeCheck = undefined;
      manualCheckQueued = false;
      updater.downloadUpdate?.();
    },
    onUpdateNotAvailable: (): void => completeCheck(notifier.upToDate),
    onError: (): void => completeCheck(notifier.unableToCheck),
    onUpdateDownloaded: (): void => { activeCheck = undefined; },
    install: (): void => { if (enabled) updater.quitAndInstall(); },
  };
};
