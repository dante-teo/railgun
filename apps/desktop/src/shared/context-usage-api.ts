export const contextUsageSnapshotChannel = 'railgun:context-usage:snapshot'
export const contextUsageUpdateChannel = 'railgun:context-usage:update'

export interface ContextUsageSnapshot {
  readonly revision: number
  readonly contextWindow: number
  readonly usedTokens: number | null
}

export interface ContextUsageUpdate {
  readonly revision: number
  readonly snapshot: ContextUsageSnapshot
}

export interface ContextUsageApi {
  getSnapshot: () => Promise<ContextUsageSnapshot>
  subscribe: (listener: (update: ContextUsageUpdate) => void) => () => void
}

export function emptyContextUsageSnapshot(): ContextUsageSnapshot {
  return {
    revision: 0,
    contextWindow: 0,
    usedTokens: null
  }
}
