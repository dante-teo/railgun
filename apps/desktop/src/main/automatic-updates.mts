export const updateCheckIntervalMilliseconds = 4 * 60 * 60 * 1_000

export interface UpdateInfo {
  readonly version: string
}

export interface UpdateCheckResult {
  readonly isUpdateAvailable: boolean
  readonly updateInfo: UpdateInfo
  readonly versionInfo: UpdateInfo
  readonly downloadPromise?: Promise<readonly string[]> | null
}

type UpdaterEvent =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'update-downloaded'
  | 'update-staged'
  | 'error'

type UpdaterListener = (value?: UpdateInfo | Error) => void

export interface AutomaticUpdater {
  allowPrerelease: boolean
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<UpdateCheckResult | null>
  on(event: UpdaterEvent, listener: UpdaterListener): unknown
  removeListener(event: UpdaterEvent, listener: UpdaterListener): unknown
  quitAndInstall(): void
}

export type UpdateState =
  | { readonly status: 'disabled' }
  | { readonly status: 'idle' }
  | { readonly status: 'checking' }
  | { readonly status: 'downloading'; readonly version: string }
  | { readonly status: 'ready'; readonly version: string }

export type ManualUpdateCheckOutcome =
  | { readonly status: 'unavailable' }
  | { readonly status: 'up-to-date'; readonly version: string }
  | { readonly status: 'downloading'; readonly version: string }
  | { readonly status: 'failed'; readonly error: unknown }

export interface UpdateController {
  readonly start: () => void
  readonly checkManually: () => Promise<ManualUpdateCheckOutcome>
  readonly restartToInstall: () => Promise<void>
  readonly subscribe: (listener: (state: UpdateState) => void) => () => void
  readonly dispose: () => void
}

interface UpdateScheduler {
  readonly setTimeout: (callback: () => void, delay: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

export interface AutomaticUpdateControllerOptions {
  readonly isPackaged: boolean
  readonly reportError: (error: unknown) => void
  readonly restartToInstall: () => Promise<void>
  readonly scheduler?: UpdateScheduler
  readonly updater: AutomaticUpdater
  readonly version: string
}

const defaultScheduler: UpdateScheduler = {
  setTimeout: (callback, delay) => {
    const timer = setTimeout(callback, delay)
    timer.unref()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

function sameState(left: UpdateState, right: UpdateState): boolean {
  return (
    left.status === right.status &&
    ('version' in left ? left.version : undefined) ===
      ('version' in right ? right.version : undefined)
  )
}

export function createAutomaticUpdateController(
  options: AutomaticUpdateControllerOptions
): UpdateController {
  const scheduler = options.scheduler ?? defaultScheduler
  const listeners = new Set<(state: UpdateState) => void>()
  const eventListeners = new Map<UpdaterEvent, UpdaterListener>()
  const reportedErrors = new Set<unknown>()
  let activeCheck: Promise<ManualUpdateCheckOutcome> | undefined
  let downloadedVersion: string | undefined
  let disposed = false
  let pollTimer: unknown
  let restartPromise: Promise<void> | undefined
  let started = false
  let state: UpdateState = options.isPackaged ? { status: 'idle' } : { status: 'disabled' }

  const publish = (nextState: UpdateState): void => {
    if (sameState(state, nextState)) {
      return
    }
    state = nextState
    listeners.forEach((listener) => listener(state))
  }

  const reportOnce = (error: unknown): void => {
    if (reportedErrors.has(error)) {
      return
    }
    reportedErrors.add(error)
    options.reportError(error)
  }

  const clearPoll = (): void => {
    if (pollTimer !== undefined) {
      scheduler.clearTimeout(pollTimer)
      pollTimer = undefined
    }
  }

  const schedulePoll = (): void => {
    clearPoll()
    if (
      disposed ||
      state.status === 'disabled' ||
      state.status === 'downloading' ||
      state.status === 'ready'
    ) {
      return
    }
    pollTimer = scheduler.setTimeout(() => {
      pollTimer = undefined
      void checkAutomatically()
    }, updateCheckIntervalMilliseconds)
  }

  const settleDownloadFailure = (error: unknown): void => {
    if (state.status === 'downloading' || state.status === 'ready') {
      downloadedVersion = undefined
      publish({ status: 'idle' })
      schedulePoll()
    }
    reportOnce(error)
  }

  const performCheck = async (): Promise<ManualUpdateCheckOutcome> => {
    publish({ status: 'checking' })
    try {
      const result = await options.updater.checkForUpdates()
      if (!result) {
        publish({ status: 'idle' })
        return { status: 'unavailable' }
      }
      if (!result.isUpdateAvailable) {
        publish({ status: 'idle' })
        return { status: 'up-to-date', version: result.updateInfo.version }
      }

      const version = result.updateInfo.version
      if (state.status !== 'ready') {
        publish({ status: 'downloading', version })
      }
      void result.downloadPromise?.catch(settleDownloadFailure)
      return { status: 'downloading', version }
    } catch (error) {
      if (state.status !== 'ready') {
        publish({ status: 'idle' })
      }
      return { status: 'failed', error }
    }
  }

  const check = (): Promise<ManualUpdateCheckOutcome> => {
    clearPoll()
    if (disposed || state.status === 'disabled') {
      return Promise.resolve({ status: 'unavailable' })
    }
    if (state.status === 'downloading' || state.status === 'ready') {
      return Promise.resolve({ status: 'unavailable' })
    }
    if (!activeCheck) {
      const pending = performCheck().finally(() => {
        if (activeCheck === pending) {
          activeCheck = undefined
        }
      })
      activeCheck = pending
    }
    return activeCheck.finally(schedulePoll)
  }

  async function checkAutomatically(): Promise<void> {
    const outcome = await check()
    if (outcome.status === 'failed') {
      reportOnce(outcome.error)
    }
  }

  const addEventListener = (event: UpdaterEvent, listener: UpdaterListener): void => {
    eventListeners.set(event, listener)
    options.updater.on(event, listener)
  }

  const configureUpdater = (): void => {
    options.updater.autoDownload = true
    options.updater.autoInstallOnAppQuit = true
    options.updater.allowPrerelease = options.version.includes('-')

    addEventListener('update-available', (value) => {
      if (value && !(value instanceof Error) && state.status !== 'ready') {
        publish({ status: 'downloading', version: value.version })
      }
    })
    // electron-updater's public macOS event means the ZIP is ready to serve to Squirrel;
    // installation is safe only after Electron's native updater confirms staging.
    addEventListener('update-downloaded', (value) => {
      if (value && !(value instanceof Error)) {
        downloadedVersion = value.version
        if (state.status !== 'ready') {
          publish({ status: 'downloading', version: value.version })
        }
      }
    })
    addEventListener('update-staged', () => {
      if (state.status === 'downloading' && downloadedVersion) {
        clearPoll()
        publish({ status: 'ready', version: downloadedVersion })
      }
    })
    addEventListener('error', (value) => {
      const error = value instanceof Error ? value : new Error('The update service failed')
      settleDownloadFailure(error)
    })
  }

  return {
    start: () => {
      if (started || disposed || !options.isPackaged) {
        return
      }
      started = true
      configureUpdater()
      void checkAutomatically()
    },
    checkManually: check,
    restartToInstall: async () => {
      if (state.status !== 'ready') {
        return
      }
      restartPromise ??= options.restartToInstall()
      await restartPromise
    },
    subscribe: (listener) => {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      clearPoll()
      eventListeners.forEach((listener, event) => options.updater.removeListener(event, listener))
      eventListeners.clear()
      listeners.clear()
    }
  }
}
