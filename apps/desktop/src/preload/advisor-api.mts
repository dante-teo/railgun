import {
  advisorGetChannel,
  advisorSetChannel,
  type AdvisorApi,
  type AdvisorConfiguration
} from '../shared/advisor-api.ts'

export interface AdvisorIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function createAdvisorApi(ipcRenderer: AdvisorIpcRenderer): AdvisorApi {
  return {
    get: () => ipcRenderer.invoke(advisorGetChannel) as Promise<AdvisorConfiguration>,
    set: (configuration) =>
      ipcRenderer.invoke(advisorSetChannel, configuration) as Promise<AdvisorConfiguration>
  }
}
