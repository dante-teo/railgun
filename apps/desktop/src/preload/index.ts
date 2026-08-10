import { contextBridge, ipcRenderer } from 'electron'

import { createActivityApi } from './activity-api.mts'
import {
  tasksArchiveChannel,
  tasksListChannel,
  tasksOpenChannel,
  type TaskSummary
} from '../shared/task-api'
import type { RailgunApi } from '../shared/railgun-api'

const railgunApi: RailgunApi = {
  activity: createActivityApi(ipcRenderer),
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
