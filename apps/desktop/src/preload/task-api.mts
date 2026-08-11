import {
  tasksArchiveChannel,
  tasksCreateChannel,
  tasksDeleteAllArchivedChannel,
  tasksDeleteArchivedChannel,
  tasksListArchivedChannel,
  tasksListChannel,
  tasksOpenChannel,
  tasksUnarchiveChannel,
  type ArchivedTaskSummary,
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
    deleteAllArchived: () => ipcRenderer.invoke(tasksDeleteAllArchivedChannel) as Promise<number>,
    deleteArchived: async (sessionId: string): Promise<void> => {
      await ipcRenderer.invoke(tasksDeleteArchivedChannel, sessionId)
    },
    open: async (sessionId: string): Promise<void> => {
      await ipcRenderer.invoke(tasksOpenChannel, sessionId)
    },
    listArchived: () =>
      ipcRenderer.invoke(tasksListArchivedChannel) as Promise<ArchivedTaskSummary[]>,
    unarchive: async (sessionId: string): Promise<void> => {
      await ipcRenderer.invoke(tasksUnarchiveChannel, sessionId)
    }
  }
}
