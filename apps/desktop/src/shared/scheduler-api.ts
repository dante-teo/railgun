export const schedulerGetStatusChannel = 'railgun:scheduler:get-status'
export const schedulerInstallChannel = 'railgun:scheduler:install'
export const schedulerUninstallChannel = 'railgun:scheduler:uninstall'

export type SchedulerState =
  'not-installed' | 'running' | 'stopped' | 'repair-needed' | 'unavailable'

export interface SchedulerStatus {
  readonly state: SchedulerState
  readonly detail: string | null
}

export interface SchedulerApi {
  getStatus: () => Promise<SchedulerStatus>
  install: () => Promise<SchedulerStatus>
  uninstall: () => Promise<SchedulerStatus>
}
