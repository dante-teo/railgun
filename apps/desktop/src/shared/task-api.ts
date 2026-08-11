export const tasksListChannel = 'railgun:tasks:list'
export const tasksCreateChannel = 'railgun:tasks:create'
export const tasksArchiveChannel = 'railgun:tasks:archive'
export const tasksOpenChannel = 'railgun:tasks:open'
export const tasksListArchivedChannel = 'railgun:tasks:list-archived'
export const tasksUnarchiveChannel = 'railgun:tasks:unarchive'
export const tasksDeleteArchivedChannel = 'railgun:tasks:delete-archived'
export const tasksDeleteAllArchivedChannel = 'railgun:tasks:delete-all-archived'

export interface TaskSummary {
  id: string
  title: string
  lastMessageAt: string
}

export interface ArchivedTaskSummary {
  id: string
  title: string
  model: string
  messageCount: number
  archivedAt: string
}

export interface TaskApi {
  list: () => Promise<TaskSummary[]>
  create: () => Promise<string>
  archive: (sessionId: string) => Promise<void>
  deleteAllArchived: () => Promise<number>
  deleteArchived: (sessionId: string) => Promise<void>
  open: (sessionId: string) => Promise<void>
  listArchived: () => Promise<ArchivedTaskSummary[]>
  unarchive: (sessionId: string) => Promise<void>
}
