import {
  schedulerGetStatusChannel,
  schedulerInstallChannel,
  schedulerUninstallChannel,
  type SchedulerApi,
  type SchedulerStatus
} from '../shared/scheduler-api.ts'

export interface SchedulerIpcRenderer {
  invoke(channel: string): Promise<unknown>
}

export function createSchedulerApi(ipcRenderer: SchedulerIpcRenderer): SchedulerApi {
  return {
    getStatus: () => ipcRenderer.invoke(schedulerGetStatusChannel) as Promise<SchedulerStatus>,
    install: () => ipcRenderer.invoke(schedulerInstallChannel) as Promise<SchedulerStatus>,
    uninstall: () => ipcRenderer.invoke(schedulerUninstallChannel) as Promise<SchedulerStatus>
  }
}
