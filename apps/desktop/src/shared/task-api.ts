export const tasksListChannel = 'railgun:tasks:list'
export const tasksArchiveChannel = 'railgun:tasks:archive'

export interface TaskSummary {
  id: string
  title: string
  lastMessageAt: string
}

export interface RailgunApi {
  tasks: {
    list: () => Promise<TaskSummary[]>
    archive: (sessionId: string) => Promise<void>
  }
}
