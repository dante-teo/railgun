import {
  activitySnapshotChannel,
  activityUpdateChannel,
  type ActivityApi,
  type ActivitySnapshot,
  type ActivityUpdate
} from '../shared/activity-api.ts'

export interface ActivityIpcRenderer {
  invoke(channel: string): Promise<unknown>
  on(channel: string, listener: (event: unknown, update: ActivityUpdate) => void): unknown
  removeListener(
    channel: string,
    listener: (event: unknown, update: ActivityUpdate) => void
  ): unknown
}

export function createActivityApi(ipcRenderer: ActivityIpcRenderer): ActivityApi {
  return {
    getSnapshot: () => ipcRenderer.invoke(activitySnapshotChannel) as Promise<ActivitySnapshot>,
    subscribe: (listener) => {
      const handleUpdate = (_event: unknown, update: ActivityUpdate): void => listener(update)
      ipcRenderer.on(activityUpdateChannel, handleUpdate)
      return () => ipcRenderer.removeListener(activityUpdateChannel, handleUpdate)
    }
  }
}
