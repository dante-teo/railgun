export interface BeforeQuitEvent {
  readonly preventDefault: () => void
}

export interface ShutdownCoordinator {
  readonly handleBeforeQuit: (event: BeforeQuitEvent) => void
  readonly isShuttingDown: () => boolean
  readonly quitNormally: () => Promise<void>
  readonly restartToInstall: () => Promise<void>
  readonly whenSettled: () => Promise<void>
}

export interface ShutdownCoordinatorOptions {
  readonly quitAndInstall: () => void
  readonly quitApp: () => void
  readonly reportError?: (error: unknown) => void
  readonly stopBackend: () => Promise<void>
}

export function createShutdownCoordinator(
  options: ShutdownCoordinatorOptions
): ShutdownCoordinator {
  let exitStarted = false
  let intent: 'none' | 'quit' | 'install' = 'none'
  let shutdown: Promise<void> | undefined

  const begin = (): Promise<void> => {
    const stopBackend = (): Promise<void> => {
      try {
        return options.stopBackend()
      } catch (error) {
        return Promise.reject(error)
      }
    }
    shutdown ??= stopBackend()
      .catch((error: unknown) => options.reportError?.(error))
      .then(() => {
        if (exitStarted) {
          return
        }
        exitStarted = true
        if (intent === 'install') {
          options.quitAndInstall()
        } else {
          options.quitApp()
        }
      })
    return shutdown
  }

  const quitNormally = (): Promise<void> => {
    if (intent === 'none') {
      intent = 'quit'
    }
    return begin()
  }

  const restartToInstall = (): Promise<void> => {
    if (!exitStarted) {
      intent = 'install'
    }
    return begin()
  }

  return {
    handleBeforeQuit: (event) => {
      if (exitStarted) {
        return
      }
      event.preventDefault()
      void quitNormally()
    },
    isShuttingDown: () => intent !== 'none',
    quitNormally,
    restartToInstall,
    whenSettled: () => shutdown ?? Promise.resolve()
  }
}
