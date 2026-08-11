import {
  tasksArchiveChannel,
  tasksCreateChannel,
  tasksListChannel,
  tasksOpenChannel,
  type TaskApi,
  type TaskSummary
} from '../shared/task-api.ts'

export interface TaskIpcRenderer {
  invoke(channel: string, ...arguments_: unknown[]): Promise<unknown>
}

export function createTaskApi(ipcRenderer: TaskIpcRenderer): TaskApi {
  return {
    list: () => ipcRenderer.invoke(tasksListChannel) as Promise<TaskSummary[]>,
    create: () => ipcRenderer.invoke(tasksCreateChannel) as Promise<string>,
    archive: async (sessionId: string): Promise<void> => {
      await ipcRenderer.invoke(tasksArchiveChannel, sessionId)
    },
    open: async (sessionId: string): Promise<void> => {
      await ipcRenderer.invoke(tasksOpenChannel, sessionId)
    }
  }
}
