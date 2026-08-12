import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createUpdateExperience,
  updateMenuTemplate,
  type NativeDialogAdapter
} from './application-menu.mts'
import type {
  ManualUpdateCheckOutcome,
  UpdateController,
  UpdateState
} from './automatic-updates.mts'

function applicationItems(state: UpdateState): readonly Electron.MenuItemConstructorOptions[] {
  const applicationMenu = updateMenuTemplate(
    state,
    () => undefined,
    () => undefined
  )[0]
  assert.ok(Array.isArray(applicationMenu.submenu))
  return applicationMenu.submenu
}

function updateItem(state: UpdateState): Electron.MenuItemConstructorOptions {
  const item = applicationItems(state).find(({ id }) => id === 'check-for-updates')
  assert.ok(item)
  return item
}

function stubController(initial: UpdateState): UpdateController & {
  setState: (state: UpdateState) => void
  manualOutcome: ManualUpdateCheckOutcome
  manualResult?: Promise<ManualUpdateCheckOutcome>
  manualChecks: number
  restarts: number
} {
  const listeners = new Set<(state: UpdateState) => void>()
  let state = initial
  return {
    manualOutcome: { status: 'up-to-date', version: '1.0.0' },
    manualChecks: 0,
    restarts: 0,
    start: () => undefined,
    async checkManually(): Promise<ManualUpdateCheckOutcome> {
      this.manualChecks += 1
      return this.manualResult ?? this.manualOutcome
    },
    async restartToInstall(): Promise<void> {
      this.restarts += 1
    },
    subscribe(listener): () => void {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    dispose: () => undefined,
    setState(next): void {
      state = next
      listeners.forEach((listener) => listener(state))
    }
  }
}

function dialogRecorder(
  responses: number[] = []
): NativeDialogAdapter & { readonly options: Electron.MessageBoxOptions[] } {
  const options: Electron.MessageBoxOptions[] = []
  return {
    options,
    async showMessageBox(dialogOptions): Promise<{ response: number }> {
      options.push(dialogOptions)
      return { response: responses.shift() ?? 0 }
    }
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

test('the macOS menu preserves native roles and reflects update state', (): void => {
  const roles = applicationItems({ status: 'idle' }).map(({ role }) => role)
  assert.ok(roles.includes('about'))
  assert.ok(roles.includes('services'))
  assert.ok(roles.includes('hide'))
  assert.ok(roles.includes('quit'))

  assert.deepEqual(
    [
      { status: 'disabled' },
      { status: 'idle' },
      { status: 'checking' },
      { status: 'downloading', version: '2.0.0' },
      { status: 'ready', version: '2.0.0' }
    ].map((state) => {
      const item = updateItem(state as UpdateState)
      return [item.label, item.enabled]
    }),
    [
      ['Check for Updates…', false],
      ['Check for Updates…', true],
      ['Checking for Updates…', false],
      ['Downloading Update…', false],
      ['Restart to Update…', true]
    ]
  )

  const topLevelRoles = updateMenuTemplate(
    { status: 'idle' },
    () => undefined,
    () => undefined
  ).flatMap(({ submenu }) => (Array.isArray(submenu) ? submenu.map(({ role }) => role) : []))
  ;[
    'close',
    'undo',
    'redo',
    'cut',
    'copy',
    'paste',
    'selectAll',
    'togglefullscreen',
    'minimize'
  ].forEach((role) => assert.ok(topLevelRoles.some((candidate) => candidate === role)))
})

test('manual outcomes receive friendly native feedback with relevant versions', async (): Promise<void> => {
  const controller = stubController({ status: 'idle' })
  const dialogs = dialogRecorder()
  const installedMenus: unknown[] = []
  const experience = createUpdateExperience({
    currentVersion: '1.0.0',
    dialogs,
    isTaskRunning: () => false,
    menu: {
      install: (template) => installedMenus.push(template)
    },
    subscribeTaskState: () => () => undefined,
    updater: controller
  })

  for (const outcome of [
    { status: 'up-to-date', version: '1.0.0' },
    { status: 'downloading', version: '2.0.0' },
    { status: 'failed', error: new Error('socket secret') }
  ] satisfies ManualUpdateCheckOutcome[]) {
    controller.manualOutcome = outcome
    await experience.checkManually()
  }

  assert.ok(installedMenus.length >= 1)
  assert.deepEqual(
    dialogs.options.map(({ message, detail }) => [message, detail]),
    [
      ['Railgun is up to date', 'Version 1.0.0 is the newest version available.'],
      ['Railgun 2.0.0 is downloading', 'You can keep working while the update downloads.'],
      [
        'Railgun could not check for updates',
        'Check your internet connection and try again. You are currently using version 1.0.0.'
      ]
    ]
  )
})

test('manual dialogs are deduplicated and finish before a fast ready prompt', async (): Promise<void> => {
  const controller = stubController({ status: 'idle' })
  const check = Promise.withResolvers<ManualUpdateCheckOutcome>()
  controller.manualResult = check.promise
  const dialogs = dialogRecorder([0, 1])
  const experience = createUpdateExperience({
    currentVersion: '1.0.0',
    dialogs,
    isTaskRunning: () => false,
    menu: { install: () => undefined },
    subscribeTaskState: () => () => undefined,
    updater: controller
  })

  const first = experience.checkManually()
  const second = experience.checkManually()
  controller.setState({ status: 'ready', version: '2.0.0' })
  check.resolve({ status: 'downloading', version: '2.0.0' })
  await Promise.all([first, second])
  await flush()

  assert.equal(controller.manualChecks, 1)
  assert.deepEqual(
    dialogs.options.map(({ message }) => message),
    ['Railgun 2.0.0 is downloading', 'Railgun 2.0.0 is ready to install']
  )
})

test('download prompts wait for an idle transcript and Later suppresses repeats for that version', async (): Promise<void> => {
  const controller = stubController({ status: 'idle' })
  const dialogs = dialogRecorder([1])
  let running = true
  const taskListeners = new Set<() => void>()
  createUpdateExperience({
    currentVersion: '1.0.0',
    dialogs,
    isTaskRunning: () => running,
    menu: { install: () => undefined },
    subscribeTaskState: (listener) => {
      taskListeners.add(listener)
      return () => taskListeners.delete(listener)
    },
    updater: controller
  })

  controller.setState({ status: 'ready', version: '2.0.0' })
  await flush()
  assert.equal(dialogs.options.length, 0)

  running = false
  taskListeners.forEach((listener) => listener())
  await flush()
  assert.equal(dialogs.options.length, 1)

  controller.setState({ status: 'ready', version: '2.0.0' })
  await flush()
  assert.equal(dialogs.options.length, 1)
  assert.equal(controller.restarts, 0)
  assert.equal(updateItem({ status: 'ready', version: '2.0.0' }).enabled, true)
})

test('Restart Now rechecks task state and requeues instead of interrupting new work', async (): Promise<void> => {
  const controller = stubController({ status: 'idle' })
  let resolveDialog!: (response: { response: number }) => void
  const dialogs: NativeDialogAdapter = {
    showMessageBox: () =>
      new Promise((resolve) => {
        resolveDialog = resolve
      })
  }
  let running = false
  const taskListeners = new Set<() => void>()
  createUpdateExperience({
    currentVersion: '1.0.0',
    dialogs,
    isTaskRunning: () => running,
    menu: { install: () => undefined },
    subscribeTaskState: (listener) => {
      taskListeners.add(listener)
      return () => taskListeners.delete(listener)
    },
    updater: controller
  })

  controller.setState({ status: 'ready', version: '2.0.0' })
  await flush()
  running = true
  resolveDialog({ response: 0 })
  await flush()
  assert.equal(controller.restarts, 0)

  running = false
  taskListeners.forEach((listener) => listener())
  await flush()
  resolveDialog({ response: 0 })
  await flush()
  assert.equal(controller.restarts, 1)
})

test('Restart to Update from the menu also respects a running task', async (): Promise<void> => {
  const controller = stubController({ status: 'ready', version: '2.0.0' })
  let running = true
  let latestMenu: readonly Electron.MenuItemConstructorOptions[] = []
  const taskListeners = new Set<() => void>()
  const experience = createUpdateExperience({
    currentVersion: '1.0.0',
    dialogs: dialogRecorder([0]),
    isTaskRunning: () => running,
    menu: { install: (template) => (latestMenu = template) },
    subscribeTaskState: (listener) => {
      taskListeners.add(listener)
      return () => taskListeners.delete(listener)
    },
    updater: controller
  })
  experience.dismissPromptForVersion('2.0.0')

  const application = latestMenu[0]
  assert.ok(Array.isArray(application.submenu))
  const item = application.submenu.find(({ id }) => id === 'check-for-updates')
  assert.equal(typeof item?.click, 'function')
  item?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent)
  await flush()
  assert.equal(controller.restarts, 0)

  running = false
  taskListeners.forEach((listener) => listener())
  await flush()
  assert.equal(controller.restarts, 1)
})
