import {
  modelsGetChannel,
  modelsSelectChannel,
  modelsSetDefaultChannel,
  type ModelApi,
  type ModelConfiguration
} from '../shared/model-api.ts'

export interface ModelIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function createModelApi(ipcRenderer: ModelIpcRenderer): ModelApi {
  return {
    get: () => ipcRenderer.invoke(modelsGetChannel) as Promise<ModelConfiguration>,
    select: (modelId: string) =>
      ipcRenderer.invoke(modelsSelectChannel, modelId) as Promise<ModelConfiguration>,
    setDefault: (modelId: string | null) =>
      ipcRenderer.invoke(modelsSetDefaultChannel, modelId) as Promise<ModelConfiguration>
  }
}
