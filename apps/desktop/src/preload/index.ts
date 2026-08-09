import { contextBridge, ipcRenderer } from 'electron'

import {
  tasksArchiveChannel,
  tasksListChannel,
  type RailgunApi,
  type TaskSummary
} from '../shared/task-api'

const railgunApi: RailgunApi = {
  tasks: {
    list: (): Promise<TaskSummary[]> => ipcRenderer.invoke(tasksListChannel),
    archive: async (sessionId: string): Promise<void> => {
      await ipcRenderer.invoke(tasksArchiveChannel, sessionId)
    }
  }
}

contextBridge.exposeInMainWorld('railgun', Object.freeze(railgunApi))
