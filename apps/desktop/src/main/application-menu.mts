import type {
  ManualUpdateCheckOutcome,
  UpdateController,
  UpdateState
} from './automatic-updates.mts'

export interface NativeDialogAdapter {
  readonly showMessageBox: (
    options: Electron.MessageBoxOptions
  ) => Promise<{ readonly response: number }>
}

export interface ApplicationMenuAdapter {
  readonly install: (template: readonly Electron.MenuItemConstructorOptions[]) => void
}

export interface UpdateExperienceOptions {
  readonly currentVersion: string
  readonly dialogs: NativeDialogAdapter
  readonly isTaskRunning: () => boolean
  readonly menu: ApplicationMenuAdapter
  readonly subscribeTaskState: (listener: () => void) => () => void
  readonly updater: UpdateController
}

export interface UpdateExperience {
  readonly checkManually: () => Promise<void>
  readonly dismissPromptForVersion: (version: string) => void
  readonly dispose: () => void
}

function updateMenuItem(
  state: UpdateState,
  onCheck: () => void,
  onRestart: () => void
): Electron.MenuItemConstructorOptions {
  switch (state.status) {
    case 'disabled':
      return { id: 'check-for-updates', label: 'Check for Updates…', enabled: false }
    case 'idle':
      return { id: 'check-for-updates', label: 'Check for Updates…', enabled: true, click: onCheck }
    case 'checking':
      return { id: 'check-for-updates', label: 'Checking for Updates…', enabled: false }
    case 'downloading':
      return { id: 'check-for-updates', label: 'Downloading Update…', enabled: false }
    case 'ready':
      return {
        id: 'check-for-updates',
        label: 'Restart to Update…',
        enabled: true,
        click: onRestart
      }
  }
}

export function updateMenuTemplate(
  state: UpdateState,
  onCheck: () => void,
  onRestart: () => void
): readonly Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: 'Railgun',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        updateMenuItem(state, onCheck, onRestart),
        { type: 'separator' },
        { role: 'services', submenu: [] },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [{ role: 'close' }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ]
}

function manualOutcomeDialog(
  outcome: ManualUpdateCheckOutcome,
  currentVersion: string
): Electron.MessageBoxOptions | undefined {
  switch (outcome.status) {
    case 'unavailable':
      return undefined
    case 'up-to-date':
      return {
        buttons: ['OK'],
        defaultId: 0,
        detail: `Version ${outcome.version} is the newest version available.`,
        message: 'Railgun is up to date',
        noLink: true,
        title: 'Software Update',
        type: 'info'
      }
    case 'downloading':
      return {
        buttons: ['OK'],
        defaultId: 0,
        detail: 'You can keep working while the update downloads.',
        message: `Railgun ${outcome.version} is downloading`,
        noLink: true,
        title: 'Software Update',
        type: 'info'
      }
    case 'failed':
      return {
        buttons: ['OK'],
        defaultId: 0,
        detail: `Check your internet connection and try again. You are currently using version ${currentVersion}.`,
        message: 'Railgun could not check for updates',
        noLink: true,
        title: 'Software Update',
        type: 'warning'
      }
  }
}

function readyDialog(version: string): Electron.MessageBoxOptions {
  return {
    buttons: ['Restart Now', 'Later'],
    cancelId: 1,
    defaultId: 0,
    detail: 'Restart Railgun to finish installing the update.',
    message: `Railgun ${version} is ready to install`,
    noLink: true,
    title: 'Software Update',
    type: 'info'
  }
}

export function createUpdateExperience(options: UpdateExperienceOptions): UpdateExperience {
  const dismissedVersions = new Set<string>()
  const scheduledPrompts = new Set<string>()
  let currentState: UpdateState = { status: 'disabled' }
  let dialogs = Promise.resolve<unknown>(undefined)
  let disposed = false
  let manualCheck: Promise<void> | undefined
  let manualCheckActive = false
  let pendingPromptVersion: string | undefined
  let restartWhenIdle = false

  const enqueueDialog = <Value,>(show: () => Promise<Value>): Promise<Value> => {
    const result = dialogs.then(show)
    dialogs = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const restartFromMenu = (): void => {
    if (currentState.status !== 'ready') {
      return
    }
    if (options.isTaskRunning()) {
      restartWhenIdle = true
      return
    }
    void options.updater.restartToInstall()
  }

  const installMenu = (): void => {
    options.menu.install(
      updateMenuTemplate(currentState, () => void checkManually(), restartFromMenu)
    )
  }

  const maybePrompt = (): void => {
    const version = pendingPromptVersion
    if (
      disposed ||
      !version ||
      manualCheckActive ||
      options.isTaskRunning() ||
      dismissedVersions.has(version) ||
      scheduledPrompts.has(version)
    ) {
      return
    }

    scheduledPrompts.add(version)
    void enqueueDialog(async () => {
      try {
        if (
          disposed ||
          currentState.status !== 'ready' ||
          currentState.version !== version ||
          dismissedVersions.has(version) ||
          options.isTaskRunning()
        ) {
          return
        }
        const { response } = await options.dialogs.showMessageBox(readyDialog(version))
        if (response !== 0) {
          dismissedVersions.add(version)
          pendingPromptVersion = undefined
          return
        }
        if (options.isTaskRunning()) {
          pendingPromptVersion = version
          return
        }
        pendingPromptVersion = undefined
        await options.updater.restartToInstall()
      } finally {
        scheduledPrompts.delete(version)
      }
    })
  }

  const checkManually = (): Promise<void> => {
    if (manualCheck) {
      return manualCheck
    }
    manualCheckActive = true
    const pending = (async () => {
      const outcome = await options.updater.checkManually()
      const dialog = manualOutcomeDialog(outcome, options.currentVersion)
      if (dialog) {
        await enqueueDialog(() => options.dialogs.showMessageBox(dialog))
      }
    })().finally(() => {
      manualCheckActive = false
      if (manualCheck === pending) {
        manualCheck = undefined
      }
      maybePrompt()
    })
    manualCheck = pending
    return pending
  }

  const unsubscribeUpdater = options.updater.subscribe((state) => {
    currentState = state
    if (state.status === 'ready') {
      pendingPromptVersion = state.version
    } else {
      pendingPromptVersion = undefined
      restartWhenIdle = false
    }
    installMenu()
    maybePrompt()
  })

  const unsubscribeTaskState = options.subscribeTaskState(() => {
    if (options.isTaskRunning() || currentState.status !== 'ready') {
      return
    }
    if (restartWhenIdle) {
      restartWhenIdle = false
      void options.updater.restartToInstall()
      return
    }
    maybePrompt()
  })

  return {
    checkManually,
    dismissPromptForVersion: (version) => {
      dismissedVersions.add(version)
      if (pendingPromptVersion === version) {
        pendingPromptVersion = undefined
      }
    },
    dispose: () => {
      disposed = true
      unsubscribeTaskState()
      unsubscribeUpdater()
    }
  }
}
