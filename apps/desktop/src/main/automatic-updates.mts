export interface AutomaticUpdater {
  allowPrerelease: boolean
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdatesAndNotify(): Promise<unknown>
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface AutomaticUpdateOptions {
  isPackaged: boolean
  reportError: (error: unknown) => void
  updater: AutomaticUpdater
  version: string
}

export function startAutomaticUpdates(options: AutomaticUpdateOptions): void {
  if (!options.isPackaged) {
    return
  }

  options.updater.autoDownload = true
  options.updater.autoInstallOnAppQuit = true
  options.updater.allowPrerelease = options.version.includes('-')
  options.updater.on('error', options.reportError)
  void options.updater.checkForUpdatesAndNotify().catch(options.reportError)
}
