import {
  schedulerCreateJobChannel,
  schedulerDeleteJobChannel,
  schedulerGetStatusChannel,
  schedulerInstallChannel,
  schedulerListJobsChannel,
  schedulerUninstallChannel,
  schedulerUpdateJobChannel,
  type SchedulerApi,
  type ScheduledJob,
  type ScheduledJobCreateInput,
  type ScheduledJobInput,
  type SchedulerStatus
} from '../shared/scheduler-api.ts'

export interface SchedulerIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function createSchedulerApi(ipcRenderer: SchedulerIpcRenderer): SchedulerApi {
  return {
    getStatus: () => ipcRenderer.invoke(schedulerGetStatusChannel) as Promise<SchedulerStatus>,
    install: () => ipcRenderer.invoke(schedulerInstallChannel) as Promise<SchedulerStatus>,
    uninstall: () => ipcRenderer.invoke(schedulerUninstallChannel) as Promise<SchedulerStatus>,
    listJobs: () => ipcRenderer.invoke(schedulerListJobsChannel) as Promise<ScheduledJob[]>,
    createJob: (input: ScheduledJobCreateInput) =>
      ipcRenderer.invoke(schedulerCreateJobChannel, input) as Promise<ScheduledJob>,
    updateJob: (name: string, input: ScheduledJobInput) =>
      ipcRenderer.invoke(schedulerUpdateJobChannel, name, input) as Promise<ScheduledJob>,
    deleteJob: (name: string) =>
      ipcRenderer.invoke(schedulerDeleteJobChannel, name) as Promise<void>
  }
}
