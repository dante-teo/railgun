export const tasksListChannel = 'railgun:tasks:list'
export const tasksCreateChannel = 'railgun:tasks:create'
export const tasksArchiveChannel = 'railgun:tasks:archive'
export const tasksOpenChannel = 'railgun:tasks:open'

export interface TaskSummary {
  id: string
  title: string
  lastMessageAt: string
}

export interface TaskApi {
  list: () => Promise<TaskSummary[]>
  create: () => Promise<string>
  archive: (sessionId: string) => Promise<void>
  open: (sessionId: string) => Promise<void>
}
