import {
  contextUsageSnapshotChannel,
  contextUsageUpdateChannel,
  type ContextUsageApi,
  type ContextUsageSnapshot,
  type ContextUsageUpdate
} from '../shared/context-usage-api.ts'

export interface ContextUsageIpcRenderer {
  invoke(channel: string): Promise<unknown>
  on(channel: string, listener: (event: unknown, update: ContextUsageUpdate) => void): unknown
  removeListener(
    channel: string,
    listener: (event: unknown, update: ContextUsageUpdate) => void
  ): unknown
}

export function createContextUsageApi(ipcRenderer: ContextUsageIpcRenderer): ContextUsageApi {
  return {
    getSnapshot: () =>
      ipcRenderer.invoke(contextUsageSnapshotChannel) as Promise<ContextUsageSnapshot>,
    subscribe: (listener) => {
      const handleUpdate = (_event: unknown, update: ContextUsageUpdate): void => listener(update)
      ipcRenderer.on(contextUsageUpdateChannel, handleUpdate)
      return () => ipcRenderer.removeListener(contextUsageUpdateChannel, handleUpdate)
    }
  }
}
