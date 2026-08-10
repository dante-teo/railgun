import type { ActivityApi } from './activity-api'
import type { AttachmentApi } from './attachment-api'
import type { ApprovalApi } from './approval-api'
import type { ContextUsageApi } from './context-usage-api'
import type { ModelApi } from './model-api'
import type { TaskApi } from './task-api'

export interface RailgunApi {
  activity: ActivityApi
  attachments: AttachmentApi
  approval: ApprovalApi
  contextUsage: ContextUsageApi
  models: ModelApi
  tasks: TaskApi
}
