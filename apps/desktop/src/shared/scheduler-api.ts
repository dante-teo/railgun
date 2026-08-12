export const schedulerGetStatusChannel = 'railgun:scheduler:get-status'
export const schedulerInstallChannel = 'railgun:scheduler:install'
export const schedulerUninstallChannel = 'railgun:scheduler:uninstall'
export const schedulerListJobsChannel = 'railgun:scheduler:list-jobs'
export const schedulerCreateJobChannel = 'railgun:scheduler:create-job'
export const schedulerUpdateJobChannel = 'railgun:scheduler:update-job'
export const schedulerDeleteJobChannel = 'railgun:scheduler:delete-job'

export type SchedulerState =
  'not-installed' | 'running' | 'stopped' | 'repair-needed' | 'unavailable'

export interface SchedulerStatus {
  readonly state: SchedulerState
  readonly detail: string | null
}

export type ScheduledJobLastStatus = 'completed' | 'failed'

export interface ScheduledJob {
  readonly name: string
  readonly schedule: string
  readonly prompt: string
  readonly lastRunAt: string | null
  readonly lastStatus: ScheduledJobLastStatus | null
  readonly lastError: string | null
}

export interface ScheduledJobInput {
  readonly schedule: string
  readonly prompt: string
}

export interface ScheduledJobCreateInput extends ScheduledJobInput {
  readonly name: string
}

export interface SchedulerApi {
  getStatus: () => Promise<SchedulerStatus>
  install: () => Promise<SchedulerStatus>
  uninstall: () => Promise<SchedulerStatus>
  listJobs: () => Promise<ScheduledJob[]>
  createJob: (input: ScheduledJobCreateInput) => Promise<ScheduledJob>
  updateJob: (name: string, input: ScheduledJobInput) => Promise<ScheduledJob>
  deleteJob: (name: string) => Promise<void>
}
