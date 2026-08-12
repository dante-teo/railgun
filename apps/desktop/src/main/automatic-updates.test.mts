import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAutomaticUpdateController,
  updateCheckIntervalMilliseconds,
  type AutomaticUpdater,
  type UpdateCheckResult,
  type UpdateInfo,
  type UpdateState
} from './automatic-updates.mts'

type UpdaterEvent =
  | 'checking-for-update'
  | 'update-available'
  | 'update-not-available'
  | 'update-downloaded'
  | 'update-staged'
  | 'error'

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
  readonly reject: (error: unknown) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value) => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function updateInfo(version: string): UpdateInfo {
  return { version }
}

function available(
  version: string,
  downloadPromise?: Promise<readonly string[]>
): UpdateCheckResult {
  const info = updateInfo(version)
  return {
    isUpdateAvailable: true,
    updateInfo: info,
    versionInfo: info,
    ...(downloadPromise ? { downloadPromise } : {})
  }
}

function current(version: string): UpdateCheckResult {
  const info = updateInfo(version)
  return { isUpdateAvailable: false, updateInfo: info, versionInfo: info }
}

function stubUpdater(
  check: () => Promise<UpdateCheckResult | null> = async () => current('1.0.0')
): AutomaticUpdater & {
  readonly checks: UpdateCheckResult[]
  quitCalls: number
  emit: (event: UpdaterEvent, value?: UpdateInfo | Error) => void
} {
  const listeners = new Map<UpdaterEvent, Set<(value?: UpdateInfo | Error) => void>>()
  return {
    allowPrerelease: true,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checks: [],
    quitCalls: 0,
    checkForUpdates: check,
    on(event, listener): void {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    },
    removeListener(event, listener): void {
      listeners.get(event)?.delete(listener)
    },
    quitAndInstall(): void {
      this.quitCalls += 1
    },
    emit(event, value): void {
      listeners.get(event)?.forEach((listener) => listener(value))
    }
  }
}

