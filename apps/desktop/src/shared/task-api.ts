export const tasksListChannel = 'railgun:tasks:list'
export const tasksArchiveChannel = 'railgun:tasks:archive'
export const tasksOpenChannel = 'railgun:tasks:open'

export interface TaskSummary {
  id: string
  title: string
  lastMessageAt: string
}

export interface TaskApi {
  list: () => Promise<TaskSummary[]>
  archive: (sessionId: string) => Promise<void>
  open: (sessionId: string) => Promise<void>
}
