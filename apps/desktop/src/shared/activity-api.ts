export const activitySnapshotChannel = 'railgun:activity:snapshot'
export const activityUpdateChannel = 'railgun:activity:update'

export type AdvisorSeverity = 'nit' | 'concern' | 'blocker'
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type SubagentStatus = 'running' | 'completed' | 'interrupted'
export type ActivityMessageRole = 'user' | 'assistant'

export interface AdvisorActivity {
  readonly severity: AdvisorSeverity
  readonly text: string
}

export interface TodoActivity {
  readonly id: string
  readonly content: string
  readonly status: TodoStatus
}

export interface SubagentMessage {
  readonly role: ActivityMessageRole
  readonly content: string
}

export interface SubagentActivity {
  readonly index: number
  readonly goal: string
  readonly status: SubagentStatus
  readonly messages: readonly SubagentMessage[]
}

export interface ActivitySnapshot {
  readonly revision: number
  readonly running: boolean
  readonly advisor: AdvisorActivity | null
  readonly subagentCount: number
  readonly subagents: readonly SubagentActivity[]
  readonly todos: readonly TodoActivity[]
}

export interface ActivityUpdate {
  readonly revision: number
  readonly snapshot: ActivitySnapshot
}

export interface ActivityApi {
  getSnapshot: () => Promise<ActivitySnapshot>
  subscribe: (listener: (update: ActivityUpdate) => void) => () => void
}

export function emptyActivitySnapshot(): ActivitySnapshot {
  return {
    revision: 0,
    running: false,
    advisor: null,
    subagentCount: 0,
    subagents: [],
    todos: []
  }
}
