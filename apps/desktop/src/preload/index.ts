import { contextBridge, ipcRenderer } from 'electron'

import { createActivityApi } from './activity-api.mts'
import { createAdvisorApi } from './advisor-api.mts'
import { createAttachmentApi } from './attachment-api.mts'
import { createApprovalApi } from './approval-api.mts'
import { createContextUsageApi } from './context-usage-api.mts'
import { createModelApi } from './model-api.mts'
import { createPersonalizationApi } from './personalization-api.mts'
import { createSchedulerApi } from './scheduler-api.mts'
import { createSkillApi } from './skill-api.mts'
import { createTaskApi } from './task-api.mts'
import { createTranscriptApi } from './transcript-api.mts'
import type { RailgunApi } from '../shared/railgun-api'

const railgunApi: RailgunApi = {
  activity: createActivityApi(ipcRenderer),
  advisor: createAdvisorApi(ipcRenderer),
  attachments: createAttachmentApi(ipcRenderer),
  approval: createApprovalApi(ipcRenderer),
  contextUsage: createContextUsageApi(ipcRenderer),
  models: createModelApi(ipcRenderer),
  personalization: createPersonalizationApi(ipcRenderer),
  scheduler: createSchedulerApi(ipcRenderer),
  skills: createSkillApi(ipcRenderer),
  tasks: createTaskApi(ipcRenderer),
  transcript: createTranscriptApi(ipcRenderer)
}

contextBridge.exposeInMainWorld('railgun', Object.freeze(railgunApi))