function fakeScheduler(): {
  readonly scheduler: {
    setTimeout: (callback: () => void, delay: number) => number
    clearTimeout: (handle: unknown) => void
  }
  readonly delays: number[]
  pendingCount: () => number
  runNext: () => void
} {
  const timers = new Map<number, () => void>()
  const delays: number[] = []
  let sequence = 0
  return {
    scheduler: {
      setTimeout(callback, delay): number {
        sequence += 1
        timers.set(sequence, callback)
        delays.push(delay)
        return sequence
      },
      clearTimeout(handle): void {
        timers.delete(handle as number)
      }
    },
    delays,
    pendingCount: () => timers.size,
    runNext(): void {
      const entry = timers.entries().next().value as [number, () => void] | undefined
      assert.ok(entry, 'expected a scheduled update check')
      timers.delete(entry[0])
      entry[1]()
    }
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

test('updates stay disabled outside packaged builds', async (): Promise<void> => {
  let checks = 0
  const updater = stubUpdater(async () => {
    checks += 1
    return current('1.0.0')
  })
  const states: UpdateState[] = []
  const controller = createAutomaticUpdateController({
    isPackaged: false,
    reportError: () => assert.fail('development update errors must not be registered'),
    restartToInstall: async () => undefined,
    updater,
    version: '1.0.0'
  })

  controller.subscribe((state) => states.push(state))
  controller.start()

  assert.deepEqual(states, [{ status: 'disabled' }])
  assert.equal(checks, 0)
  assert.deepEqual(await controller.checkManually(), { status: 'unavailable' })
  assert.equal(updater.autoDownload, false)
})

test('stable packaged builds check on startup and again four hours after settling', async (): Promise<void> => {
  let checks = 0
  const updater = stubUpdater(async () => {
    checks += 1
    return current('1.0.0')
  })
  const clock = fakeScheduler()
  const controller = createAutomaticUpdateController({
    isPackaged: true,
    reportError: () => undefined,
    restartToInstall: async () => undefined,
    scheduler: clock.scheduler,
    updater,
    version: '1.0.0'
  })

  controller.start()
  await flush()

  assert.equal(checks, 1)
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, true)
  assert.equal(updater.allowPrerelease, false)
  assert.deepEqual(clock.delays, [updateCheckIntervalMilliseconds])

  clock.runNext()
  await flush()
  assert.equal(checks, 2)
  controller.dispose()
  assert.equal(clock.pendingCount(), 0)
})

test('manual checks reset polling and reuse an in-flight startup check', async (): Promise<void> => {
  const pending = deferred<UpdateCheckResult | null>()
  let checks = 0
  const updater = stubUpdater(async () => {
    checks += 1
    return pending.promise
  })
  const clock = fakeScheduler()
  const controller = createAutomaticUpdateController({
    isPackaged: true,
    reportError: () => undefined,
    restartToInstall: async () => undefined,
    scheduler: clock.scheduler,
    updater,
    version: '1.0.0'
  })

  controller.start()
  const firstManual = controller.checkManually()
  const secondManual = controller.checkManually()
  assert.equal(checks, 1)

  pending.resolve(current('1.0.0'))
  assert.deepEqual(await firstManual, { status: 'up-to-date', version: '1.0.0' })
  assert.deepEqual(await secondManual, { status: 'up-to-date', version: '1.0.0' })
  assert.equal(checks, 1)
  assert.equal(clock.delays.at(-1), updateCheckIntervalMilliseconds)
  assert.equal(clock.pendingCount(), 1)
})

test('prerelease builds follow prerelease updates and automatically download them', async (): Promise<void> => {
  const download = deferred<readonly string[]>()
  const updater = stubUpdater(async () => available('1.1.0-rc.1', download.promise))
  const states: UpdateState[] = []
  const controller = createAutomaticUpdateController({
    isPackaged: true,
    reportError: () => undefined,
    restartToInstall: async () => undefined,
    updater,
    version: '1.0.0-rc.1'
  })
  controller.subscribe((state) => states.push(state))

  controller.start()
  await flush()

  assert.equal(updater.allowPrerelease, true)
  assert.deepEqual(states.slice(0, 3), [
    { status: 'idle' },
    { status: 'checking' },
    { status: 'downloading', version: '1.1.0-rc.1' }
  ])

  updater.emit('update-downloaded', updateInfo('1.1.0-rc.1'))
  assert.deepEqual(states.at(-1), { status: 'downloading', version: '1.1.0-rc.1' })
  updater.emit('update-staged')
  assert.deepEqual(states.at(-1), { status: 'ready', version: '1.1.0-rc.1' })
  download.resolve(['/tmp/update.zip'])
})

test('automatic failures are reported while manual failures are returned to native UI', async (): Promise<void> => {
  const automaticFailure = new Error('automatic service unavailable')
  const manualFailure = new Error('manual service unavailable')
  const failures = [automaticFailure, manualFailure]
  const reported: unknown[] = []
  const updater = stubUpdater(async () => Promise.reject(failures.shift()))
  const controller = createAutomaticUpdateController({
    isPackaged: true,
    reportError: (error) => reported.push(error),
    restartToInstall: async () => undefined,
    updater,
    version: '1.0.0'
  })

  controller.start()
  await flush()
  const outcome = await controller.checkManually()

  assert.deepEqual(reported, [automaticFailure])
  assert.deepEqual(outcome, { status: 'failed', error: manualFailure })
})

test('checks remain suspended while an update is downloading or ready', async (): Promise<void> => {
  let checks = 0
  const updater = stubUpdater(async () => {
    checks += 1
    return available('2.0.0')
  })
  const clock = fakeScheduler()
  const controller = createAutomaticUpdateController({
    isPackaged: true,
    reportError: () => undefined,
    restartToInstall: async () => undefined,
    scheduler: clock.scheduler,
    updater,
    version: '1.0.0'
  })

  controller.start()
  await flush()
  assert.equal(checks, 1)
  assert.deepEqual(await controller.checkManually(), { status: 'unavailable' })
  assert.deepEqual(clock.delays, [])

  updater.emit('update-downloaded', updateInfo('2.0.0'))
  assert.deepEqual(await controller.checkManually(), { status: 'unavailable' })
  assert.equal(checks, 1)
})

test('a rejected automatic download returns to idle polling and logs the failure', async (): Promise<void> => {
  const download = deferred<readonly string[]>()
  const failure = new Error('download failed')
  const reported: unknown[] = []
  const states: UpdateState[] = []
  const clock = fakeScheduler()
  const controller = createAutomaticUpdateController({
    isPackaged: true,
    reportError: (error) => reported.push(error),
    restartToInstall: async () => undefined,
    scheduler: clock.scheduler,
    updater: stubUpdater(async () => available('2.0.0', download.promise)),
    version: '1.0.0'
  })
  controller.subscribe((state) => states.push(state))

  controller.start()
  await flush()
  download.reject(failure)
  await flush()

  assert.deepEqual(reported, [failure])
  assert.deepEqual(states.at(-1), { status: 'idle' })
  assert.equal(clock.pendingCount(), 1)
})

test('a native staging error invalidates ready state before restart and resumes polling', async (): Promise<void> => {
  const failure = new Error('native staging validation failed')
  const reported: unknown[] = []
  const states: UpdateState[] = []
  const clock = fakeScheduler()
  let restarts = 0
  const updater = stubUpdater(async () => available('2.0.0'))
  const controller = createAutomaticUpdateController({
    isPackaged: true,
    reportError: (error) => reported.push(error),
    restartToInstall: async () => {
      restarts += 1
    },
    scheduler: clock.scheduler,
    updater,
    version: '1.0.0'
  })
  controller.subscribe((state) => states.push(state))

  controller.start()
  await flush()
  updater.emit('update-downloaded', updateInfo('2.0.0'))
  await controller.restartToInstall()
  assert.equal(restarts, 0, 'the public download event is not yet safe to install on macOS')
  updater.emit('update-staged')
  assert.deepEqual(states.at(-1), { status: 'ready', version: '2.0.0' })

  updater.emit('error', failure)
  await controller.restartToInstall()

  assert.deepEqual(states.at(-1), { status: 'idle' })
  assert.deepEqual(reported, [failure])
  assert.equal(clock.pendingCount(), 1)
  assert.equal(restarts, 0)
})

test('restart delegates once only when an update is ready and disposal removes timers', async (): Promise<void> => {
  const updater = stubUpdater(async () => available('2.0.0'))
  const clock = fakeScheduler()
  let restarts = 0
  const controller = createAutomaticUpdateController({
    isPackaged: true,
    reportError: () => undefined,
    restartToInstall: async () => {
      restarts += 1
      updater.quitAndInstall()
    },
    scheduler: clock.scheduler,
    updater,
    version: '1.0.0'
  })

  await controller.restartToInstall()
  controller.start()
  await flush()
  updater.emit('update-downloaded', updateInfo('2.0.0'))
  updater.emit('update-staged')
  await Promise.all([controller.restartToInstall(), controller.restartToInstall()])
  controller.dispose()

  assert.equal(restarts, 1)
  assert.equal(updater.quitCalls, 1)
})
