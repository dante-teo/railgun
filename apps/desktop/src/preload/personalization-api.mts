import {
  memoriesCreateChannel,
  memoriesDeleteChannel,
  memoriesListChannel,
  memoriesUpdateChannel,
  soulGetChannel,
  soulSetChannel,
  type MemoryRecord,
  type PersonalizationApi
} from '../shared/personalization-api.ts'

export interface PersonalizationIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function createPersonalizationApi(
  ipcRenderer: PersonalizationIpcRenderer
): PersonalizationApi {
  return {
    soul: {
      get: () => ipcRenderer.invoke(soulGetChannel) as Promise<string>,
      set: (content) => ipcRenderer.invoke(soulSetChannel, content) as Promise<string>
    },
    memories: {
      list: (query) =>
        ipcRenderer.invoke(memoriesListChannel, query) as Promise<readonly MemoryRecord[]>,
      create: (input) => ipcRenderer.invoke(memoriesCreateChannel, input) as Promise<MemoryRecord>,
      update: (memoryId, input) =>
        ipcRenderer.invoke(memoriesUpdateChannel, memoryId, input) as Promise<MemoryRecord>,
      delete: async (memoryId) => {
        await ipcRenderer.invoke(memoriesDeleteChannel, memoryId)
      }
    }
  }
}
