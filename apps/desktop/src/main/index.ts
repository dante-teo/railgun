import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import electronUpdater from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import { ActivityService } from './activity.mts'
import { startAutomaticUpdates } from './automatic-updates.mts'
import {
  attachmentDialogProperties,
  pickAttachments,
  type AttachmentDialogKind,
  type SeparateAttachmentDialogKind
} from './attachment-picker.mts'
import { getApprovalConfiguration, setApprovalMode } from './approval.mts'
import { BackendProcessManager, resolveBackendLaunch } from './backend-process.mts'
import { ContextUsageService } from './context-usage.mts'
import { handleExternalWindowOpen } from './external-links.mts'
import { getModelConfiguration, selectModel } from './models.mts'
import { TaskService } from './tasks.mts'
import { createTranscriptService } from './transcript.mts'
import { activitySnapshotChannel, activityUpdateChannel } from '../shared/activity-api'
import { attachmentsPickChannel } from '../shared/attachment-api'
import { approvalGetChannel, approvalSetModeChannel } from '../shared/approval-api'
import { contextUsageSnapshotChannel, contextUsageUpdateChannel } from '../shared/context-usage-api'
import { modelsGetChannel, modelsSelectChannel } from '../shared/model-api'
import { tasksArchiveChannel, tasksListChannel, tasksOpenChannel } from '../shared/task-api'
import {
  transcriptAbortChannel,
  transcriptApprovalResponseChannel,
  transcriptClarificationResponseChannel,
  transcriptSendChannel,
  transcriptSnapshotChannel,
  transcriptUpdateChannel
} from '../shared/transcript-api'

const backendProcess = new BackendProcessManager()
const activityService = new ActivityService(backendProcess)
const contextUsageService = new ContextUsageService(backendProcess)
const taskService = new TaskService(backendProcess)
const transcriptService = createTranscriptService(backendProcess)
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
  const launch = resolveBackendLaunch(
    process.env,
    process.platform,
    app.isPackaged ? process.resourcesPath : undefined
  )
  if (!launch) {
    return
  }

  const child = backendProcess.start(launch)
  void backendProcess
    .waitUntilReady()
    .then(() => Promise.all([activityService.hydrate(), contextUsageService.hydrate()]))
    .catch(reportBackendFailure)
  child.once('error', reportBackendFailure)
  child.once('exit', (code, signal) => {
    if (!isQuitting) {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      reportBackendFailure(new Error(`The backend stopped unexpectedly with ${reason}`))
    }
  })
}

function reportUpdateFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Update check failed: ${message}\n`)
}

async function refreshContextUsageBestEffort(): Promise<void> {
  await contextUsageService.refresh().catch(() => undefined)
}

function broadcastUpdate(channel: string, update: unknown): void {
  BrowserWindow.getAllWindows()
    .filter((window) => !window.isDestroyed())
    .forEach((window) => window.webContents.send(channel, update))
}

const separateAttachmentDialogKinds: readonly SeparateAttachmentDialogKind[] = ['files', 'folders']

async function chooseAttachmentDialogKind(
  parentWindow: BrowserWindow | null
): Promise<SeparateAttachmentDialogKind | undefined> {
  const options: Electron.MessageBoxOptions = {
    buttons: ['Choose Files', 'Choose Folders', 'Cancel'],
    cancelId: 2,
    defaultId: 0,
    detail: 'Files and folders use separate system pickers on this platform.',
    message: 'What would you like to attach?',
    noLink: true,
    title: 'Attach files or folders',
    type: 'question'
  }
  const result = parentWindow
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options)
  return separateAttachmentDialogKinds[result.response]
}

function attachmentDialogOptions(kind: AttachmentDialogKind): Electron.OpenDialogOptions {
  const subject = kind === 'files' ? 'files' : kind === 'folders' ? 'folders' : 'files or folders'
  return {
    buttonLabel: 'Attach',
    message: `Choose ${subject} to attach`,
    properties: attachmentDialogProperties(kind),
    title: `Attach ${subject}`
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(activitySnapshotChannel, () => activityService.getSnapshot())
  ipcMain.handle(contextUsageSnapshotChannel, () => contextUsageService.getSnapshot())
  ipcMain.handle(attachmentsPickChannel, (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender)
    return pickAttachments({
      chooseDialogKind: () => chooseAttachmentDialogKind(parentWindow),
      inspectDirectory: async (path) => (await stat(path)).isDirectory(),
      platform: process.platform,
      showDialog: (kind) => {
        const options = attachmentDialogOptions(kind)
        return parentWindow
          ? dialog.showOpenDialog(parentWindow, options)
          : dialog.showOpenDialog(options)
      }
    })
  })
  ipcMain.handle(approvalGetChannel, () => getApprovalConfiguration(backendProcess))
  ipcMain.handle(approvalSetModeChannel, (_event, mode: unknown) =>
    setApprovalMode(backendProcess, mode)
  )
  ipcMain.handle(modelsGetChannel, () => getModelConfiguration(backendProcess))
  ipcMain.handle(modelsSelectChannel, async (_event, modelId: unknown) => {
    const configuration = await selectModel(backendProcess, modelId)
    const loadedSessionId = transcriptService.getSnapshot().sessionId
    if (loadedSessionId && loadedSessionId !== configuration.activeSessionId) {
      await transcriptService
        .adoptActiveSession(configuration.activeSessionId)
        .catch(() => undefined)
    }
    await refreshContextUsageBestEffort()
    return configuration
  })
  ipcMain.handle(tasksListChannel, () => taskService.list())
  ipcMain.handle(tasksArchiveChannel, (_event, sessionId: unknown) =>
    taskService.archive(sessionId)
  )
  ipcMain.handle(tasksOpenChannel, async (_event, sessionId: unknown) => {
    await transcriptService.load(sessionId)
    await Promise.all([activityService.refresh(), contextUsageService.refresh()])
  })
  ipcMain.handle(transcriptSnapshotChannel, () => transcriptService.getSnapshot())
  ipcMain.handle(transcriptSendChannel, (_event, sessionId: unknown, submission: unknown) =>
    transcriptService.send(sessionId, submission)
  )
  ipcMain.handle(transcriptAbortChannel, (_event, sessionId: unknown) =>
    transcriptService.abort(sessionId)
  )
  ipcMain.handle(
    transcriptApprovalResponseChannel,
    (_event, sessionId: unknown, requestId: unknown, approved: unknown) =>
      transcriptService.respondToApproval(sessionId, requestId, approved)
  )
  ipcMain.handle(
    transcriptClarificationResponseChannel,
    (_event, sessionId: unknown, requestId: unknown, answer: unknown) =>
      transcriptService.respondToClarification(sessionId, requestId, answer)
  )
}

activityService.subscribe((update) => {
  broadcastUpdate(activityUpdateChannel, update)
})

contextUsageService.subscribe((update) => {
  broadcastUpdate(contextUsageUpdateChannel, update)
})

transcriptService.subscribe((update) => {
  broadcastUpdate(transcriptUpdateChannel, update)
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return handleExternalWindowOpen((externalUrl) => shell.openExternal(externalUrl), url)
  })

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
  electronApp.setAppUserModelId('io.anvia.railgun')
  registerIpcHandlers()

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  const { autoUpdater } = electronUpdater
  startAutomaticUpdates({
    isPackaged: app.isPackaged,
    reportError: reportUpdateFailure,
    updater: autoUpdater,
    version: app.getVersion()
  })

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
