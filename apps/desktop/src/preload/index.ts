import { contextBridge, ipcRenderer } from 'electron'

import { createActivityApi } from './activity-api.mts'
import { createAttachmentApi } from './attachment-api.mts'
import { createApprovalApi } from './approval-api.mts'
import { createContextUsageApi } from './context-usage-api.mts'
import { createModelApi } from './model-api.mts'
import {
  tasksArchiveChannel,
  tasksListChannel,
  tasksOpenChannel,
  type TaskSummary
} from '../shared/task-api'
import type { RailgunApi } from '../shared/railgun-api'

const railgunApi: RailgunApi = {
  activity: createActivityApi(ipcRenderer),
  attachments: createAttachmentApi(ipcRenderer),
  approval: createApprovalApi(ipcRenderer),
  contextUsage: createContextUsageApi(ipcRenderer),
  models: createModelApi(ipcRenderer),
  tasks: {
    list: (): Promise<TaskSummary[]> => ipcRenderer.invoke(tasksListChannel),
    archive: async (sessionId: string): Promise<void> => {
      await ipcRenderer.invoke(tasksArchiveChannel, sessionId)
    },
    open: async (sessionId: string): Promise<void> => {
      await ipcRenderer.invoke(tasksOpenChannel, sessionId)
    }
  }
}

contextBridge.exposeInMainWorld('railgun', Object.freeze(railgunApi))
