import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { ActivityService } from './activity.mts'
import { BackendProcessManager, resolveBackendLaunch } from './backend-process.mts'
import { TaskService } from './tasks.mts'
import { activitySnapshotChannel, activityUpdateChannel } from '../shared/activity-api'
import { tasksArchiveChannel, tasksListChannel, tasksOpenChannel } from '../shared/task-api'

const backendProcess = new BackendProcessManager()
const activityService = new ActivityService(backendProcess)
const taskService = new TaskService(backendProcess)
let isQuitting = false
let backendFailureReported = false

function reportBackendFailure(error: unknown): void {
  if (isQuitting || backendFailureReported) {
    return
  }

  backendFailureReported = true
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Backend failure: ${message}\n`)
  dialog.showErrorBox('Railgun backend failed', message)
  app.quit()
}

function startConfiguredBackend(): void {
  const launch = resolveBackendLaunch()
  if (!launch) {
    return
  }

  const child = backendProcess.start(launch)
  void backendProcess
    .waitUntilReady()
    .then(() => activityService.hydrate())
    .catch(reportBackendFailure)
  child.once('error', reportBackendFailure)
  child.once('exit', (code, signal) => {
    if (!isQuitting) {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      reportBackendFailure(new Error(`The backend stopped unexpectedly with ${reason}`))
    }
  })
}

function registerIpcHandlers(): void {
  ipcMain.handle(activitySnapshotChannel, () => activityService.getSnapshot())
  ipcMain.handle(tasksListChannel, () => taskService.list())
  ipcMain.handle(tasksArchiveChannel, (_event, sessionId: unknown) =>
    taskService.archive(sessionId)
  )
  ipcMain.handle(tasksOpenChannel, async (_event, sessionId: unknown) => {
    await taskService.open(sessionId)
    await activityService.refresh()
  })
}

activityService.subscribe((update) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(activityUpdateChannel, update)
    }
  }
})

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    titleBarStyle: 'hidden',
    trafficLightPosition: {
      x: 16,
      y: 18
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Use electron-vite's renderer server in development and the bundled HTML in production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  app.dock?.setIcon(icon)

  try {
    startConfiguredBackend()
  } catch (error) {
    reportBackendFailure(error)
    return
  }

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.railgun.desktop')
  registerIpcHandlers()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  if (isQuitting || !backendProcess.isRunning) {
    isQuitting = true
    return
  }

  event.preventDefault()
  isQuitting = true
  void backendProcess.stop().finally(() => app.quit())
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
