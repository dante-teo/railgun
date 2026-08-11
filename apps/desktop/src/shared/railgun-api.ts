import type { ActivityApi } from './activity-api'
import type { AdvisorApi } from './advisor-api'
import type { AttachmentApi } from './attachment-api'
import type { ApprovalApi } from './approval-api'
import type { ContextUsageApi } from './context-usage-api'
import type { ModelApi } from './model-api'
import type { PersonalizationApi } from './personalization-api'
import type { SchedulerApi } from './scheduler-api'
import type { SkillApi } from './skill-api'
import type { TaskApi } from './task-api'
import type { TranscriptApi } from './transcript-api'

export interface RailgunApi {
  activity: ActivityApi
  advisor: AdvisorApi
  attachments: AttachmentApi
  approval: ApprovalApi
  contextUsage: ContextUsageApi
  models: ModelApi
  personalization: PersonalizationApi
  scheduler: SchedulerApi
  skills: SkillApi
  tasks: TaskApi
  transcript: TranscriptApi
}
