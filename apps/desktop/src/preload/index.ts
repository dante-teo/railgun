import { contextBridge, ipcRenderer } from 'electron'

import { createActivityApi } from './activity-api.mts'
import { createAttachmentApi } from './attachment-api.mts'
import { createApprovalApi } from './approval-api.mts'
import { createContextUsageApi } from './context-usage-api.mts'
import { createModelApi } from './model-api.mts'
import { createTaskApi } from './task-api.mts'
import { createTranscriptApi } from './transcript-api.mts'
import type { RailgunApi } from '../shared/railgun-api'

const railgunApi: RailgunApi = {
  activity: createActivityApi(ipcRenderer),
  attachments: createAttachmentApi(ipcRenderer),
  approval: createApprovalApi(ipcRenderer),
  contextUsage: createContextUsageApi(ipcRenderer),
  models: createModelApi(ipcRenderer),
  tasks: createTaskApi(ipcRenderer),
  transcript: createTranscriptApi(ipcRenderer)
}

contextBridge.exposeInMainWorld('railgun', Object.freeze(railgunApi))
